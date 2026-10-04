/**
 * unopenrouter-runner: runs the Claude and Codex CLIs under your own logins, on a machine of your own, for
 * unopenrouter. It keeps one outbound WebSocket to the server and only ever takes model requests over it: your
 * logins never leave this machine, and the calls come from its IP.
 *
 *   unopenrouter-runner pair <code> [--name N] [--server URL]
 *   unopenrouter-runner login claude [--name N]     paste a token from `claude setup-token`
 *   unopenrouter-runner login codex [--name N]      device-code login, run here
 *   unopenrouter-runner accounts | logout <name>
 *   unopenrouter-runner [start] [--concurrency N] [--keep-transcripts]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { claudeUsage } from "./runner/claude-usage.js";
import { CodexServer } from "./runner/codex.js";
import { execCli } from "./runner/exec.js";
import { NAME, PROTOCOL, type FromRunner, type RunnerAccount, type RunRequest, type ToRunner } from "./runner/protocol.js";
import { CONTENT_DIRS, KEEP_MS, removeOlder } from "./runner/sweep.js";
import type { WindowReading } from "./runner/types.js";

import pkg from "../package.json" with { type: "json" };
const VERSION = pkg.version;
const POLL_MS = 10 * 60_000;
const DEFAULT_SERVER = "https://api.unopenrouter.com";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    server: { type: "string" },
    concurrency: { type: "string" },
    "keep-transcripts": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

// The account's own home from passwd, not $HOME: `sudo -u unopenrouter-runner` may keep the caller's $HOME.
const home = process.env.UNOR_RUNNER_HOME ?? path.join(os.userInfo().homedir, ".config", "unopenrouter-runner");
const configFile = path.join(home, "config.json");
const accountsDir = path.join(home, "accounts");
const claudeBin = process.env.UNOR_CLAUDE_BIN ?? "claude";
const codexBin = process.env.UNOR_CODEX_BIN ?? "codex";

interface Config {
  server: string;
  runnerId: string;
  token: string;
  name: string;
}

interface LocalAccount {
  name: string;
  provider: "claude" | "codex";
  dir: string;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function writePrivate(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function readConfig(): Config {
  if (!fs.existsSync(configFile)) throw new Error("Not paired yet: make a pairing code in the dashboard (Runners → Add runner), then run `unopenrouter-runner pair <code>`.");
  return JSON.parse(fs.readFileSync(configFile, "utf8"));
}

function localAccounts(): LocalAccount[] {
  if (!fs.existsSync(accountsDir)) return [];
  return fs
    .readdirSync(accountsDir)
    .map((name) => ({ name, dir: path.join(accountsDir, name), file: path.join(accountsDir, name, "account.json") }))
    .filter((a) => fs.existsSync(a.file))
    .map((a) => ({ name: a.name, dir: a.dir, provider: JSON.parse(fs.readFileSync(a.file, "utf8")).provider }));
}

function accountName(provider: string): string {
  const name = (values.name ?? provider).toLowerCase();
  if (!NAME.test(name)) throw new Error("--name must be 1–30 lowercase letters, digits or dashes.");
  return name;
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim();
}

async function pair(code: string) {
  const server = (values.server ?? DEFAULT_SERVER).replace(/\/$/, "");
  const res = await fetch(`${server}/runner/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: values.name ?? os.hostname(), version: VERSION }),
  });
  const body = (await res.json()) as { runner_id?: string; token?: string; name?: string; error?: { message: string } };
  if (!res.ok || !body.token) throw new Error(body.error?.message ?? `pairing failed: HTTP ${res.status}`);
  writePrivate(configFile, JSON.stringify({ server, runnerId: body.runner_id, token: body.token, name: body.name }, null, 2) + "\n");
  console.log(`Paired as runner "${body.name}". Next: \`unopenrouter-runner login claude\` and/or \`login codex\`, then \`unopenrouter-runner\`.`);
}

async function loginClaude() {
  const name = accountName("claude");
  console.log("On your own computer (a home connection works best), run `claude setup-token`, sign in, and paste the token it prints.");
  const token = process.env.UNOR_CLAUDE_TOKEN ?? (await ask("Token: "));
  const check = await claudeUsage(token);
  if (check.auth) throw new Error("Anthropic rejected that token. Make a new one with `claude setup-token`.");
  const dir = path.join(accountsDir, name);
  writePrivate(path.join(dir, "oauth-token"), token + "\n");
  writePrivate(path.join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 36500 }) + "\n");
  writePrivate(path.join(dir, "account.json"), JSON.stringify({ provider: "claude" }) + "\n");
  console.log(`Claude account "${name}" is ready (5-hour window ${check.windows.find((w) => w.window === "5h")?.usedPercent ?? "?"}% used).`);
}

async function loginCodex() {
  const name = accountName("codex");
  const dir = path.join(accountsDir, name);
  writePrivate(path.join(dir, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  console.log("Starting Codex's device-code login. If it fails with a 403 on a VPS, run the runner at home instead.");
  const code = await new Promise<number>((resolve) => {
    const child = spawn(codexBin, ["login", "--device-auth"], { env: { ...process.env, CODEX_HOME: dir }, stdio: "inherit" });
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0 || !fs.existsSync(path.join(dir, "auth.json"))) throw new Error("The Codex login did not finish.");
  writePrivate(path.join(dir, "account.json"), JSON.stringify({ provider: "codex" }) + "\n");
  console.log(`Codex account "${name}" is ready.`);
}

function logout(name: string) {
  const dir = path.join(accountsDir, name);
  for (const f of ["account.json", "oauth-token", "auth.json"]) fs.rmSync(path.join(dir, f), { force: true });
  console.log(`Logged out "${name}". Its transcripts stay in ${dir} until swept.`);
}

/** The long-running part: one connection to the server, kept up for good, serving runs on this machine's accounts. */
async function start() {
  // Under systemd or Docker the runner starts before it's paired: wait for `pair` instead of exiting.
  while (!fs.existsSync(configFile)) {
    log("not paired yet: run `unopenrouter-runner pair <code>` (make the code in the dashboard: Runners → Add runner)");
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const config = readConfig();
  const scratch = path.join(home, "scratch");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const concurrency = Number(values.concurrency ?? (os.totalmem() < 1.5 * 2 ** 30 ? 1 : 2));
  const codex = new Map<string, CodexServer>();
  const readings = new Map<string, { windows: Omit<WindowReading, "takenAt">[]; authStatus: RunnerAccount["authStatus"]; authDetail: string | null; plan: string | null }>();
  const jobs = new Map<string, AbortController>();
  let running = 0;
  const waiting: (() => void)[] = [];
  let noStore = true;
  let ws: WebSocket | null = null;

  const send = (m: FromRunner) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const codexFor = (a: LocalAccount) => {
    let s = codex.get(a.name);
    if (!s || s.dead) codex.set(a.name, (s = new CodexServer(codexBin, a.dir, null)));
    return s;
  };
  const report = () =>
    send({
      type: "accounts",
      accounts: localAccounts().map((a) => {
        const r = readings.get(a.name);
        return { name: a.name, provider: a.provider, plan: r?.plan ?? null, authStatus: r?.authStatus ?? "unknown", authDetail: r?.authDetail ?? null, windows: r?.windows ?? [] };
      }),
    });

  const poll = async () => {
    for (const a of localAccounts()) {
      try {
        if (a.provider === "claude") {
          const r = await claudeUsage(fs.readFileSync(path.join(a.dir, "oauth-token"), "utf8").trim());
          readings.set(a.name, { windows: r.windows, authStatus: r.auth ? "auth" : "ok", authDetail: r.auth ? "The token was rejected; make a new one with `claude setup-token`." : null, plan: "Claude" });
        } else {
          const s = codexFor(a);
          await s.ready;
          const r = await s.usage();
          readings.set(a.name, { windows: r.windows, authStatus: "ok", authDetail: null, plan: r.plan });
        }
      } catch (e) {
        readings.set(a.name, { windows: readings.get(a.name)?.windows ?? [], authStatus: "auth", authDetail: `Usage check failed: ${(e as Error).message}`, plan: readings.get(a.name)?.plan ?? null });
      }
    }
    report();
  };

  const sweep = () => {
    if (!noStore || values["keep-transcripts"]) return;
    const before = Date.now() - KEEP_MS;
    for (const a of localAccounts()) for (const d of CONTENT_DIRS) removeOlder(path.join(a.dir, d), before);
  };

  const run = async (m: RunRequest) => {
    const a = localAccounts().find((x) => x.name === m.account && x.provider === m.provider);
    const emit = (event: Extract<FromRunner, { type: "event" }>["event"]) => send({ type: "event", id: m.id, event });
    if (!a) return emit({ type: "error", code: "auth", message: `No ${m.provider} account "${m.account}" on this runner.`, resetsAt: null });
    while (running >= concurrency) await new Promise<void>((r) => waiting.push(r));
    running++;
    const ac = new AbortController();
    jobs.set(m.id, ac);
    try {
      const events = execCli(
        {
          provider: a.provider,
          home: a.dir,
          claudeBin,
          claudeToken: a.provider === "claude" ? fs.readFileSync(path.join(a.dir, "oauth-token"), "utf8").trim() : null,
          codex: a.provider === "codex" ? codexFor(a) : null,
          cwd: scratch,
          model: m.model,
          effort: m.effort,
          thinking: m.thinking,
          system: m.system,
          maxOutputTokens: m.maxOutputTokens,
          parts: m.parts,
          nativeId: m.nativeId,
          onId: (id) => emit({ type: "session", id }),
        },
        ac.signal,
      );
      for await (const ev of events) {
        emit(ev);
        if (ev.type === "usage") readings.set(a.name, { ...(readings.get(a.name) ?? { authStatus: "ok", authDetail: null, plan: null }), windows: ev.windows });
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") emit({ type: "error", code: "failed", message: (e as Error).message, resetsAt: null });
    } finally {
      jobs.delete(m.id);
      running--;
      waiting.shift()?.();
    }
  };

  const handle = (m: ToRunner) => {
    switch (m.type) {
      case "welcome":
        noStore = m.noStore;
        log(`connected as "${m.name}"; ${localAccounts().length} account(s); privacy: ${noStore && !values["keep-transcripts"] ? "transcripts deleted after 3 idle hours" : "transcripts kept"}`);
        report();
        return;
      case "settings":
        noStore = m.noStore;
        return;
      case "ping":
        return send({ type: "pong" });
      case "run":
        void run(m);
        return;
      case "cancel":
        jobs.get(m.id)?.abort();
        return;
      default:
        log(`refused a message of unknown type ${JSON.stringify((m as { type?: unknown }).type)}`);
    }
  };

  setInterval(() => void poll(), POLL_MS).unref();
  setInterval(sweep, POLL_MS).unref();
  // An account logged in while the runner runs is picked up within half a minute.
  let known = localAccounts().map((a) => a.name).join();
  setInterval(() => {
    const now = localAccounts().map((a) => a.name).join();
    if (now !== known) {
      known = now;
      void poll();
    }
  }, 30_000).unref();
  void poll();
  sweep();

  let backoff = 1000;
  for (;;) {
    const opened = await new Promise<boolean>((resolve) => {
      let open = false;
      let lastPing = Date.now();
      const url = config.server.replace(/^http/, "ws") + "/runner";
      const sock = new WebSocket(url);
      ws = sock;
      const watchdog = setInterval(() => {
        if (Date.now() - lastPing > 120_000) sock.close();
      }, 10_000);
      sock.addEventListener("open", () => {
        open = true;
        backoff = 1000;
        sock.send(JSON.stringify({ type: "auth", token: config.token, version: VERSION, protocol: PROTOCOL } satisfies FromRunner));
      });
      sock.addEventListener("message", (e) => {
        lastPing = Date.now();
        try {
          handle(JSON.parse(String(e.data)));
        } catch (err) {
          log(`bad message: ${(err as Error).message}`);
        }
      });
      sock.addEventListener("close", (e) => {
        clearInterval(watchdog);
        for (const j of jobs.values()) j.abort();
        if (e.code === 4004 || e.code === 4010) {
          console.error("The server no longer accepts this runner's token (revoked?). Pair it again.");
          process.exit(1);
        }
        if (open) log(`disconnected (${e.code}${e.reason ? ` ${e.reason}` : ""}); reconnecting`);
        resolve(open);
      });
      sock.addEventListener("error", () => {});
    });
    if (!opened) backoff = Math.min(60_000, backoff * 2);
    await new Promise((r) => setTimeout(r, backoff + Math.random() * 1000));
  }
}

const [command = values.version ? "version" : values.help ? "help" : "start", ...rest] = positionals;
const USAGE = "usage: unopenrouter-runner [start] | pair <code> | login claude|codex [--name N] | accounts | logout <name> | version";
const commands: Record<string, () => Promise<void> | void> = {
  pair: () => pair(rest[0] ?? ""),
  login: () => (rest[0] === "codex" ? loginCodex() : rest[0] === "claude" ? loginClaude() : Promise.reject(new Error("login claude | login codex"))),
  accounts: () => {
    for (const a of localAccounts()) console.log(`${a.name}\t${a.provider}`);
  },
  logout: () => logout(rest[0] ?? ""),
  start,
  version: () => console.log(VERSION),
  help: () => console.log(USAGE),
};
if (!commands[command]) {
  console.error(USAGE);
  process.exit(2);
}
Promise.resolve(commands[command]()).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

import { spawn, type ChildProcess } from "node:child_process";
import type { Spawner } from "./claude.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { zeroUsage } from "../models.js";
import { childEnv, type CliEvent } from "./claude.js";
import type { CliPart, WindowReading } from "./types.js";

/** The tokens Codex's app-server takes for an external ChatGPT login (account/login/start, type chatgptAuthTokens). */
export interface CodexTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

/** Everything that would let a model run touch the machine is off. */
const NO_TOOLS = [
  ...["shell_tool", "unified_exec", "view_image", "image_generation", "multi_agent", "apps", "browser_use", "computer_use", "in_app_browser", "hooks", "goals", "sleep_tool", "skill_search", "tool_suggest", "memories"].flatMap((f) => [
    "-c",
    `features.${f}=false`,
  ]),
  "-c",
  'web_search="disabled"',
  ...["include_permissions_instructions", "include_apps_instructions", "include_environment_context", "include_collaboration_mode_instructions"].flatMap((k) => ["-c", `${k}=false`]),
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  "skills.include_instructions=false",
  "-c",
  "skills.bundled.enabled=false",
  "-c",
  "features.plugins=false",
];

const LIMIT_TEXT = /usage limit|rate limit|limit reached|limit exceeded|quota/i;
const PLAIN_SYSTEM = "You are a helpful assistant.";
const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 10080;

type Listener = (method: string, params: any) => void;

/**
 * One `codex app-server` per account, spoken to over its stdin and stdout. Started on first use and again
 * after it exits; threads live in the account's CODEX_HOME, so they outlive the process.
 */
export class CodexServer {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private accessToken: string | undefined;
  /** Threads this process has loaded; any other needs thread/resume first. */
  loaded = new Set<string>();
  ready: Promise<void>;
  dead = false;

  constructor(
    private bin: string,
    private home: string,
    private authTokens: ((rejected?: string) => Promise<CodexTokens>) | null,
    private spawner: Spawner = spawn,
  ) {
    this.ready = this.start();
    this.ready.catch(() => this.stop());
  }

  /** JSON-RPC over the app-server's stdin and stdout: pipes work from inside a network jail, a local port wouldn't. */
  private async start() {
    const child = this.spawner(this.bin, ["app-server", ...NO_TOOLS, "--listen", "stdio://"], {
      cwd: this.home,
      env: childEnv({ HOME: this.home, CODEX_HOME: this.home }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.on("close", () => this.stop());
    child.on("error", () => this.stop());
    child.stdin!.on("error", () => this.stop());
    child.stderr!.resume();
    readline.createInterface({ input: child.stdout! }).on("line", (line) => this.handle(line));
    await this.request("initialize", { clientInfo: { name: "unopenrouter", title: "unopenrouter", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.send({ jsonrpc: "2.0", method: "initialized" });
    if (this.authTokens) {
      const tokens = await this.authTokens();
      // Known before the login call returns: a refresh request can follow it at once and must name this token.
      this.accessToken = tokens.accessToken;
      await this.request("account/login/start", { type: "chatgptAuthTokens", ...tokens });
    }
  }

  private send(msg: unknown) {
    if (!this.dead) this.child?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private handle(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) {
        for (const l of [...this.listeners]) l(msg.method, msg.params);
        return;
      }
      void this.answer(msg.method).then((reply) => this.send({ jsonrpc: "2.0", id: msg.id, ...reply }));
      return;
    }
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  /** Server → client requests: a token refresh is answered; anything else (an approval) is refused. */
  private async answer(method: string): Promise<{ result: unknown } | { error: unknown }> {
    try {
      if (method === "account/chatgptAuthTokens/refresh" && this.authTokens) {
        const tokens = await this.authTokens(this.accessToken);
        this.accessToken = tokens.accessToken;
        return { result: tokens };
      }
      return { error: { code: -32601, message: `${method} is not supported by unopenrouter` } };
    } catch (e) {
      return { error: { code: -32000, message: (e as Error).message } };
    }
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.dead) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  stop() {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) p.reject(new Error("Codex app-server exited."));
    this.pending.clear();
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
  }

  /** The account's usage windows and plan. */
  async usage(): Promise<{ windows: Omit<WindowReading, "takenAt">[]; plan: string | null }> {
    const res = await this.request("account/rateLimits/read", { excludeResetCreditDetails: true });
    const snap = res?.rateLimits;
    const windows: Omit<WindowReading, "takenAt">[] = [];
    for (const w of [snap?.primary, snap?.secondary]) if (w) windows.push(codexWindow(w));
    if (snap?.rateLimitReachedType != null && windows.length) {
      const worst = windows.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
      worst.status = "limited";
    }
    let plan: string | null = null;
    try {
      const acc = await this.request("account/read", {});
      plan = acc?.account?.planType ?? null;
    } catch {
      // the plan is a nicety
    }
    return { windows, plan };
  }
}

export function codexWindow(w: { usedPercent: number; windowDurationMins?: number; resetsAt?: number }): Omit<WindowReading, "takenAt"> {
  const m = w.windowDurationMins ?? FIVE_HOUR_MINS;
  const window = Math.abs(m - FIVE_HOUR_MINS) <= 60 ? "5h" : Math.abs(m - WEEKLY_MINS) <= 1440 ? "weekly" : m >= 24 * 60 ? "weekly" : "5h";
  const usedPercent = w.usedPercent;
  return { window, usedPercent, resetsAt: w.resetsAt ? (w.resetsAt > 1e12 ? w.resetsAt : w.resetsAt * 1000) : null, status: usedPercent >= 100 ? "limited" : usedPercent >= 80 ? "warning" : "ok" };
}

interface Counts {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

function counts(t: any): Counts | undefined {
  if (!t || typeof t !== "object") return undefined;
  return { input: t.inputTokens ?? 0, cached: t.cachedInputTokens ?? 0, output: t.outputTokens ?? 0, reasoning: t.reasoningOutputTokens ?? 0 };
}

const minus = (a: Counts, b: Counts): Counts => ({ input: a.input - b.input, cached: a.cached - b.cached, output: a.output - b.output, reasoning: a.reasoning - b.reasoning });

export interface CodexRun {
  server: CodexServer;
  cwd: string;
  imagesDir: string;
  model: string;
  effort?: string;
  /** The thread to continue; a new one is started when null. */
  threadId: string | null;
  system?: string;
  prompt: CliPart[];
}

/** One turn on a Codex thread, new or continued; `onThread` hears the thread's id before the turn starts. */
export async function* runCodex(r: CodexRun, signal: AbortSignal, onThread: (id: string) => void): AsyncGenerator<CliEvent> {
  const s = r.server;
  await s.ready;
  const policy = { approvalPolicy: "never" as const, sandbox: "read-only" as const };
  let threadId = r.threadId;
  let model: string | null = null;
  if (!threadId) {
    const res = await s.request("thread/start", { cwd: r.cwd, ...policy, model: r.model, baseInstructions: r.system || PLAIN_SYSTEM });
    threadId = res.thread.id as string;
    model = res.model ?? null;
    s.loaded.add(threadId);
  } else if (!s.loaded.has(threadId)) {
    await s.request("thread/resume", { threadId, cwd: r.cwd, ...policy, model: r.model, excludeTurns: true });
    s.loaded.add(threadId);
  }
  onThread(threadId);

  const input: unknown[] = [];
  const files: string[] = [];
  r.prompt.forEach((p, i) => {
    if (p.type === "text") input.push({ type: "text", text: p.text, text_elements: [] });
    else {
      fs.mkdirSync(r.imagesDir, { recursive: true, mode: 0o700 });
      const file = path.join(r.imagesDir, `${threadId}-${Date.now()}-${i}.${p.mediaType.split("/")[1] ?? "png"}`);
      fs.writeFileSync(file, Buffer.from(p.data, "base64"), { mode: 0o600 });
      files.push(file);
      input.push({ type: "localImage", path: file });
    }
  });

  const queue: CliEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let text = "";
  let finalText: string | null = null;
  const usage = zeroUsage();
  let baseline: Counts | undefined;
  let turnId: string | null = null;
  const push = (e: CliEvent | null) => {
    if (e) queue.push(e);
    else finished = true;
    wake?.();
  };
  const off = s.on((method, params) => {
    if (method === "account/rateLimits/updated") {
      const snap = params?.rateLimits;
      const windows = [snap?.primary, snap?.secondary].filter(Boolean).map(codexWindow);
      if (windows.length) push({ type: "usage", windows });
      return;
    }
    if (params?.threadId !== threadId) return;
    if (method === "turn/started") turnId = params.turn?.id ?? turnId;
    else if (method === "item/agentMessage/delta" && params.delta) {
      text += params.delta;
      push({ type: "delta", text: params.delta });
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      finalText = (finalText ?? "") + (params.item.text ?? "");
    } else if (method === "thread/tokenUsage/updated") {
      // Thread totals: the first update of the turn gives the total before it (total − last), and every later
      // one is measured from there, so a repeated notification can't count twice.
      const total = counts(params.tokenUsage?.total);
      if (!total) return;
      baseline ??= minus(total, counts(params.tokenUsage?.last) ?? counts({})!);
      const turn = minus(total, baseline);
      usage.input = turn.input - turn.cached;
      usage.cacheRead = turn.cached;
      usage.output = turn.output;
      usage.reasoning = turn.reasoning;
    } else if (method === "turn/completed") {
      const turn = params.turn ?? {};
      if (turn.status === "completed") {
        push({ type: "result", text: finalText ?? text, usage, stopReason: "end_turn", model });
      } else {
        const message = String(turn.error?.message ?? `turn ${turn.status}`);
        const info = JSON.stringify(turn.error?.codexErrorInfo ?? "");
        const code = /usageLimitExceeded|rateLimitExceeded/.test(info) || LIMIT_TEXT.test(message)
          ? "limited"
          : /unauthorized/i.test(info)
            ? "auth"
            : /contextWindowExceeded/i.test(info) || /context window/i.test(message)
              ? "context"
              : "failed";
        push({ type: "error", code, message: message.slice(0, 500), resetsAt: null });
      }
      push(null);
    }
  });
  const onAbort = () => {
    if (turnId) s.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    push(null);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const died = setInterval(() => {
    if (s.dead) {
      push({ type: "error", code: "failed", message: "Codex app-server exited during the turn.", resetsAt: null });
      push(null);
    }
  }, 1000);
  try {
    let started: any;
    try {
      started = await s.request("turn/start", {
        threadId,
        input,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: r.model,
        ...(r.effort ? { effort: r.effort } : {}),
      });
    } catch (e) {
      // Codex takes at most 1,048,576 characters of input in one turn, before the model's own window.
      if (!/exceeds the maximum length/i.test((e as Error).message)) throw e;
      yield { type: "error", code: "context", message: (e as Error).message.slice(0, 500), resetsAt: null };
      return;
    }
    turnId = started?.turn?.id ?? turnId;
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
    while (queue.length) yield queue.shift()!;
    if (signal.aborted) throw Object.assign(new Error("The request was cancelled."), { name: "AbortError" });
  } finally {
    off();
    clearInterval(died);
    signal.removeEventListener("abort", onAbort);
    // Codex has read them by the end of the turn; nothing keeps images on disk.
    for (const f of files) fs.rmSync(f, { force: true });
  }
}

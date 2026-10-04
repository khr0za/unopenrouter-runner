import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { zeroUsage, type Usage } from "../models.js";
import type { CliPart, WindowReading } from "./types.js";

/** What a CLI run reports, in the order it happens. */
export type CliEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; windows: Omit<WindowReading, "takenAt">[] }
  | { type: "result"; text: string; usage: Usage; stopReason: string | null; model: string | null }
  | { type: "error"; code: "limited" | "auth" | "failed" | "context"; message: string; resetsAt: number | null; window?: string };

/** How a CLI is started: plainly, or inside a user's network jail (exit nodes). */
export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface ClaudeRun {
  spawner?: Spawner;
  bin: string;
  home: string;
  token: string;
  cwd: string;
  model: string;
  effort?: string;
  /** False turns the CLI's thinking off; it thinks by default. */
  thinking?: boolean;
  /** A new conversation: its id and system prompt. Otherwise `resume` is the id to continue. */
  sessionId: string;
  fresh: boolean;
  system?: string;
  prompt: CliPart[];
  maxOutputTokens?: number;
}

const PLAIN_SYSTEM = "You are a helpful assistant.";
const SILENCE_MS = 10 * 60_000;
const WINDOW_NAMES: Record<string, string> = { five_hour: "5h", seven_day: "weekly", seven_day_overage_included: "fable" };
const LIMIT_TEXT = /usage limit|rate limit|limit reached|limit exceeded/i;

/** Seconds or milliseconds, as the CLI and the headers mix them. */
export const resetMs = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
};

/** Usage as the Messages API and the CLI's result report it. */
function usageOf(u: any): Usage {
  const usage = zeroUsage();
  usage.input = u.input_tokens ?? 0;
  usage.cacheRead = u.cache_read_input_tokens ?? 0;
  usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
  usage.output = u.output_tokens ?? 0;
  usage.reasoning = u.output_tokens_details?.thinking_tokens ?? 0;
  return usage;
}

/** The environment a CLI gets: an allowlist, so nothing of the service's own (the vault key) leaks into it. */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", TERM: "dumb", DISABLE_AUTOUPDATER: "1" };
  if (process.env.LANG) env.LANG = process.env.LANG;
  return { ...env, ...extra };
}

/** `claude -p` with no tools, streaming its events. */
export async function* runClaude(r: ClaudeRun, signal: AbortSignal): AsyncGenerator<CliEvent> {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  args.push("--model", r.model, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands");
  if (r.effort) args.push("--effort", r.effort);
  // Images the CLI writes to TMPDIR stay in the account's home, where the privacy sweep sees them.
  const tmp = path.join(r.home, "tmp");
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  // The system prompt goes in a file: one argument can't exceed 128 KB on Linux.
  const systemFile = path.join(tmp, `system-${r.sessionId}.txt`);
  if (r.fresh) {
    fs.writeFileSync(systemFile, r.system || PLAIN_SYSTEM, { mode: 0o600 });
    args.push("--session-id", r.sessionId, "--system-prompt-file", systemFile);
  } else args.push("--resume", r.sessionId);
  // TOTAL_TOKENS_REMINDER off: no "<total_tokens>" block in every prompt, which the user would pay for.
  const env = childEnv({ HOME: r.home, CLAUDE_CONFIG_DIR: r.home, CLAUDE_CODE_OAUTH_TOKEN: r.token, TMPDIR: tmp, CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" });
  if (r.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(r.maxOutputTokens);
  if (r.thinking === false) env.MAX_THINKING_TOKENS = "0";

  const child = (r.spawner ?? spawn)(r.bin, args, { cwd: r.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const content = r.prompt.map((p) => (p.type === "text" ? p : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } }));
  child.stdin!.on("error", () => {});
  child.stdin!.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");

  let stderr = "";
  child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
      }, 5000).unref();
    } catch {
      // already gone
    }
  };
  let silent = setTimeout(kill, SILENCE_MS);
  const onAbort = () => kill();
  signal.addEventListener("abort", onAbort, { once: true });

  let text = "";
  let model: string | null = null;
  let authFailed = false;
  let limitedUntil: number | null = null;
  let limitWindow: string | undefined;
  let sawLimit = false;
  let result: any = null;
  let started: any = {};
  try {
    for await (const line of readline.createInterface({ input: child.stdout! })) {
      clearTimeout(silent);
      silent = setTimeout(kill, SILENCE_MS);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "stream_event") {
        const e = msg.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) yield { type: "delta", text: e.delta.text };
        else if (e?.type === "message_start") started = e.message?.usage ?? {};
        else if (e?.type === "message_delta" && e.delta?.stop_reason === "max_tokens" && r.maxOutputTokens) {
          // The caller's limit: the CLI would ask the model to go on three more times and then fail the run.
          yield { type: "result", text, usage: usageOf({ ...started, output_tokens: e.usage?.output_tokens }), stopReason: "max_tokens", model };
          return;
        }
      } else if (msg.type === "system" && msg.subtype === "init") {
        model = msg.model ?? model;
      } else if (msg.type === "assistant") {
        if (msg.error === "authentication_failed") authFailed = true;
        for (const b of msg.message?.content ?? []) if (b?.type === "text") text += b.text;
      } else if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info ?? {};
        const status = info.status === "rejected" ? "limited" : info.status === "allowed_warning" ? "warning" : "ok";
        if (status === "limited") {
          sawLimit = true;
          limitedUntil = resetMs(info.resetsAt);
          limitWindow = WINDOW_NAMES[info.rateLimitType] ?? info.rateLimitType;
        }
        const windows = Object.entries(info.unifiedWindows ?? {}).map(([raw, w]: [string, any]) => ({
          window: WINDOW_NAMES[raw] ?? raw,
          usedPercent: Number.isFinite(Number(w?.utilization)) ? Math.round(Number(w.utilization) * 1000) / 10 : null,
          resetsAt: resetMs(w?.resetsAt),
          status: (WINDOW_NAMES[raw] ?? raw) === (WINDOW_NAMES[info.rateLimitType] ?? info.rateLimitType) ? status : "ok",
        }));
        if (windows.length) yield { type: "usage", windows };
      } else if (msg.type === "result") {
        result = msg;
      }
    }
    const code = await exited;
    if (signal.aborted) throw Object.assign(new Error("The request was cancelled."), { name: "AbortError" });
    if (authFailed) {
      yield { type: "error", code: "auth", message: "The account's Claude login was rejected (authentication_failed).", resetsAt: null };
      return;
    }
    const failedText = result?.is_error ? String(result.result ?? result.subtype ?? "") : "";
    if (sawLimit || (failedText && LIMIT_TEXT.test(failedText))) {
      yield { type: "error", code: "limited", message: failedText || "The account hit its usage limit.", resetsAt: limitedUntil, window: limitWindow };
      return;
    }
    if (/prompt is too long/i.test(failedText)) {
      yield { type: "error", code: "context", message: failedText.slice(0, 500), resetsAt: null };
      return;
    }
    if (!result || result.is_error) {
      const why = failedText || stderr.trim().split("\n").slice(-3).join(" ") || `claude exited with code ${code}`;
      yield { type: "error", code: "failed", message: why.slice(0, 500), resetsAt: null };
      return;
    }
    yield { type: "result", text: typeof result.result === "string" ? result.result : text, usage: usageOf(result.usage ?? {}), stopReason: result.stop_reason ?? null, model };
  } finally {
    clearTimeout(silent);
    signal.removeEventListener("abort", onAbort);
    if (child.exitCode === null) kill();
    fs.rmSync(systemFile, { force: true });
  }
}

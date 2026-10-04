import { randomUUID } from "node:crypto";
import type { Provider } from "../models.js";
import { runClaude, type CliEvent, type Spawner } from "./claude.js";
import { runCodex, type CodexServer } from "./codex.js";
import type { CliPart } from "./types.js";

/** One CLI run on one account, the same on the server and on a user's runner. */
export interface Exec {
  provider: Provider;
  /** The account's CLI home: CLAUDE_CONFIG_DIR or CODEX_HOME. */
  home: string;
  claudeBin: string;
  claudeToken: string | null;
  codex: CodexServer | null;
  cwd: string;
  model: string;
  effort?: string;
  thinking?: boolean;
  system?: string;
  maxOutputTokens?: number;
  parts: CliPart[];
  /** The CLI session or Codex thread to continue; null starts a new one. */
  nativeId: string | null;
  /** Hears the session or thread id once it is known. */
  onId: (id: string) => void;
  spawner?: Spawner;
}

export async function* execCli(e: Exec, signal: AbortSignal): AsyncGenerator<CliEvent> {
  if (e.provider === "claude") {
    if (!e.claudeToken) {
      yield { type: "error", code: "auth", message: "This Claude account has no token.", resetsAt: null };
      return;
    }
    const id = e.nativeId ?? randomUUID();
    e.onId(id);
    yield* runClaude(
      { spawner: e.spawner, bin: e.claudeBin, home: e.home, token: e.claudeToken, cwd: e.cwd, model: e.model, effort: e.effort, thinking: e.thinking, sessionId: id, fresh: e.nativeId === null, system: e.system, prompt: e.parts, maxOutputTokens: e.maxOutputTokens },
      signal,
    );
    return;
  }
  yield* runCodex({ server: e.codex!, cwd: e.cwd, imagesDir: `${e.home}/images`, model: e.model, effort: e.effort, threadId: e.nativeId, system: e.system, prompt: e.parts }, signal, e.onId);
}

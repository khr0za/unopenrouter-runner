import type { Provider } from "../models.js";
import type { CliEvent } from "./claude.js";
import type { CliPart, WindowReading } from "./types.js";

/**
 * What unopenrouter and a user's runner say to each other over the runner's outbound WebSocket (/runner).
 * The server only ever sends model requests and their control; each side ignores or refuses anything else.
 */
export const PROTOCOL = 1;
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface RunnerAccount {
  name: string;
  provider: Provider;
  plan: string | null;
  authStatus: "ok" | "auth" | "unknown";
  authDetail: string | null;
  windows: Omit<WindowReading, "takenAt">[];
}

/** A run's events, as the runner's CLI reports them, plus the session or thread id once it is known. */
export type RunnerEvent = CliEvent | { type: "session"; id: string };

export type FromRunner =
  | { type: "auth"; token: string; version: string; protocol: number }
  | { type: "accounts"; accounts: RunnerAccount[] }
  | { type: "event"; id: string; event: RunnerEvent }
  | { type: "pong" };

export interface RunRequest {
  type: "run";
  id: string;
  account: string;
  provider: Provider;
  model: string;
  effort?: string;
  thinking?: boolean;
  system?: string;
  maxOutputTokens?: number;
  parts: CliPart[];
  nativeId: string | null;
}

export type ToRunner =
  | { type: "welcome"; runnerId: string; name: string; noStore: boolean }
  | RunRequest
  | { type: "cancel"; id: string }
  | { type: "settings"; noStore: boolean }
  | { type: "ping" };

/** Runner and account names: also directory names on the runner. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;

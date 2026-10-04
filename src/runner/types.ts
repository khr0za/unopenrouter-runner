import type { Model, Provider, Usage } from "../models.js";

/** A turn for the CLI: text and base64 images. */
export type CliPart = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string };
export interface CliMessage {
  role: "user" | "assistant";
  content: string | CliPart[];
}

/**
 * One model run. A new conversation sends `system` and `messages`; a later turn sends `resume` (the handle the
 * last run returned) and `message`. `accountId` asks for the account the conversation was on.
 */
export interface RunInput {
  userId: string;
  provider: Provider;
  model: string;
  effort?: string;
  /** False: the caller asked for no reasoning, so Claude doesn't think. */
  thinking?: boolean;
  system?: string;
  messages?: CliMessage[];
  resume?: string;
  message?: CliMessage;
  accountId?: string;
  conversationId?: string;
  source: string;
  maxOutputTokens?: number;
}

export interface Account {
  id: string;
  label: string;
}

export type RunEvent =
  | { type: "start"; account: Account; model: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; model: string; account: Account; resume: string; usage: Usage; stopReason: string | null; ms: number }
  // "context": the input is over the model's window; every account would refuse it too.
  | { type: "error"; code: "limited" | "auth" | "failed" | "context"; message: string; resetsAt: number | null };

/** The run was refused before it streamed: status and code say why (404 resume_unknown, 429 no_account, …). */
export class RunnerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface WindowReading {
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  status: string;
  takenAt: number;
}

/**
 * The model-call side, kept to two calls so the API layer doesn't care what runs the models: the local CLI
 * runner.
 */
export interface ModelRunner {
  models(): Promise<Model[]>;
  run(input: RunInput, signal?: AbortSignal): AsyncGenerator<RunEvent>;
}

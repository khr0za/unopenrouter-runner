import type { ModelRunner } from "./runner/types.js";

export type Provider = "claude" | "codex";

/** USD per million tokens at API list prices: an estimate for limits and stats, not what the subscriptions bill. */
export interface Pricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface Model {
  id: string;
  provider: Provider;
  /** When to use it, in a line: the docs and /llms.txt show it. */
  note: string;
  efforts: string[];
  contextLength: number;
  pricing: Pricing;
}

/** Token counts: `input` is neither read from nor written to the cache. */
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export const zeroUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

export const promptTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;

export function cost(model: Model, u: Usage): number {
  const p = model.pricing;
  return (u.input * p.input + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];

/**
 * The models, with API list prices per million tokens (platform.claude.com and OpenAI's pricing page, read
 * 2026-10-04): an estimate for spending limits and stats. Through a subscription they cost nothing extra.
 */
export const FALLBACK_MODELS: Model[] = [
  { id: "claude-opus-5-5", provider: "claude", note: "Claude's strongest model: hard reasoning, coding, agents. Slowest.", efforts: CLAUDE_EFFORTS, contextLength: 1000000, pricing: { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 } },
  { id: "claude-fable-5-1", provider: "claude", note: "Claude's premium model, with its own weekly limit: when quality matters most.", efforts: CLAUDE_EFFORTS, contextLength: 1000000, pricing: { input: 10, cacheWrite: 20, cacheRead: 0.25, output: 50 } },
  { id: "claude-sonnet-5-5", provider: "claude", note: "The balanced default for most work.", efforts: CLAUDE_EFFORTS, contextLength: 1000000, pricing: { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 } },
  { id: "claude-haiku-4-5-20251001", provider: "claude", note: "Fastest Claude: classification, extraction, short answers.", efforts: [], contextLength: 200000, pricing: { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 } },
  { id: "gpt-6.1-sol", provider: "codex", note: "The newest GPT all-rounder.", efforts: CODEX_EFFORTS, contextLength: 272000, pricing: { input: 2, cacheWrite: 0, cacheRead: 0.1, output: 10 } },
  { id: "gpt-6-astra", provider: "codex", note: "GPT's most capable model: complex reasoning. Slowest.", efforts: CODEX_EFFORTS, contextLength: 272000, pricing: { input: 10, cacheWrite: 0, cacheRead: 1, output: 50 } },
  { id: "gpt-6-sol", provider: "codex", note: "A general GPT model.", efforts: CODEX_EFFORTS, contextLength: 272000, pricing: { input: 2, cacheWrite: 0, cacheRead: 0.2, output: 10 } },
  { id: "gpt-6-luna", provider: "codex", note: "Fastest GPT: simple, high-volume tasks.", efforts: CODEX_EFFORTS, contextLength: 272000, pricing: { input: 0.1, cacheWrite: 0, cacheRead: 0.01, output: 0.5 } },
];

/** The fixed `created` every /v1/models entry reports (2026-09-21); the SDKs need an integer. */
const CREATED = 1790000000;

export class Catalog {
  models: Model[] = FALLBACK_MODELS;
  /** Whether the runner answered the last refresh, and when. */
  live = false;
  checkedAt = 0;
  lastError: string | null = null;

  constructor(private runner: ModelRunner) {}

  async refresh(): Promise<void> {
    try {
      const models = await this.runner.models();
      if (models.length) this.models = models;
      this.live = true;
      this.lastError = null;
    } catch (e) {
      this.live = false;
      this.lastError = (e as Error).message;
    }
    this.checkedAt = Date.now();
  }

  /** Exact ids, OpenRouter's `anthropic/` and `openai/` prefixes, and a dated id without its date. */
  find(name: string): Model | undefined {
    const id = name.replace(/^(anthropic|openai)\//, "");
    return this.models.find((m) => m.id === id) ?? this.models.find((m) => m.id.startsWith(id + "-") && /^\d{8}$/.test(m.id.slice(id.length + 1)));
  }

  /** A /v1/models entry: OpenAI's four fields, OpenRouter's context_length and per-token API pricing, and what it costs on a subscription. */
  entry(m: Model) {
    const perToken = (usdPerMillion: number) => (usdPerMillion / 1e6).toFixed(12).replace(/\.?0+$/, "");
    return {
      id: m.id,
      object: "model",
      created: CREATED,
      owned_by: m.provider === "claude" ? "anthropic" : "openai",
      context_length: m.contextLength,
      pricing: {
        prompt: perToken(m.pricing.input),
        completion: perToken(m.pricing.output),
        input_cache_read: perToken(m.pricing.cacheRead),
        input_cache_write: perToken(m.pricing.cacheWrite),
      },
      subscription_cost: 0,
    };
  }
}

/** OpenAI's reasoning_effort values, mapped onto the efforts the model takes; undefined means the CLI default. */
export function mapEffort(m: Model, effort: string | null | undefined): string | undefined {
  if (!effort || !m.efforts.length) return undefined;
  if (m.efforts.includes(effort)) return effort;
  if (effort === "none" || effort === "minimal") return m.efforts[0];
  if (effort === "max" || effort === "xhigh") return m.efforts[m.efforts.length - 1];
  return undefined;
}

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

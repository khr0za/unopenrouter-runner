import { resetMs } from "./claude.js";
import type { WindowReading } from "./types.js";

const HEADER_WINDOWS: [string, string][] = [
  ["5h", "5h"],
  ["7d", "weekly"],
  ["7d_oi", "fable"],
];

/**
 * A setup-token's usage: a one-token Haiku call whose
 * `anthropic-ratelimit-unified-*` headers carry each window's utilization and reset. Also how a pasted token
 * is checked. Throws when the answer carries no windows; `auth` is set on a rejected token.
 */
export async function claudeUsage(token: string): Promise<{ windows: Omit<WindowReading, "takenAt">[]; auth: boolean }> {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "quota" }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) return { windows: [], auth: true };
  const windows: Omit<WindowReading, "takenAt">[] = [];
  for (const [key, window] of HEADER_WINDOWS) {
    const h = (name: string) => res.headers.get(`anthropic-ratelimit-unified-${key}-${name}`);
    const utilization = Number(h("utilization") ?? NaN);
    if (!Number.isFinite(utilization)) continue;
    const status = h("status");
    windows.push({
      window,
      usedPercent: Math.round(utilization * 1000) / 10,
      status: status === "rejected" ? "limited" : status === "allowed_warning" || h("surpassed-threshold") ? "warning" : "ok",
      resetsAt: resetMs(h("reset")),
    });
  }
  if (!windows.length) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { windows, auth: false };
}

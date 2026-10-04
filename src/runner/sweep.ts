import fs from "node:fs";
import path from "node:path";

/** "Don't store my data": what a conversation leaves behind lives only as long as it helps prompt caching. */
export const KEEP_MS = 3 * 3_600_000;

/** The places in an account's CLI home where conversation content lands: transcripts, rollouts, images, temp files. */
export const CONTENT_DIRS = ["projects", "sessions", "images", "tmp"];

/** Deletes the files under `dir` last written before `before`; a runner sweeps its own homes with it too. */
export function removeOlder(dir: string, before: number): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (fs.statSync(file).mtimeMs < before) {
      fs.rmSync(file, { force: true });
      n++;
    }
  }
  return n;
}

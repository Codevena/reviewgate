// src/core/workspace-settle.ts
// #7: bounded "settle" check — before collectDiff snapshots the working tree, wait
// (≤ maxSettleMs) for it to stop changing, so the panel reviews a quiescent snapshot
// rather than a half-written one. Fail-safe by design: the caller ONLY uses this to
// DELAY (and optionally warn), never to skip a review. See the design spec.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { workingTreeDirtyFiles } from "../utils/git.ts";

export const SETTLE_QUIET_WINDOW_MS = 2000;
export const SETTLE_INTERVAL_MS = 250;
export const SETTLE_MAX_MS = 1500;

export interface SettleResult {
  settled: boolean; // false → still advancing at the cap (churning)
  waitedMs: number;
  lastWriteMsAgo: number; // now − latestChange at the final sample (0 if no files)
}

// Newest max(mtime, ctime) across files (ms). ctime is not back-datable, so it
// catches a create/metadata change mtime alone would miss. Best-effort per file.
export function latestChangeMs(repoRoot: string, files: string[]): number {
  let max = 0;
  for (const f of files) {
    try {
      const st = lstatSync(join(repoRoot, f));
      const c = Math.max(st.mtimeMs, st.ctimeMs);
      if (c > max) max = c;
    } catch {
      /* racing unlink / unstattable → skip */
    }
  }
  return max;
}

export async function awaitWorkspaceSettle(opts: {
  repoRoot: string;
  quietWindowMs: number;
  settleIntervalMs: number;
  maxSettleMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<SettleResult> {
  const { repoRoot, quietWindowMs, settleIntervalMs, maxSettleMs, now, sleep } = opts;
  let files = await workingTreeDirtyFiles(repoRoot);
  if (files.length === 0) return { settled: true, waitedMs: 0, lastWriteMsAgo: 0 };
  let last = latestChangeMs(repoRoot, files);
  if (now() - last >= quietWindowMs) {
    return { settled: true, waitedMs: 0, lastWriteMsAgo: now() - last };
  }
  let waited = 0;
  while (waited < maxSettleMs) {
    const step = Math.min(settleIntervalMs, maxSettleMs - waited);
    await sleep(step);
    waited += step;
    files = await workingTreeDirtyFiles(repoRoot); // re-enumerate → catch newly created files
    const cur = latestChangeMs(repoRoot, files);
    if (cur <= last) return { settled: true, waitedMs: waited, lastWriteMsAgo: now() - cur };
    last = cur;
  }
  return { settled: false, waitedMs: waited, lastWriteMsAgo: now() - last };
}

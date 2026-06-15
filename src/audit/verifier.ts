// src/audit/verifier.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function canonical(o: unknown): string {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return `[${o.map(canonical).join(",")}]`;
  const keys = Object.keys(o as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((o as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface VerifyResult {
  ok: boolean;
  brokenAtLine: number | null;
  totalLines: number;
}

export async function verifyChain(path: string): Promise<VerifyResult> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  let prev = "";
  for (let i = 0; i < lines.length; i++) {
    // A tampered / truncated / half-flushed line is not valid JSON — treat it as a
    // BROKEN CHAIN at that line rather than letting JSON.parse throw an uncaught
    // SyntaxError (which would surface to the user as a raw stack trace from
    // `audit verify`). A truncated trailing line therefore also reports corruption,
    // which is the best a forward-only chain can do for tail-truncation: the dropped
    // tail itself is undetectable, but a mid-write truncation that leaves a partial
    // final line IS caught here.
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i] as string) as Record<string, unknown>;
    } catch {
      return { ok: false, brokenAtLine: i + 1, totalLines: lines.length };
    }
    if (obj.prev_event_hash !== prev) {
      return { ok: false, brokenAtLine: i + 1, totalLines: lines.length };
    }
    const claimed = obj.this_event_hash as string;
    const recomputeBase = { ...obj };
    recomputeBase.this_event_hash = undefined;
    const recompute = sha256(canonical(recomputeBase));
    // Use recompute (not claimed) as the chain link so tampering of THIS line
    // surfaces at line i+2's prev_event_hash check. This gives the
    // brokenAtLine semantics the test asserts (brokenAtLine: 2 when line 1 is tampered).
    prev = recompute;
    // Catch tampering of the FINAL line (no successor to expose it).
    if (i === lines.length - 1 && recompute !== claimed) {
      return { ok: false, brokenAtLine: i + 1, totalLines: lines.length };
    }
  }
  return { ok: true, brokenAtLine: null, totalLines: lines.length };
}

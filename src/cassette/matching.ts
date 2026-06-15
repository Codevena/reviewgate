// src/cassette/matching.ts
import { createHash } from "node:crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// review() entries are keyed by the reviewerId the orchestrator passes
// ("<provider>-<persona>" for the panel, "critic-<provider>" for the critic) →
// FIFO per key. embed() is a pure function of its text → content-addressed
// (order-independent, dedup-friendly).
export function reviewKey(reviewerId: string): string {
  return reviewerId;
}

// complete() has no persona, so a SINGLE per-provider FIFO (`<provider>:complete`)
// pooled responses from DISTINCT judge phases (critic, grounding, curator…) into
// one queue — and pop-order skew across phases would hand a phase the WRONG
// recorded response. Keying by the prompt hash (the prompt fully identifies the
// phase + its inputs) makes complete() CONTENT-ADDRESSED like embed(): each phase
// pops the response recorded for ITS exact prompt, never a sibling phase's. The
// hash arg is optional for backward compatibility — omitted yields the legacy
// shared key (a non-hashed caller still works, just without phase isolation).
export function completeKey(provider: string, promptSha256?: string): string {
  return promptSha256 ? `${provider}:complete:${promptSha256}` : `${provider}:complete`;
}
export function embedKey(provider: string, textSha256: string): string {
  return `${provider}:embed:${textSha256}`;
}

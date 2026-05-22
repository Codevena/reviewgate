// src/cassette/matching.ts
import { createHash } from "node:crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// review() entries are keyed by the reviewerId the orchestrator passes
// ("<provider>-<persona>" for the panel, "critic-<provider>" for the critic) →
// FIFO per key. complete() has no persona → one queue per provider. embed() is a
// pure function of its text → content-addressed (order-independent, dedup-friendly).
export function reviewKey(reviewerId: string): string {
  return reviewerId;
}
export function completeKey(provider: string): string {
  return `${provider}:complete`;
}
export function embedKey(provider: string, textSha256: string): string {
  return `${provider}:embed:${textSha256}`;
}

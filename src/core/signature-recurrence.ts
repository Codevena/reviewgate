// src/core/signature-recurrence.ts
// #5: detect a single BLOCKING finding that recurs across consecutive reviewed
// iterations (a treadmill the whole-set stuck-signatures check misses). Pure.
// `history` is the per-iteration finding-signature lists (state.signature_history);
// `blocking` is the CURRENTLY-blocking (CRITICAL/WARN) signatures from pending.json.

// Signatures in `blocking` present in EVERY one of the last `threshold` rows of
// `history`. Returns [] if threshold < 1 or history has fewer than `threshold` rows.
// An empty/ERROR row (lacking the signature) breaks its streak. Sorted + unique.
export function recurringBlockingSignatures(
  history: string[][],
  blocking: Set<string>,
  threshold: number,
): string[] {
  if (threshold < 1 || history.length < threshold) return [];
  const window = history.slice(-threshold).map((row) => new Set(row));
  const out: string[] = [];
  for (const sig of blocking) {
    if (window.every((row) => row.has(sig))) out.push(sig);
  }
  return out.sort();
}

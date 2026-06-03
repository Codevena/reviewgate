// Maintainer-authored repo "house rules" injected as TRUSTED reviewer context. Unlike the
// diff/corpus/finding-text (untrusted, neutralised), these come from reviewgate.config.ts —
// the maintainer controls them, so they are ground truth and need no injection defence. The
// durable fix for a recurring, signature-FRAGMENTED hallucination class that the FP-ledger
// can never promote (field 2026-06-03: the hex-vs-HSL cluster — 16 candidate FPs, each a
// different rule_id, each 1 reject → never reaches the promotion threshold): one house rule
// ("this repo uses hex tokens, not HSL") suppresses the whole class AT THE SOURCE — the
// reviewer never hallucinates it. The full config is already hashed into the cache key, so a
// changed rule set invalidates cached verdicts automatically.
export function renderHouseRules(rules: string[]): string {
  const clean = rules.map((r) => r.trim()).filter((r) => r.length > 0);
  if (clean.length === 0) return "";
  return [
    "## Repo house rules (TRUSTED — system instruction, not diff data)",
    "Authoritative facts/conventions for THIS repo, set by the maintainer. Treat them as",
    "ground truth: never raise a finding that contradicts a rule below.",
    ...clean.map((r) => `- ${r}`),
  ].join("\n");
}

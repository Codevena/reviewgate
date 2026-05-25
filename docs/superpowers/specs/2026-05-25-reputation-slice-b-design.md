# Reputation Slice B: Persona-Granularity — Design Spec

**Status:** approved 2026-05-25 (brainstorming). Next: implementation plan.

**Goal:** Key reviewer reputation by **`provider:persona`** instead of bare `provider`, so a
provider's noisy persona (e.g. `codex:adversarial`) no longer drags down its reliable persona
(`codex:security`) and vice-versa. Demote-only, all Slice 1 invariants preserved.

**Non-goals:** changing the scoring math, the consensus rule, the demote policy, or the config
defaults; quarantine (Slice C); cross-repo reputation; migrating old reputation data.

Builds on `[[2026-05-25-reviewer-reputation-design]]` (Slice 1) and
`[[2026-05-25-reputation-slice-a-design]]` (Slice A). Related memory:
`[[project_reviewer_reputation]]`.

---

## 1. Key change: `provider` → `provider:persona`

Reputation is currently keyed by bare `provider` (`reputation.json` `reviewers` map; the
`repUnreliable` set in the aggregator). Slice B switches the key to the composite
**`provider:persona`** string — single colon, identical to the `reviewerKey` the aggregator
already computes for clustering/consensus (`aggregator.ts:184`:
`` `${f.reviewer.provider}:${f.reviewer.persona}` ``).

**Schema:** unchanged. `ReputationSchema.reviewers` is already a generic
`z.record(z.string(), ReputationEntrySchema)` (`schemas/reputation.ts:13`) — only the *values*
of the keys change. No schema migration field.

**Soft-reset of existing data (decided):** old bare-`provider` keys (e.g. `"codex"`) carry no
persona segment. They are made inert **explicitly** — `unreliableReviewers` and `forDoctor`
skip any key that does not contain a `:` (a legacy bare-provider key), so a leftover `"codex"`
key can neither demote a finding (its key space never intersects the `provider:persona`
`confirmed_by` keys anyway) **nor** show a phantom row in `doctor`. Their events also age out via
time-decay + Slice-A pruning. No migration code — the persona of historical events is not
reconstructable, and reputation is advisory, demote-only, and neutral-start, so a brief
re-learning window is acceptable. (The discriminator relies only on the fact that **provider
IDs are a fixed enum with no colon** — `codex|gemini|claude-code|openrouter|opencode` — so a
legacy bare-provider key never contains `:`, while a composite `provider:persona` key always
does. Personas are free config strings, so the second colon-segment isn't schema-constrained,
but that doesn't affect the discriminator: `key.includes(":")` separates legacy provider IDs
from composite keys regardless of the persona's content.)

**`eid`:** the event-id appends the composite key as its trailing segment —
`${sessionId}:${cycleSeq}:${iter}:${finding_id}:${verdict}:${provider}:${persona}` (today it
ends in `:${provider}`). The `eid` is an opaque dedup string (never parsed back), so appending
the persona segment is safe; new eids do not collide with old bare-provider eids, consistent
with the soft-reset.

## 2. Contributor keys from `confirmed_by` (Approach A)

The set of distinct `provider:persona` reviewers that contributed to a finding is **already
computed and persisted**: the aggregator stores it in `finding.confirmed_by` (set from the
cluster's `reviewers` array — a deduped list of `reviewerKey` strings — at `aggregator.ts:238`).
`confirmed_by` is serialized into `pending.json` by the report-writer
(`JSON.stringify(report)`, `report-writer.ts:148`) and read back raw (no schema strip) by
`learn.ts`. So no new field on `finding.members[]` is needed.

**`learn.ts` (`learnReputationFromDecisions`):** replace the provider-set derivation
```ts
const providers = [f.reviewer?.provider, ...(f.members ?? []).map((m) => m.provider)]
  .filter((p): p is string => typeof p === "string" && p.length > 0);
for (const provider of new Set(providers)) { events.push({ provider, … }); }
```
with a `confirmed_by`-based one:
```ts
const repKey = (f: Finding) =>
  f.reviewer ? `${f.reviewer.provider}:${f.reviewer.persona}` : null;
const keys =
  f.confirmed_by && f.confirmed_by.length > 0
    ? f.confirmed_by
    : [repKey(f)].filter((k): k is string => !!k);
for (const reviewerKey of new Set(keys)) {
  events.push({ reviewerKey, outcome, eid: `…:${reviewerKey}`, ts: nowIso });
}
```
`confirmed_by` is already deduped, but the `new Set` guards the representative-fallback path and
any malformed input. The fallback (`provider:persona` from the representative) covers a persisted
finding that somehow lacks `confirmed_by` (always set by `aggregate()`, but defensive).

**`aggregator.ts` reputation demote-pass (`aggregator.ts:339-360`):** replace the provider list
```ts
const provs = [f.reviewer.provider, ...(f.members?.map((m) => m.provider) ?? [])];
if (!provs.every((p) => repUnreliable.has(p))) return f;
```
with the `confirmed_by` keys (matching the same key space as the store):
```ts
const keys =
  f.confirmed_by && f.confirmed_by.length > 0
    ? f.confirmed_by
    : [`${f.reviewer.provider}:${f.reviewer.persona}`];
if (!keys.every((k) => repUnreliable.has(k))) return f;
```
All other guards (INFO untouched, `unanimous`/`majority` return early, `touchesSecurityOrCorrectness`
exemption, one-step `DEMOTE`) are unchanged.

## 3. Renames (honesty — values are no longer bare providers)

- `store.ts` `RecordInput.provider` → **`reviewerKey`** (string, holds `provider:persona`).
- `store.ts` `unreliableProviders(cfg, now): Set<string>` → **`unreliableReviewers(cfg, now): Set<string>`** (returns composite keys). Internals (`derive`, the `Object.keys(rep.reviewers)` loop) are renamed from `provider` to `reviewer`/`reviewerKey` locals. **Skip legacy keys:** within the loop, `continue` on any key that does not contain `:` (a bare-provider key from before Slice B) so it never enters the returned set.
- `store.ts` `forDoctor` row field `provider` → **`reviewer`** (composite key string). **Skip legacy keys** the same way — `forDoctor` only emits rows for keys containing `:`, so a leftover bare-provider key shows no phantom row.
- `orchestrator.ts`: call site `.unreliableProviders(...)` → `.unreliableReviewers(...)`; the local/`AggregateInput` field stays **`repUnreliable`** (already generic). Update its doc comment to say "provider:persona keys".
- `score.ts`: **no change** — it is pure event math (`decayedCount`/`trustScore`/`isUnreliable`/`RepDerived`) and never references `provider`.
- `schemas/reputation.ts`: **no change** (generic `reviewers` record).

## 4. Doctor

`reputationCheck` (`doctor.ts:167-185`) renders each `forDoctor` row; change `${r.provider}` →
`${r.reviewer}`. The composite key is already human-readable, so it shows e.g.
`codex:security 8✓/2✗ (trust 0.79) ⚠ demoting` — **no splitting needed**. Status logic
(`warn` when any row is `demoting`) unchanged.

## 5. Config

Defaults unchanged: `phases.reputation = { enabled: true, minSamples: 8, trustFloor: 0.35,
halfLifeDays: 45 }`. They now apply **per `provider:persona`** — each persona accumulates
samples independently, so the neutral-start (`minSamples`) window is reached later per persona.
This is intentionally conservative (more evidence before acting). No new config knob.

## 6. Preserved invariants & interactions

- **Demote-only**, one step, never below INFO, never security/correctness, never corroborated —
  all unchanged (§2).
- **Consensus alignment:** `computeConsensus` already counts distinct `provider:persona`
  (`reviewers.length`), the exact key space reputation now uses. Since the demote-pass returns
  early on `unanimous`/`majority`, persona-keyed reputation can only bite on `singleton`/`minority`
  findings — i.e. effectively one contributing `provider:persona`. The pre-existing behavior
  "one provider running two personas that both flag a finding → `majority` → never demoted" is
  **unchanged** (it is consensus logic, out of scope here).
- **Anti-abuse:** unchanged — learning still derives keys ONLY from panel-authored
  `confirmed_by` / `reviewer` on real `pending.json` findings, never from agent-authored decision
  lines; the agent cannot fabricate a `provider:persona`.

## 7. Testing

TDD. Reproduce the persona-granular scenario first:
- **learn credits/debits per `provider:persona`:** two personas of the same provider in one
  finding's `confirmed_by` (`codex:security`, `codex:architecture`) produce two distinct keys.
- **learn fallback:** a finding without `confirmed_by` falls back to the representative's
  `provider:persona`.
- **aggregator demote:** an unreliable `codex:security` demotes its lone non-security CRITICAL to
  WARN; the same finding is NOT demoted if a reliable `codex:architecture` also contributes
  (which would also make it corroborated → already exempt — assert both the corroboration exit
  and, via a singleton case, that a reliable lone key is not demoted).
- **security/correctness exemption** still holds for an unreliable persona.
- **store:** `unreliableReviewers` returns composite keys; record/dedup/prune work on composite
  keys (Slice-A pruning unaffected).
- **doctor:** renders a per-`provider:persona` row + `⚠ demoting`.
- **soft-reset:** seed a `reputation.json` with a below-floor legacy bare `"codex"` key →
  `unreliableReviewers` excludes it (no `:`), `forDoctor` emits no row for it, AND a finding with
  `confirmed_by: ["codex:security"]` is NOT demoted by it. (All three: store filter + structural
  key-space non-intersection.)
- Update existing Slice-1 reputation tests that asserted bare-`provider` keys/`unreliableProviders`
  to the composite-key API.
- Full suite green; `bunx tsc --noEmit` + `bun run lint` clean.

## 8. File map

- **Modify:** `src/core/reputation/learn.ts` (confirmed_by keys + eid), `src/core/reputation/store.ts`
  (rename `provider`→`reviewerKey`/`reviewer`, `unreliableProviders`→`unreliableReviewers`),
  `src/core/aggregator.ts` (demote-pass key source), `src/core/orchestrator.ts` (method rename +
  comment), `src/cli/commands/doctor.ts` (`r.provider`→`r.reviewer`).
- **No change:** `src/schemas/reputation.ts`, `src/schemas/finding.ts`, `src/core/reputation/score.ts`.
- **Tests:** `tests/unit/reputation-store.test.ts`, `tests/unit/reputation-learn.test.ts`,
  `tests/unit/aggregator-reputation.test.ts`, `tests/unit/doctor-reputation.test.ts`, and
  **`tests/unit/orchestrator.test.ts`** (has `RecordInput` object literals using `.provider`
  ~lines 175-181 and 215-221 that the `provider`→`reviewerKey` rename breaks — `tsconfig.json`
  includes `tests/**/*`, so these must be updated or typecheck fails). Grep the whole `tests/`
  tree for `unreliableProviders` and `provider:` RecordInput literals to catch any other site.

Related: `[[2026-05-25-reviewer-reputation-design]]`, `[[2026-05-25-reputation-slice-a-design]]`,
`[[project_reviewer_reputation]]`, `[[reference_critical_single_reviewer]]`.

# Reputation Slice C: Quarantine — Design Spec

**Status:** approved 2026-05-25 (brainstorming). Next: implementation plan.

**Goal:** Below a hard trust floor (well under the demote floor), **skip a reviewer entirely**
for the cycle — don't even run it — instead of merely demoting its findings. Saves time/quota on
a chronically-wrong reviewer. Opt-in, default OFF.

**Honest safety scope (important):** unlike the Slice-1 demote pass — which *never* demotes a
security/correctness finding — quarantine removes **all** of the skipped reviewer's findings,
including security/correctness CRITICALs (the reviewer didn't run, so they don't exist). Quarantine
**can therefore move a verdict toward PASS by omission.** This is an accepted, bounded opt-in risk
(see §4), not a "can never open the gate" guarantee. The justification: a reviewer below
`quarantineFloor` (0.15) has been confirmed wrong on ~85%+ of its findings over ≥`minSamples`
decisions, so its findings — security included — are no longer credible *here*; the operator opts
in to stop trusting that source.

**Non-goals:** changing the scoring math, the demote pass (Slice 1), the persona keying (Slice B),
or consensus; cross-repo reputation; a setup-wizard toggle; emitting a full `ESCALATION.md`
(surfacing is a report note + `console.warn`).

Builds on Slice 1 (`[[2026-05-25-reviewer-reputation-design]]`), Slice A
(`[[2026-05-25-reputation-slice-a-design]]`), Slice B
(`[[2026-05-25-reputation-slice-b-design]]`). Implements "Use Option 2" from
`docs/design/reviewer-reputation.md`. Related: `[[project_reviewer_reputation]]`,
`[[reference_critical_single_reviewer]]`, `[[project_gate_fail_open]]`.

---

## 1. Trigger & threshold

Reputation is keyed by `provider:persona` (Slice B). A reviewer is **quarantined** iff
`samples >= minSamples` **and** `trust < quarantineFloor`, where `quarantineFloor`
(default **0.15**) is well below the demote `trustFloor` (0.35). Therefore *quarantined ⊂
unreliable*: a reviewer with trust in [0.15, 0.35) is only **demoted** (Slice 1), never skipped.

**Store (`store.ts`) — DRY refactor.** Extract the shared loop into a private helper and have both
queries call it:
```ts
private async reviewersBelow(floor: number, cfg: ReputationConfig, now: Date): Promise<Set<string>> {
  const rep = await this.snapshot();
  const out = new Set<string>();
  for (const reviewerKey of Object.keys(rep.reviewers)) {
    if (!reviewerKey.includes(":")) continue; // legacy bare-provider key → inert (Slice B)
    if (isUnreliable(this.derive(reviewerKey, rep, now, cfg.halfLifeDays), cfg.minSamples, floor))
      out.add(reviewerKey);
  }
  return out;
}
async unreliableReviewers(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
  return this.reviewersBelow(cfg.trustFloor, cfg, now);
}
async quarantinedReviewers(cfg: ReputationConfig, now: Date, floor: number): Promise<Set<string>> {
  return this.reviewersBelow(floor, cfg, now);
}
```
`unreliableReviewers` keeps its exact prior behavior (Slice-1/B tests stay green); only the body is
deduped.

## 2. Mechanism — drop the slot before the run loop

A new **pure, isolated** module `src/core/reputation/quarantine.ts`:
```ts
export interface QuarantineResult<R> {
  active: R[];          // reviewers to actually run this cycle
  dropped: string[];    // reviewer keys skipped (provider:persona)
  usedFullFallback: boolean; // true when filtering would empty → ran full panel anyway
}
export function selectActiveReviewers<R>(
  activeReviewers: R[],
  quarantined: Set<string>,
  keyOf: (r: R) => string,
): QuarantineResult<R> {
  if (quarantined.size === 0) return { active: activeReviewers, dropped: [], usedFullFallback: false };
  const active = activeReviewers.filter((r) => !quarantined.has(keyOf(r)));
  const dropped = activeReviewers.filter((r) => quarantined.has(keyOf(r))).map(keyOf);
  if (active.length === 0) {
    // Filtering would empty the panel → run the FULL panel this cycle (quarantine yields).
    return { active: activeReviewers, dropped: [], usedFullFallback: true };
  }
  return { active, dropped, usedFullFallback: false };
}
```

**Orchestrator wiring** (`orchestrator.ts`): `activeReviewers` is currently `const` at line ~490 and
consumed by the `tasks` map at line ~593. Do NOT mutate it — derive a `panelReviewers`. **Reuse the
single `repCfg`** the function already declares for the demote pass (line ~880,
`const repCfg = this.input.config.phases.reputation`): **hoist that one declaration up** to before
the run loop and reference it in both places — do NOT declare a second `const repCfg` (duplicate
block-scoped identifier = compile error).
```ts
// repCfg hoisted here (was declared at ~880 for the demote pass; now one declaration serves both)
const repCfg = this.input.config.phases.reputation;
let panelReviewers = activeReviewers;
let panelNote: string | undefined;
if (repCfg?.enabled && repCfg.quarantine?.enabled) {
  const quarantined = await new ReputationStore(repo)
    .quarantinedReviewers(repCfg, now, repCfg.quarantine.floor)
    .catch(() => new Set<string>());
  const keyOf = (r: { provider: string; persona: string }) => `${r.provider}:${docPersona ?? r.persona}`;
  const sel = selectActiveReviewers(activeReviewers, quarantined, keyOf);
  panelReviewers = sel.active;
  if (sel.usedFullFallback) {
    panelNote = "⚠ All configured reviewers are quarantined (reputation below floor) — ran the full panel anyway this cycle. Review/replace these reviewers.";
    console.warn(`[reviewgate] ${panelNote}`);
  } else if (sel.dropped.length > 0) {
    panelNote = `Quarantined (skipped) this cycle — reputation below floor: ${sel.dropped.join(", ")}`;
    console.warn(`[reviewgate] ${panelNote}`);
  }
}
```
Then the `tasks` map uses `panelReviewers` instead of `activeReviewers`. The key uses
`docPersona ?? r.persona` — the persona that actually runs — so it matches the `provider:persona`
reputation key. (`now` already exists at line ~587; quarantine reads happen before the run loop.)

Best-effort: a failed store read → empty set → no quarantine (never breaks a review).

## 3. Empty-panel fallback (safety)

When filtering would leave **zero** reviewers, `selectActiveReviewers` returns the FULL list with
`usedFullFallback:true`. The cycle runs every reviewer (quarantine yields), sets the `panelNote`
warning, and `console.warn`s. Backstop: the Slice-1 demote pass still down-weights those reviewers'
lone non-security findings. **Never** un-reviewed, **never** a permanent hard block.

## 4. Safety & anti-abuse

- **Default OFF** (`quarantine.enabled:false`) → zero behavior change unless opted in; existing
  behavior tests unaffected. This is the primary bound.
- **Accepted risk — quarantine CAN move a verdict toward PASS by omission.** Removing a reviewer
  removes its findings, INCLUDING security/correctness CRITICALs (which the demote pass never
  suppresses). This is the deliberate trade of "skip entirely" and the reason it is opt-in. It is
  bounded by:
  - **Expensive to earn:** sustained `trust < 0.15` over `>= minSamples` (8) decayed events — the
    reviewer has been confirmed wrong on ~85%+ of its findings *here*, so its findings (security
    included) are no longer credible. Quarantine formalizes "this source is not trustworthy here."
  - **Other reviewers still run** — only the confirmed-bad `provider:persona` is skipped; the rest
    of the panel (and their security findings) are unaffected.
  - **Empty-panel fallback:** if skipping would empty the panel, the full panel runs anyway (NOT the
    0-run ERROR) — so no un-reviewed pass and no permanent block.
  - **Reversible:** decays/recovers; auto-clears when the reviewer climbs back above the floor.
- **Panel-shrink interactions preserved:** shrink to 1 reviewer → the singleton-CRITICAL hard-FAIL
  rule still blocks a lone CRITICAL (`[[reference_critical_single_reviewer]]`); the per-cycle
  reject-rate / fp-streak escalations still fire on sustained mass-rejection.
- **Legacy keys** are already inert (Slice-B `:` filter, inherited via `reviewersBelow`).

## 5. Config

Nested under `phases.reputation` (zod `.default`):
```ts
phases.reputation = {
  enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45,
  quarantine: { enabled: false, floor: 0.15 },
}
```
`floor`: `z.number().min(0).max(1).default(0.15)`. `enabled`: `z.boolean().default(false)`. The
orchestrator guard requires BOTH `reputation.enabled` AND `reputation.quarantine.enabled`, so
disabling reputation also disables quarantine. **Not** surfaced in the setup wizard (config-file
only, like the tuning knobs) given default-off + the elevated risk.

## 6. Report surfacing

Add an optional `panel_note?: z.string()` to `PendingReportSchema`. `Orchestrator.writeReport`
gains a trailing optional `panelNote?: string` param. **Pass `panelNote` to BOTH** the main-panel
write (line ~906) **AND the zero-ok ERROR write (line ~809/812)** — a quarantine/full-fallback run
whose remaining reviewers all error exits via the zero-ok ERROR path first, and the note must not be
lost exactly when the panel was degraded. (Compute `panelNote` before the run loop so it is in scope
at both writes.) Other call sites (early triage ERROR/PASS, cache) omit it (optional). `ReportWriter`
renders it as a prominent line near the top of `pending.md` (above the findings) so the agent sees
why the panel shrank. This is the "escalation": agent-visible report note + operator `console.warn`.

## 7. Doctor

`forDoctor` rows gain a `quarantined: boolean` (true when `samples >= minSamples && trust <
quarantineFloor`), computed only when `quarantine.enabled` (else always false). `reputationCheck`
appends `⛔ quarantined` to a row's line (in addition to `⚠ demoting`). Since quarantined ⊂
unreliable, a quarantined reviewer also shows `demoting`; render both markers. Status stays `warn`.

## 8. Testing

TDD. Reproduce the skip scenario first:
- **store:** `quarantinedReviewers(cfg, now, 0.15)` returns a reviewer with trust < 0.15 and
  `>= minSamples`; a reviewer with trust in [0.15, 0.35) is NOT quarantined (only unreliable);
  legacy bare keys excluded; the `reviewersBelow` refactor leaves `unreliableReviewers` behavior
  identical (existing tests green).
- **quarantine.ts (pure):** `selectActiveReviewers` drops quarantined slots; empty result →
  `usedFullFallback:true` returning the full list + empty `dropped`; empty quarantine set → identity.
- **orchestrator:** with `quarantine.enabled` and a seeded sub-floor `codex:security`, the codex
  slot does NOT run (no codex finding, `panel_note` lists `codex:security`); with quarantine
  disabled (default) the slot runs as before; all-quarantined → full panel runs + the
  full-fallback `panel_note`.
- **config-shape + diff-serialize:** `phases.reputation.quarantine` default `{enabled:false,
  floor:0.15}`; disabling/enabling serializes correctly; `defineConfig({})` includes it.
- **doctor:** `⛔ quarantined` marker renders when a reviewer is below the quarantine floor and
  quarantine is enabled.
- Full suite green; `bunx tsc --noEmit` + `bun run lint` clean. (The known intermittent
  `runDoctor` timeout flake is unrelated — re-run once if it flakes.)

## 9. File map

- **Modify:** `src/core/reputation/store.ts` (`reviewersBelow` refactor + `quarantinedReviewers`),
  `src/core/orchestrator.ts` (derive `panelReviewers` + `panelNote`, pass to `writeReport`),
  `src/config/define-config.ts` + `src/config/defaults.ts` (`quarantine` section),
  `src/cli/commands/doctor.ts` (`⛔` marker), `src/core/reputation/store.ts` `forDoctor`
  (`quarantined` flag), `src/schemas/pending-report.ts` (`panel_note`),
  `src/core/report-writer.ts` (render `panel_note`).
- **Create:** `src/core/reputation/quarantine.ts` (pure `selectActiveReviewers`).
- **No change:** `score.ts`, `finding.ts`, `learn.ts`, `aggregator.ts` (quarantine is orchestrator-
  side; the demote pass is untouched).
- **Tests:** `tests/unit/reputation-store.test.ts`, new `tests/unit/reputation-quarantine.test.ts`,
  `tests/unit/orchestrator.test.ts`, `tests/unit/doctor-reputation.test.ts`,
  `tests/unit/config-diff-serialize.test.ts`, and **`tests/unit/reputation-config.test.ts`** (its
  "enabled by default with the spec's defaults" and "validates and is overridable" cases assert the
  exact `phases.reputation` shape → must include the new `quarantine` default `{enabled:false,
  floor:0.15}`). Grep `tests/` for `phases.reputation` / `reputation:` config literals to catch any
  other shape assertion.

Related: `[[2026-05-25-reviewer-reputation-design]]`, `[[2026-05-25-reputation-slice-b-design]]`,
`[[reference_critical_single_reviewer]]`, `[[project_gate_fail_open]]`,
`[[project_reviewer_reputation]]`.

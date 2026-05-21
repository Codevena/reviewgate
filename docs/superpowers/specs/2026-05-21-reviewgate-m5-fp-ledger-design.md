# Reviewgate M5 — False-Positive Reduction (Diff-Scoping + FP-Ledger)

**Status:** design v2 (approved in brainstorming 2026-05-21; revised after a Codex design review). Supersedes the FP-Ledger sketch in §5.7 of `2026-05-20-reviewgate-design.md` where they differ (demote-to-INFO instead of hard-filter; decisions-gate scoped to blocking severities).

## Problem

The live T1–T13 series (2026-05-21) showed the panel's dominant failure mode is **false positives on UNCHANGED code** — findings far from the diff, including a hallucinated line 389 in a 362-line file, and a minority CRITICAL FP that forced a gate block (T7). Two causes:

1. **Scoping:** reviewers get full changed-file content (needed for symbol resolution) but report issues anywhere in the file. The existing prompt instruction alone does not stop it.
2. **No memory of past FPs:** a rejected false positive recurs every run; nothing learns from `reviewer_was_wrong:true` rejections.

M5 addresses both: **Part A — Diff-Scoping** (deterministic, default ON) and **Part B — FP-Ledger** (learning subsystem, opt-in).

## Cross-cutting prerequisite — the decisions-gate must scope to blocking severities

**Both parts demote findings to INFO. For that to actually relieve the agent, the decisions-gate must stop requiring decisions for INFO findings.** Today `LoopDriver.previousFindingIds()` returns every finding id from `pending.json`, and after a FAIL `allDecisionsAddressed()` requires a decision for each — so a demoted/suppressed finding would still have to be re-rejected every failing iteration, defeating the whole feature.

**Fix (lands first, in Phase A):** `previousFindingIds()` returns only findings whose (post-aggregation) severity is **CRITICAL or WARN**. INFO is advisory and never blocks the verdict, so it must not carry a decision obligation. Because Part A (out-of-diff) and Part B (FP match) both demote to INFO, demoted/suppressed findings are then automatically excluded from the required-decision set — no special-casing needed. This is a small, principled change ("address what blocks you, not every advisory note") and is a precondition for the rest of M5.

## Part A — Diff-Scoping (default ON, configurable)

A new aggregator stage `scopeToDiff` demotes findings outside the changed hunks to **INFO** (advisory, non-blocking) — never drops, so cross-impact bugs stay visible.

- **Input:** changed-line ranges per file. Parsed from `collectDiff()` output, which is `git diff HEAD` plus, for untracked files, `git diff --no-index /dev/null <file>`. The parser must:
  - read **file metadata** (the `--- ` / `+++ ` headers), not only hunk headers, to detect **new files** (`--- /dev/null` old-side → every new-file line counts as changed) and **deletions** (`+++ /dev/null` new-side → no new-file lines). Tolerate Git's header variants: `+++ b/path`, `+++ path`, quoted paths (`"+++ b/p ath"`), and rename headers — key off the `b/`-side path / `/dev/null` sentinel robustly.
  - collect **independent `+c,d` ranges** per hunk (multi-hunk files), where the changed new-file lines are `[c, c+d)`.
  - treat a **`+c,0`** (deletion-only) hunk as contributing **no** changed lines.
  - **normalize the parsed path to match `Finding.file` exactly** — findings are repo-relative after `mapReviewOutputToFindings()`, so strip `a/`/`b/` prefixes and resolve to the same repo-relative form before matching. Use a dedicated parser with fixture coverage, not header regex alone.
- **Rule per finding — RANGE intersection, not `line_start` alone:** if the finding's `[line_start, line_end]` range **overlaps** any changed new-file range of `finding.file` → keep severity. (Reviewers often anchor a multi-line finding to a declaration line above the edited hunk; range-intersection avoids demoting a real diff-induced finding whose body overlaps the change.) No overlap → severity := INFO, set `scope_demoted: true`, append a `details` note. A finding on a file with no new-file lines (pure deletion) or with no usable line → **keep** (conservative; never hide).
- **Order:** runs in the aggregator after critic-demote, before verdict; composes with the FP-ledger demote (Part B).
- **Prompt:** tighten the reviewer preamble — "report issues introduced or affected by THIS diff; pre-existing issues in unchanged code are out of scope."
- **pending.md / report-writer:** `renderMd()` currently instructs "append a decision for EACH finding below" and renders every severity in one flow. Phase A MUST (a) render `scope_demoted` / `fp_ledger_match.suppressed` findings in a separate clearly-marked **"Advisory (out of scope / known FP — no decision needed)"** section, and (b) change the decision instruction to apply only to the blocking (CRITICAL/WARN) findings — otherwise agents keep writing rejections for advisory findings, which then feed the ledger.
- **Config:** `phases.review.scopeToDiff` (default `true`; `false` disables the stage).
- **Schema:** add `Finding.scope_demoted?: boolean`.

## Part B — FP-Ledger (opt-in, `phases.fpLedger`)

Signature-based learning from rejected false positives. Storage: `.reviewgate/learnings/known_fp.jsonl` (committed). Match key = the **existing finding signature** (`computeSignature`: file | rule | category | symbol | offset-bucket) — precise and safe against repo-wide over-suppression, reuses M3 infrastructure.

**Signature reliability (honest):** the signature is symbol-relative and line-bucketed, so it survives small in-symbol line shifts — but it is NOT a durable fingerprint, and because it includes the **reviewer-controlled** `rule_id` and `category`, the SAME issue named differently by a different reviewer produces a different signature and misses the ledger. (The aggregator deliberately tolerates that naming variation by merging — see "merge provenance" below — so suppression rates should be expected to be modest in v1, not high.) Function renames, unsupported-language churn, or an edit crossing an offset bucket also miss. This is acceptable for a conservative v1: a miss just re-shows a finding the user can re-reject; it never over-suppresses. Recording **per-member signature aliases** from merged findings (below) is the natural v2 lever to raise the hit rate; fuzzy rule+symbol matching remains an explicit **non-goal for now** (over-suppression risk).

### Schema (`src/schemas/fp-ledger.ts`)
`FpLedgerEntry`: `id`, `signature` (match key), `rule_id`, `category`, `file`, `symbol`, `stage` (`candidate|active|sticky`), `rejects: [{run_id, provider, ts, reason}]`, `distinct_providers: string[]`, `first_seen_at`, `last_seen_at`, `pinned_by?`, `linked_brain_id?` (Phase B3), `created_at`.

### Store (`src/core/fp-ledger/store.ts`)
Locked, atomic `known_fp.jsonl` access (mirrors state-store/brain-store): `snapshot`, `recordReject(...)`, `pin/unpin`, `decayPass(nowIso)`.

### Merge provenance (prerequisite for correct learning)
The aggregator no longer dedups by signature — it **clusters** findings by file + 5-line region OR high lexical similarity, so one representative finding can absorb members with **different** `rule_id`/`category`/signature, while `confirmed_by` accumulates ALL members' reviewers. Recording a reject against the representative signature + all `confirmed_by` providers would therefore credit cross-provider quorum to a signature some providers never emitted → **false promotion**. Fix: the aggregator must persist per-member provenance on each finding — `members: [{signature, provider, rule_id, category}]` where `provider` is the member's trusted `reviewer.provider`. The learn path then attributes a reject **per distinct member-signature with only the providers that actually emitted that signature**, so the ≥2-provider quorum is per-signature-accurate. (These member signatures are also the aliases referenced in "signature reliability" above.) Adds `Finding.members?: [...]`.

### Learn path — exact placement & invariant
Runs at the **start of `runIteration(opts)`**, BEFORE triage-skip / cache / error report writes and BEFORE the panel — i.e. before anything can overwrite `pending.json`. (Every early-return branch — cache hit, triage skip, sandbox-error, reviewer-error — must run learn first or be proven not to write a report before it; tested explicitly.) It reads:
- `decisions/<opts.iter − 1>.jsonl` (the previous iteration's decisions — `opts.iter − 1`, never `opts.iter`), and
- the current `pending.json` (still the previous iteration's report at this point),

resolving each `verdict:rejected` + `reviewer_was_wrong:true` decision to the rejected finding, then — via that finding's `members` provenance — recording a reject **per member-signature** crediting only the `reviewer.provider`(s) that emitted it. If `opts.iter` is 1 (no previous decisions) the learn path is a no-op. **Note:** because the decisions-gate only requests decisions for blocking (CRITICAL/WARN) findings, the ledger learns automatically only from rejected *blocking* findings — already-demoted advisory findings generate no decision. That is intended; `reviewgate fp pin` is the manual path for advisory noise. Lifecycle:

| Stage | Promotion | Effect |
|---|---|---|
| `candidate` | 1st reject with `reviewer_was_wrong:true` | logged only, NOT applied |
| `active` | 3 rejects within 60 days across **≥2 distinct providers** | applied (below) |
| `sticky` | 5 rejects within 90 days, OR `reviewgate fp pin` | as active, never auto-expires |

`decayPass`: candidate removed after 90d with no new match; active reverts to candidate after 180d; sticky never expires.

### Anti-poisoning — count distinct providers from the TRUSTED reviewer field
Do NOT derive provider identity by string-parsing `confirmed_by` (shaped `provider:persona`) — that invites the colon/hyphen ambiguity Codex flagged (`openrouter:security` vs `:architecture`; `claude-code` collapsing to `claude`). Instead, build `members` provenance and the ≥2-provider quorum from the **trusted `Finding.reviewer.provider` field** (a clean base-provider id the orchestrator already stamps from the configured `ProviderId`). No persona parsing, no fragile normalizer. `distinct_providers` stores these `reviewer.provider` ids. A single provider running multiple personas therefore counts once per signature; quorum requires ≥2 distinct `reviewer.provider`s that each emitted that member-signature. (If a path ever only has `confirmed_by` strings available, route through ONE canonical helper — but the trusted field makes that unnecessary here.)

### Apply path (only `active`/`sticky`)
- **Proactive — negative few-shot:** entries matching the changed files are injected into the reviewer preamble ("Known false positives in this repo — do NOT re-report: …"), token-budget-aware (like brain context).
- **Reactive — aggregator stage:** findings whose signature matches an active/sticky entry → **demote to INFO + set `fp_ledger_match {pattern_id, matched_count, suppressed:true}`**. Combined with the decisions-gate fix above, the demoted finding no longer blocks NOR requires a decision, while remaining visible in the pending.md advisory section. (Deliberately not a hard filter — visibility over silence; consistent with Part A.)

### Cache — ordering contract
The review cache key already folds a `brainActiveHash` into `computeCacheKey()`'s `providerVersions`. M5 extends this into a **single combined behavior hash** (brain + FP), computed **after** FP learn/decay and brain pinning, **before** the cache read, from the **exact** active/sticky snapshot used for few-shot injection and aggregator demotion — so a reject learned at the start of the run cannot be bypassed by a stale cache hit. The FP contribution MUST cover every behavior-affecting field — at least `{signature, stage}` per active/sticky entry, NOT just `id:status` (the brain's weaker pattern would let a change slip past the cache). Do not append ad-hoc; route both brain and FP through one structured behavior-hash. Test: a newly-`active` FP invalidates a previously-cached SOFT-PASS/PASS.

### Safety
- `active` requires ≥2 distinct `reviewer.provider`s (above).
- `reviewgate fp audit` lists active entries grouped by first-seen provider for periodic human review.
- High-reject-rate escalation already exists as a LoopDriver `reject-rate-high` reasonCode; wire/verify it.

### CLI (`src/cli/commands/fp.ts`)
`fp list` · `fp show --id <id>` · `fp pin --id <id> | --signature <sig>` · `fp unpin --id <id>` · `fp audit`. Flag style `--id`, matching the brain CLI. **`fp pin` means "non-blocking advisory", NOT "hidden"** — a pinned FP still appears in pending.md's advisory section (visibility over silence). Document this in the CLI help so users don't expect pin to remove output; a true `--hide` flag is a possible later addition, not v1.

### Phase B3 — Brain ↔ Ledger coupling
On promotion to `active`, invoke the Curator once to optionally create a paired Brain `convention` entry (the human-readable WHY). Cross-link `linked_brain_id` ↔ `linked_fp_id`. Curator cross-checks each new FP entry against existing brain entries for contradiction.

## Data flow (additions to `Orchestrator.runIteration`)
Current: triage → cache check → research → panel → critic → aggregate → report.
1. **FP-ledger learn + decay** at the very start (before triage-skip/cache/error writes); compute the active/sticky snapshot.
2. **fp_ledger_active_hash** folded into the cache key (from that snapshot) before the cache read.
3. **FP few-shot** injected in the prompt build (alongside brain context), from that snapshot.
4. Aggregate becomes a **stage chain:** cluster (now also records per-member `members` provenance) → critic-demote → **scopeToDiff (A)** → **fp-ledger-demote (B)** → verdict.
5. **active-promotion side-effect** (B3): Curator creates the paired brain entry, post-verdict, non-blocking.
LoopDriver `previousFindingIds()` filters to CRITICAL/WARN (the cross-cutting fix).

## Decomposition — one spec, 6 implementation phases
- **Phase A** — decisions-gate severity-scoping fix + Diff-Scoping (hunk parser + `scopeToDiff` range-intersection stage + prompt + config + `scope_demoted` + report-writer advisory section/wording). Ships the main observed win and the gate prerequisite.
- **Phase B0** — merge-provenance: persist `Finding.members` (with each member's trusted `reviewer.provider` + signature) in the aggregator. Pure prerequisite for correct, poison-safe learning; **B1 hard-depends on it** (without `members`, normal clustering makes the ledger poisonable). Small.
- **Phase B1** — FP-Ledger learn + reactive demote: schema, store, learn-from-decisions (per-member-signature attribution, timing/index per above), lifecycle, ≥2-distinct-`reviewer.provider` quorum, aggregator fp-demote stage.
- **Phase B2a** — proactive + cache: negative few-shot injection + the combined behavior-hash cache integration (below).
- **Phase B2b** — operability: CLI (`fp list/show/pin/unpin/audit`), `decayPass`, `reject-rate-high` trigger (concrete numerator/denominator over blocking findings only — currently just a reason-code type with no trigger logic).
- **Phase B3** — Brain↔Ledger coupling (paired convention, cross-refs, contradiction cross-check).

## Testing
All deterministic logic is unit-testable without an LLM:
- **Decisions-gate fix:** after a FAIL, an INFO/`scope_demoted`/`fp_ledger_match.suppressed` finding requires NO decision; CRITICAL/WARN still do.
- **Part A:** hunk-range parser (multi-hunk, header variants, `/dev/null` new file → all changed, deletion → none, `+c,0` → none); `scopeToDiff` **range-intersection** (range overlapping a hunk kept even if `line_start` is above it; fully-outside → INFO + `scope_demoted`; new file kept; no-line kept); integration: out-of-diff finding becomes INFO in pending.json.
- **Phase B0:** for a cross-`rule_id` merged cluster, the aggregator records correct `members` provenance — each member's own `signature` + trusted `reviewer.provider`.
- **Part B:** schema; store; lifecycle thresholds (active needs 3 rejects + ≥2 distinct `reviewer.provider`; **single provider — even multi-persona, even merged into a multi-provider cluster — NEVER promotes per its own signature**); per-member-signature attribution from a merged finding; signature matching + a documented-miss case; fp-demote aggregator stage; few-shot injection; decay expiry; cache-key invalidation + ordering; CLI.
- **Real e2e** (per the project's real-verification rule — the learn loop must be confirmed on the compiled binary): reject the same FP across 2 providers in flashbuddy → entry reaches `active` → demoted/few-shot-suppressed AND not requiring a decision on the next run.

## Non-goals
- Repo-wide rule suppression and fuzzy/template matching (over-suppression risk) — per-signature only for v1.
- Hard-dropping findings — everything demotes to INFO and stays visible in the advisory section.
- Model fine-tuning — learning is in-context (few-shot) only.

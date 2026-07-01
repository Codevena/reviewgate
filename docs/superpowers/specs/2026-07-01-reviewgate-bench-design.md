# `reviewgate bench` — design

- **Date:** 2026-07-01
- **Status:** Plan-Gate PASSED (Codex, 5 rounds). **P0 implemented** (schemas +
  matcher + 30 TDD tests, full suite 2199/0). P1–P5 pending.
- **Author:** Markus (via Claude)

## 1. Motivation

Reviewgate's entire pitch is *precision under a fail-closed veto*: a panel that
catches real bugs without drowning the agent in false positives. Months of work
have gone into the suppression stack — critic, reputation, FP-ledger, consensus,
confidence floor, self-refutation filter, hypothetical-severity guard. **But there
is no controlled number that proves any of it works.**

`reviewgate stats` already computes an *observational* precision =
`TP / (TP + FP)` from real dogfood decisions. That is valuable but confounded: it
depends on the host agent's accept/reject decisions, which are themselves noisy,
and it can only measure diffs that happened to be reviewed. It cannot measure
**recall** (bugs we missed leave no trace) and it cannot isolate the effect of a
single suppression layer.

`reviewgate bench` adds a **controlled** measurement against a labelled
ground-truth corpus: given diffs with known bugs (and known-clean diffs), report
precision, recall, false-positive rate, latency and cost — per provider and for
the aggregated panel — and let us **ablate** the suppression layers to show which
ones actually move the number.

This is also the single most-requested external-credibility artifact: a skeptic,
a prospective user, or an employer wants to see *numbers on a reproducible
corpus*, not prose about paranoia.

## 2. Goals / non-goals

**Goals**
- Measure panel + per-provider **precision, recall, FP-rate, latency, cost** on a
  labelled corpus.
- **Ablation**: run the same corpus with suppression layers toggled on/off and
  report the delta.
- Reproducible: the corpus ships in-repo; anyone can re-run and get comparable
  numbers.
- Reuse the existing one-shot review path (`Orchestrator` + `reportMode`), not a
  parallel pipeline.

**Non-goals (this milestone)**
- Not a public leaderboard or a hosted service.
- Not a statistically rigorous benchmark at launch — a 20–30 case bootstrap is a
  **smoke test**, and the tool must say so (see §9).
- Not auto-generating cases from live CVEs (mutation/CVE sourcing is a later
  phase; bootstrap is hand-written + git-history-derived).
- Does not change the gate's runtime behavior at all — `bench` is a read-only
  offline harness.

## 3. Corpus format

A corpus is a directory of independent cases:

```
bench/cases/
  sql-injection-001/
    case.json
    diff.patch
  refactor-extract-fn-004/
    case.json
    diff.patch
```

`case.json` (validated by a new `reviewgate.bench.case.v1` zod schema in
`src/schemas/`):

```jsonc
{
  "schema": "reviewgate.bench.case.v1",
  "id": "sql-injection-001",
  "kind": "seeded-bug",          // "seeded-bug" | "clean"
  "language": "ts",              // for triage/symbol-graph parity
  "expected": [                  // MUST be [] when kind === "clean"
    {
      "tag": "sql-injection",    // fuzzy keyword-match against finding text
      "file": "src/db.ts",
      "line": 42,                // anchor; matched within a ±window
      "min_severity": "critical" // finding severity must be >= this
    }
  ],
  "allowed": [                   // OPTIONAL: known real-but-incidental findings the
    { "tag": "unused-var", "file": "src/db.ts", "line": 40 }
  ],                             // fixture legitimately contains — scored NEUTRAL
                                 // (never TP, never FP). Addresses WARN-4.
  "strict_region": true,         // default for BOTH kinds: only findings whose
                                 // location falls inside the diff's changed hunks are
                                 // eligible to be FP; findings on unchanged
                                 // pre-existing code are NEUTRAL unless listed (§4).
                                 // A "clean" refactor does not prove the surrounding
                                 // file is defect-free, so a real pre-existing bug
                                 // outside the hunks must not be punished as an FP.
  "source": "hand-written",      // "hand-written" | "derived-from-cve" | "mutation"
  "notes": "classic string-concat query built from req.query.id"
}
```

`diff.patch` is a unified diff in the same shape `collectDiff` produces, so the
Orchestrator consumes it unchanged.

### Two case classes (the key design decision)

- **`seeded-bug`** — a diff that introduces exactly one (or a small known set of)
  real defect. Drives **recall** (was the planted bug caught?) and contributes to
  precision (of what we fired, how much was the plant vs. noise).
- **`clean`** — a *correct* change (a real refactor, rename, dependency bump) that
  must produce **zero blocking findings**. Every blocking finding on a clean case
  is a false positive. **This is where the suppression stack is scored.** Without
  clean cases, precision/FP-rate are unmeasurable, so the corpus MUST contain a
  healthy fraction of them (target ≥ 40%).

## 4. Matching semantics (finding ↔ expected label)

**A finding matches a label only if it satisfies ALL THREE tests** (addresses
WARN-2: a location-only or tag-only overlap is NOT a match):

- **Location:** finding's `file` equals the label's `file` AND finding's line is
  within `label.line ± window` (default `window = 5`, configurable via `--window`).
  The **same `± window`** tolerance applies to `allowed`-entry matching, so a
  fixture reformatted by a few lines still suppresses its known incidental (not
  exact-line-only — which would silently inflate FP-rate).
- **Tag:** the finding's title/body contains the label's `tag` keywords
  (tokenised, case-insensitive, loosely stemmed). Fuzzy on purpose — reviewers
  phrase the same bug many ways ("SQL injection" / "unsanitised query" / "string
  concatenation into SQL").
- **Severity:** finding severity `>= label.min_severity`.

**Assignment is 1:1, lexicographically optimal, and deterministic** (addresses
WARN-2 gaming/tie-breaking + round-4 optimality, and the algorithm-precision WARN
from the spec's own gate). Over all (finding, label) pairs that satisfy the three
tests, pick the **lexicographically best** assignment: **(1) maximise cardinality**
— match as many labels as possible, so a flexible finding is never consumed on the
nearest label while leaving another matchable-but-unmatched; **(2) among all
maximum-cardinality matchings, minimise** the sorted tuple of (line-distance,
−tag-overlap, finding-id). This is *not* plain Kuhn (cardinality only) nor plain
Hungarian (weight only): at the per-case label counts this targets (1–3) the runner
simply **enumerates every maximum-cardinality matching and selects by that
tie-break key** (cheap and obviously correct); for a hypothetical larger case it is
max-cardinality bipartite matching followed by a weight-optimal pass restricted to
the max-cardinality set. The result never depends on label ordering geometry. Each
finding is credited to at most one label and each label to at most one finding;
remaining findings/labels fall through to the outcome table below.

Per-case classification (blocking findings only, unless `--include-advisory`):

| finding / label state | outcome |
| --- | --- |
| finding assigned to a label (all 3 tests) | **TP** |
| label with no assigned finding | **FN** |
| unassigned blocking finding **inside the changed hunks**, not in `allowed` | **FP** |
| unassigned blocking finding **outside the changed hunks** (`strict_region:true`) | **NEUTRAL** (reported, not scored) |
| finding matching an `allowed` entry (location+tag) | **NEUTRAL** (WARN-4) |

The rows above apply to **both** case kinds — a `clean` case simply has no
`expected` labels, so its every blocking finding is "unassigned" and scored by the
region rules: **in-region → FP, out-of-region → NEUTRAL** (a clean refactor doesn't
prove the rest of the file is bug-free, so a real pre-existing bug outside the hunks
is not punished — WARN, plan-gate round 4).

- **`strict_region`** confines FP-eligibility to the diff's changed hunks for
  seeded-bug cases, so a correct observation elsewhere in the fixture is not
  punished (WARN-4). Set `strict_region:false` to score the whole file.
- A finding that matches **location but not tag** (or **tag but not location**) is
  NOT assigned to the label, so it falls through the table above unchanged — an
  in-region blocking one is therefore an **FP** and does **not** escape the
  precision penalty. It is *additionally* annotated `near_miss` in the report so
  matcher blind spots (a `--window` too tight, a `tag` needing synonyms) stay
  visible and fixable. `near_miss` is a reporting badge on an already-scored
  finding, **never a third bucket that voids the score** — voiding it would let a
  vague in-region finding dodge the precision penalty and mask a noisy reviewer
  (the exact gaming hole flagged in plan-gate round 2). The only findings that
  score NEUTRAL are `allowed` entries and (under `strict_region`) out-of-region
  ones.
- **Severity overshoot** (label WARN, finding CRITICAL): counts as **TP** with a
  `severity_overshoot` badge — it found the right thing; over-escalation is shown,
  not silently rewarded or punished.

Only **blocking** findings (severity ≥ the gate's blocking threshold — what would
actually stop the turn) count toward TP/FP by default; INFO/advisory are reported
separately and excluded from precision (mirrors `stats`). `--include-advisory`
folds them in for analysis.

**`bench report --explain` is mandatory-capable, not optional:** every match /
non-match decision (which finding → which label, why a finding was FP vs neutral)
must be dumpable so the matcher itself is auditable and its blind spots correctable.

## 5. Metrics

### 5.1 Two measurement layers (addresses WARN-3)

Metrics are computed at two explicit, separately-reported layers so a number
always corresponds to the thing it is evaluating:

- **RAW per-provider** — each reviewer's findings *as the adapter returned them,
  before* critic/consensus/confidence/reputation touch them. Measures the raw
  reviewer. Invariant **only to post-review suppressor ablations** (§8 class A); it
  is **NOT** invariant to input/prompt-stage ablations (§8 class B — e.g.
  `scopeToDiff`, reviewer selection, file-context budget), which change what the
  reviewer is shown and therefore change the raw findings themselves. The report
  must never attribute a class-B change in a raw number to the suppression stack.
- **AGGREGATED panel** — the final blocking set *after* the whole suppression
  stack. Measures what actually reaches the agent. **This is the layer ablation
  operates on** (§8) — toggling a suppressor changes this set, not the raw layer.

The runner MUST capture both: the per-reviewer raw outputs *and* the final
aggregated report. `runIteration()` today returns only the aggregated
`IterationResult` (no pre-aggregation array), so this needs a **concrete, opt-in
Orchestrator API change** (addresses the raw-findings-API WARN from the spec's own
gate):

- Add an optional constructor flag `captureRawReviews?: boolean` (default `false`,
  so production/gate runs pay nothing).
- When set, the Orchestrator retains the parsed per-reviewer `REVIEW_OUTPUT` arrays
  it already builds *before* aggregation and exposes them on the result as
  `rawReviews?: Array<{ providerId: string; persona: string; findings: Finding[] }>`.
- Bench sets the flag and reads `result.rawReviews` for the RAW per-provider layer;
  the AGGREGATED layer is the existing final report. Reporting a per-provider score
  off the *aggregated* set is explicitly disallowed (it would misattribute
  suppression to the provider).

This API change is listed as explicit scope in §11 (P1), not hand-waved.

### 5.2 Metrics table

| Metric | Definition |
| --- | --- |
| Precision | `TP / (TP + FP)` — reported with raw numerators `(TP/(TP+FP))` |
| Recall | `TP / (TP + FN)` — reported with raw numerators |
| **Clean FP-rate** | `clean cases with ≥1 blocking finding / total clean cases` |
| Latency | median + p90 wall-clock per review |
| Cost | structured per provider (§5.3), never collapsed to `$0` |
| Convergence | **phase 2 / stability proxy only** — see §10(4) |

**Every rate is reported with its raw denominator and a Wilson 95% confidence
interval** (addresses INFO-7): e.g. `precision 0.85 (17/20, 95% CI 0.64–0.95)`. At
N≈20–30 the CI is wide on purpose — it stops a one-case swing from reading as a
real delta. Ablation deltas (§8) are reported as CI-overlapping-or-not, not bare
point differences.

Lead the human report with **Clean FP-rate**: it is the number competitors hide,
and the one Reviewgate's suppression stack is built to win.

### 5.3 Cost accounting (addresses WARN-6)

Cost is a structured record per provider, never a single `$0`:

```jsonc
{ "provider": "codex", "calls": 22, "cache_hits": 3, "tokens_in": 41000,
  "tokens_out": 8800, "billed_usd": 0.0, "oauth_quota_calls": 19 }
```

OAuth reviewers report `billed_usd: 0` **but** record `oauth_quota_calls`
separately — quota is a real, exhaustible cost even at `$0` billed. `cache_hits`
are reported so a run that reused cached reviews is never mistaken for a cheap
*fresh* run; `bench run --no-cache` forces cold measurement for a true latency/cost
number.

## 6. CLI surface

```bash
reviewgate bench run    --corpus ./bench/cases --out results.json
reviewgate bench run    --corpus ./bench/cases --providers codex,claude-code   # ablation subset
reviewgate bench run    --corpus ./bench/cases --window 8 --include-advisory
reviewgate bench report results.json                     # human table + markdown summary
reviewgate bench matrix --corpus ./bench/cases --ablate critic,reputation,fp-ledger   # phase 2
```

- `bench run` executes every case, classifies findings, writes a
  `reviewgate.bench.result.v1` JSON (schema in `src/schemas/`).
- `bench report` renders a saved result to a terminal table + a markdown block
  suitable for pasting into the README / a blog post.
- `bench matrix` (**phase 2 — P4**) runs `bench run` once per ablation in
  `--ablate` and prints the per-layer Δ table (§8). It shares `run`'s `--corpus` /
  `--providers` / `--window` contract and the same exit codes; its full flag +
  output schema is defined when P4 lands. Listed here so §8's "credibility
  money-shot" is not silently missing from the CLI surface (addresses the
  matrix-absent WARN from the spec's own gate).

**Exit codes & quality gate** (addresses INFO-8 — a low-quality run must not
masquerade as a headline number):

| code | meaning |
| --- | --- |
| `0` | scored run, quality gate satisfied |
| `2` | usage / input error (bad flags, unreadable corpus) |
| `3` | ERROR — no reviewer completed (providers down / quota); NOT a result |
| `4` | **benchmark-invalid** — the run executed but is not trustworthy as a score |

(Exit `1` is intentionally unused — bench *reports* results, it does not "fail" a
review the way `review-plan` does — so an accidental `1` from an uncaught exception
is distinguishable from every meaningful sentinel above.)

`4` (benchmark-invalid) fires when: the corpus has **zero clean** or **zero
seeded** cases; more than `--max-failed-frac` (default 10%) of cases failed to
review (provider errors on individual cases); or any individual `case.json` is
malformed. `--min-clean N` / `--min-seeded N` add explicit floors. Per-case status
(`scored` / `review-error` / `invalid`) is recorded in `results.json`, and
`bench report` prints headline rates **only** when the gate is satisfied,
otherwise it prints the partial data clearly flagged as non-authoritative.

## 7. Architecture & reuse

The heavy lifting already exists. `runReviewPlan`
(`src/cli/commands/review-plan.ts`) is the template: it builds an `Orchestrator`
with an in-memory `diff` and `reportMode: "one-shot"`, then calls
`orchestrator.runIteration({ runId, iter: 1 })` and reads the structured report.

`bench run` per case:

1. Load `case.json` (validate against the schema) and `diff.patch`.
2. `loadEffectiveConfig` → apply the run's **ablation overrides** (§8) →
   `buildAdapters`.
3. Build an `Orchestrator` exactly like `review-plan` but feed `diff.patch` as the
   `diff`, in a **fresh per-case state + report sandbox** with **empty learning
   stores** (§7.1) so cases are order-independent and never cross-contaminate the
   FP-ledger / reputation. The sandbox is not a git repo, so bench does **not** call
   `collectGitInfo` on it (that errors / returns empty); it injects a **fixed
   synthetic `gitInfo`** (constant branch/commit placeholder, recorded in
   provenance) so reviewer prompts are stable and comparable across cases and runs
   instead of varying with ambient repo state (addresses the gitInfo-in-sandbox
   WARN from the spec's own gate).
4. `runIteration()` → read the structured findings from the one-shot JSON report
   (NOT the rendered markdown — bench needs `file`/`line`/`severity`/`category`).
5. Classify findings against `expected` (§4); accumulate TP/FP/FN + latency/cost.

New code is small and well-bounded:

- `src/schemas/bench-case.ts`, `src/schemas/bench-result.ts` (zod, source of truth).
- `src/bench/matcher.ts` — the finding↔label classifier (~150–250 LOC). The only
  genuinely novel logic.
- `src/bench/runner.ts` — orchestrates cases (sequential by default to keep
  provider quota predictable; `--concurrency N` later).
- `src/cli/commands/bench.ts` — `run` / `report` subcommands.
- `bench/cases/` — the corpus (see §9).

### 7.1 State isolation (CRITICAL — addresses the plan-gate CRITICAL)

"Fresh temp dir" is not enough on its own: `loadEffectiveConfig → buildAdapters →
Orchestrator` can otherwise resolve mutable state from the user's real environment
and silently contaminate results (order-dependent, user-dependent, irreproducible).
Bench MUST redirect **every** mutable state path to a per-run sandbox and **assert**
nothing escapes it. Concretely, before any case runs:

1. **Redirect the state root.** Every reader/writer of `.reviewgate/` state must be
   parameterised on a `stateRoot` covering all of: **FP-ledger**, **reputation
   store**, **review cache**, **brain store**, **audit dir**, **quota-cooldowns**,
   **pending/plan-review report paths**, **run-id/iteration state**.
   **Concrete API (addresses the stateRoot-injection WARN from the spec's own
   gate):** these paths are today derived from `repoRoot` inside the state-store /
   config layer. Add an optional `stateRoot?: string` to the state-path resolver and
   thread it from the `Orchestrator` constructor + the state-store factory; when
   absent it defaults to `<repoRoot>/.reviewgate`, so existing callers (`gate.ts`,
   `review-plan.ts`) are unchanged (backward-compatible). Bench passes an explicit
   per-run / per-case `stateRoot`. Auditing that *every* store above honours this
   parameter instead of re-deriving from `homedir()`/CWD is **explicit API-change
   scope in §11 (P1)**, not incidental runner work.
2. **Fresh learning stores per CASE (order-independence).** By default every scored
   case gets its OWN empty FP-ledger / reputation / brain, so a case's score never
   depends on corpus order. This matters because FP-ledger and reputation are
   *designed* to learn across reviews — left shared within a run, case N's result
   would depend on cases 1..N-1, and precision/recall/FP-rate + ablation deltas
   would silently become order-dependent (WARN, plan-gate round 3). Measuring the
   *learning* behaviour over a sequence is a separate, **opt-in `--accumulate`**
   mode that shares stores across cases within a run AND pins + records the corpus
   order in provenance; it is never the default and its numbers are never pooled
   with the order-independent ones. Provenance records
   `stores: "per-case-fresh" | "accumulated"`.
3. **Neutralise the cross-run review cache.** The cache key already includes the
   config hash + diff, but a *hit* from the user's history would replace a real
   measured review with a cached one. Bench points the cache at the sandbox
   (cold by default) and exposes `--no-cache`; `cache_hits` is always reported.
4. **Fail-closed assertion.** At startup bench canonicalises `stateRoot` and, after
   config resolution, **asserts every resolved state/report path is a descendant of
   `stateRoot`**. If any path resolves outside (e.g. an un-threaded default), bench
   **aborts with exit 2** rather than risk mutating the user's real `.reviewgate/`
   or reading their real stores. No partial-isolation runs.

A shared reputation/FP store would make results order- and user-dependent; this
section is a correctness requirement, not a nicety.

### 7.2 Reproducibility metadata (addresses WARN-5)

`results.json` MUST carry a `provenance` block so two runs are comparable and a
published number is reproducible:

```jsonc
{ "reviewgate_version": "0.1.0-alpha.x", "corpus_commit": "<git sha of bench/cases>",
  "corpus_dirty": false,          // true if bench/cases had uncommitted edits (WARN-4)
  "providers": [ { "id": "codex", "cli_version": "…", "model": "…" } ],
  "config_hash": "…", "window": 5, "repeat": 1, "include_advisory": false,
  "temperature": null, "stores": "per-case-fresh", "cache": "cold",
  "host_os": "darwin-arm64", "timestamp": "…", "case_count": { "seeded": 12, "clean": 10 } }
```

`corpus_commit` alone is not enough: uncommitted edits to `bench/cases` would tie a
published number to a commit it does not represent (WARN, plan-gate round 4).
Therefore bench also records **`corpus_dirty`** (whether the worktree had
uncommitted changes under `bench/cases`) and a **per-case content hash**
(`sha256(case.json ‖ diff.patch)`) stored on each case's result entry. `bench
report` flags any run with `corpus_dirty: true` as **non-authoritative** — real for
local iteration, not for publishing. `reviewgate_version` is read from the
**compiled-in package version** (the same source `reviewgate --version` prints),
never a hardcoded placeholder, so every result is tied to the actual running binary.
Model/CLI versions are captured where the provider exposes them (`--version`); where
a provider hides its upstream model, record it as unknown rather than omitting the
field. Without this block cross-run comparison is unsound and the report says so.

## 8. Ablation mode (the credibility money-shot)

Run the same corpus with suppression layers toggled, report the precision/recall
delta. Toggles map to **real, existing config keys** applied programmatically per
run (no new runtime flags in the gate itself). Ablations fall into two classes that
must be reported separately (WARN, plan-gate round 3):

**Class A — post-review suppressors.** Operate *after* the reviewers return, so RAW
per-provider metrics are unchanged and **only the AGGREGATED layer moves.** A
class-A delta is cleanly attributable to that suppressor.

| Ablation | Config override |
| --- | --- |
| `--no-critic` | `phases.critic = null` |
| `--no-reputation` | `phases.reputation.enabled = false` |
| `--no-fp-ledger` | FP-ledger enable flag off |
| `--no-confidence-floor` | `phases.review.confidenceFloor = 0` |

**Class B — input / prompt-stage.** Change *what the reviewer is shown* or *which
reviewers run*, so they move the RAW findings too — **both layers change** and the
delta is NOT attributable to a post-review suppressor.

| Ablation | Config override |
| --- | --- |
| Single reviewer vs. panel | `phases.review.reviewers` (1 vs. N) / `--providers` |
| `--no-scope-to-diff` | `phases.review.scopeToDiff = false` |
| file-context budget | `phases.review.fileContext*` |

`bench matrix` (phase 2) prints *layer → Δprecision, Δrecall, ΔFP-rate* **tagged
with the ablation class**, so a class-B prompt change is never mistaken for a
suppression-stack effect. That table is the empirical answer to "does the
suppression machinery earn its complexity?"

## 9. Bootstrap corpus

Target ~20–30 cases to start (explicitly a smoke test, §2):

- **~12 seeded-bug** hand-written classics, each a small self-contained diff:
  SQL injection, path traversal, missing `await` (dropped promise), off-by-one,
  secret committed in code, TOCTOU, unchecked user input in a shell command,
  broken auth check, integer overflow / division-by-zero, prototype pollution,
  ReDoS, insecure deserialization. Reviewgate's own findings history is a source
  of realistic phrasings.
- **~10 clean** cases lifted from real git history that shipped fine: rename,
  extract-function, pure dependency bump, comment/docs change, test-only change,
  formatting-only. These are the FP stress test.
- Mix languages (TS + Python) to exercise the symbol-graph / triage paths.

Later phases: `source: "mutation"` (mechanically flip `>`→`>=`, drop an `await`)
for scale, and `derived-from-cve` for realism.

## 10. Risks / decisions

Resolved in this revision (from the plan-gate review):

- **State isolation** (was CRITICAL) → §7.1: every mutable path redirected to a
  sandbox + fail-closed assertion.
- **Match gaming / tie-breaking** (WARN-2) → §4: all-three-tests, 1:1 optimal
  (max-cardinality) assignment; **in-region partial matches score FP** (badged
  `near_miss`, never voided); NEUTRAL is reserved for `allowed` / out-of-region.
- **Per-provider vs. panel measurement** (WARN-3) → §5.1: raw vs. aggregated
  layers, ablation on the aggregated layer only.
- **Incidental real findings** (WARN-4) → §3/§4: `allowed` list + `strict_region`
  → NEUTRAL, not FP.
- **Reproducibility** (WARN-5) → §7.2 provenance block.
- **Cost obscuring OAuth quota / cache** (WARN-6) → §5.3 structured cost.
- **Small-N over-reading** (INFO-7) → §5.2 denominators + Wilson CI.
- **Benchmark-invalid runs** (INFO-8) → §6 exit-code 4 + quality gate.
- **Severity overshoot** → §4: TP + `severity_overshoot` badge.

Still genuinely open (carry into implementation):

1. **Matcher validation.** The fuzzy tag-matcher itself needs a labelled
   validation pass (its own precision/recall against hand-checked matches) — a
   biased matcher silently biases every number. `--explain` (§4) makes it
   auditable; a small `tests/bench/matcher-fixtures` set gates P0.
2. **Author bias.** Hand-written seeded bugs may be easier than real-world bugs,
   over-stating recall; provenance states N + `source` mix, and the report must
   not over-claim on a smoke-test corpus.
3. **Non-determinism.** LLM reviewers vary run-to-run; `--repeat K` (P5) reports
   mean ± spread so one lucky/unlucky run isn't mistaken for signal.
4. **Convergence** (§5.2) needs a *fixer* (code generator), which bench lacks;
   v1 measures only **stability** (does a second identical review still fire the
   finding), true convergence is deferred to phase 2.

## 11. Implementation phases

- **P0** — schemas (`bench-case`, `bench-result`) + `matcher.ts` + unit tests on
  the matcher with hand-built finding/label fixtures (TDD; the matcher is pure and
  fully testable offline without any reviewer).
- **P1** — `runner.ts` reusing the one-shot Orchestrator path + `bench run` CLI +
  isolated per-case state dir. **Includes the two gate-required Orchestrator API
  changes as explicit scope:** (a) optional `stateRoot?` threaded through the
  state-path resolver + state-store factory, defaulting to `<repoRoot>/.reviewgate`
  (backward-compatible for `gate.ts` / `review-plan.ts`); (b) optional
  `captureRawReviews?` flag surfacing the pre-aggregation `rawReviews` array on the
  result. Plus the fixed synthetic `gitInfo` for the non-git sandbox (§7 step 3).
- **P2** — `bench report` renderer (table + markdown).
- **P3** — bootstrap corpus (~22 cases) committed under `bench/cases/`.
- **P4** — ablation overrides + `bench matrix`.
- **P5** — `--repeat`, `--explain`, cost estimation polish.

P0 is fully offline and TDD-able; the reviewer-dependent parts start at P1.

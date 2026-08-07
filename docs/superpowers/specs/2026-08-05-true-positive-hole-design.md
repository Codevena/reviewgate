# Closing the true-positive hole pilot-02 exposed

_2026-08-05. Task (b) from `NEXT_SESSION.md`, following
`docs/dev/2026-08-05-pilot-02-result.md` and the measurement fixes in
`docs/superpowers/plans/2026-08-05-rig-measurement-fixes.md` (task (a), `5a1f94f`)._

> **Revision note.** A first version of this spec proposed a new anchor-validation pass in
> `aggregator.ts`. That was wrong: `src/core/fact-check.ts` already validates line anchors, it
> already fired on the finding in question, and the new pass would have silently reversed a
> deliberate, documented policy. The design below replaces it. What survives from the first
> version is Slice B, unchanged.

## The evidence this design starts from

pilot-02's turn 2 seeded a path traversal. The panel **detected it twice**. Both detections
ended at INFO, the turn recorded 0 blocking findings, and M3 scored a miss.

Read the recorded findings yourself:

```bash
bun -e 'const j = JSON.parse(await Bun.file("rig/results/pilot-02/turns/2/.reviewgate/pending.json").text());
for (const f of j.findings) console.log(f.id, f.rule_id, f.severity, f.line_start, f.confidence, f.consensus, f.critic_verdict ?? "-", f.fact_invalid ?? "-", f.scope_demoted ?? "-")'
sed -n '1,10p' rig/results/pilot-02/turns/2/diff.patch
```

| | rule_id | line_start | conf | consensus | what demoted it |
|---|---|---|---:|---|---|
| F-001 | `path-traversal-readtemplate` | **25** | 0.55 | singleton | critic → `likely_fp` |
| F-002 | `path-traversal` | **67** | 0.90 | singleton | **`fact_invalid`**, then `scope_demoted` |

`src/store.ts` is a **brand-new 27-line file** in that turn's diff (`@@ -0,0 +1,27 @@`).
F-002 is anchored at **line 67 — past EOF**.

### The gate caught the bad anchor, and drew the wrong conclusion

`validateFindingFacts` (`src/core/fact-check.ts`, called at `orchestrator.ts:2226`, before
aggregation) detected it exactly and demoted the finding, writing this into its details:

```
[reviewgate fact-check] cited location src/store.ts:67 does not exist in the working tree
(file has 27 lines) — almost certainly hallucinated; demoted to advisory.
```

That pass exists for good reason — two production field reports where a lone reviewer emitted a
0.97 CRITICAL citing content in an **empty** file. Its stated premise is:

> _"if a file has 3 lines, a finding on line 99 is unambiguously fabricated"_ (`fact-check.ts:18`)

**F-002 falsifies that premise.** It carries the reviewer's own quoted evidence:

```
evidence_line: "  return readFileSync(`./templates/${name}`, 'utf8')"
```

which is **verbatim line 26** of that 27-line file. The reviewer read the real code, quoted it
correctly, and mis-numbered the line. The finding was **mis-anchored, not fabricated** — and the
gate told the agent the opposite, at 0.90 confidence, about a real path traversal.

The discriminator already exists **in the same file**: `attestEvidence:154` computes
`lines.some((l) => normalizeLine(l) === evN)` — "does this quote match any line of the file". It
runs at `orchestrator.ts:2573`, render-only, *after* aggregation, and never feeds the demote.

### Scale, measured across both pilots

```bash
bun -e 'let tot=0,ev=0,fi=0; const g=new Bun.Glob("rig/results/pilot-0*/turns/*/reports/*-pending.json");
for await (const p of g.scan(".")) { const j=JSON.parse(await Bun.file(p).text());
for (const f of j.findings ?? []) { tot++; if (f.evidence_line) ev++; if (f.fact_invalid) fi++; } }
console.log({tot, ev, fi})'
```

| | |
|---|---|
| findings across both pilots | 68 |
| carrying `evidence_line` | **55 (81 %)** |
| distinct findings `fact_invalid` fired on, in 24 turns | **1** |
| ...whose evidence line matched a real line of the cited file | **1 of 1** |

Running the command above prints `fi: 2`, not 1 — both numbers are right. It is the **same**
signature (`8deca571…`) recurring in `turns/3`, so the raw count is 2 rows but 1 distinct finding.
The one time this pass fired (on a distinct finding), it labelled a real security finding a
hallucination. **n = 1**: the change below is justified by the mechanism, not by that sample size.

> **CORRECTION (2026-08-06, `docs/dev/2026-08-06-slice-a-corpus-replay.md`).** This table
> undercounts, and the command above is why: it globs `reports/*-pending.json`, which are
> **post-aggregation survivors**, while this pass runs pre-aggregation. Every out-of-range
> finding the critic dropped or a merge folded away is missing from it. Replaying the reviewers'
> **raw** output (`cassette.jsonl`) through the pass gives **7** out-of-range citations across
> the pilots, not 1 — five of them in the very turn this design was built from — and the pass as
> shipped repairs all 7. The design's reasoning is unaffected; only "n = 1" is.

### Why this one anchor cost the whole turn

The bad anchor caused all three failures the pilot-02 write-up attributes to independent layers:

1. **`fact_invalid`** demoted F-002 to INFO as fabricated (above).
2. **The two findings never merged.** 25 and 67 are 42 lines apart, past both `REGION_WINDOW`
   (5, `aggregator.ts:192`) and `WORDING_MERGE_MAX_LINE_DISTANCE` (25, `:229`).
3. **No merge meant no corroboration.** `computeConsensus(1, 2)` is `"singleton"`; merged it
   would be `computeConsensus(2, 2)` → `"majority"` → `isCorroborated` (`:610`) → **the critic
   could not have demoted F-001 at all.**

So the handoff's candidate (2) — "merge same-file/same-category detections before the critic" —
targets a symptom. These findings did not need a broader merge rule; they needed the anchor
repaired, after which they are **one line apart** and merge under the existing window.

The handoff's candidate (1) is a real defect independent of turn 2: the critic's exemption is
keyed to CRITICAL (`:604`) while the sibling `deltaScoped` pass exempts
`touchesSecurityOrCorrectness` at **any** severity (`:664`). That is Slice B.

**Slice B was REVERTED on 2026-08-07 — see the banner at §Slice B below. Present-tense descriptions
of it anywhere in this document — including above this line, and in the Data flow block,
§Measurability, and §Risks — are the original design, kept for the record; the critic's exemption is
CRITICAL-only again.**

## Scope

Two slices. Both **always-on** — they are defect corrections, and the sibling protections they
sit beside are all unflagged. Observability comes from markers a pilot can count, not from config
toggles; no new config key, and so no second TTY control-plane approval.

### Explicitly out of scope

- **Merge/clustering changes.** Widening the merge to same-file/same-category would bundle
  genuinely separate security bugs under one decision, which `isHighStakesCategory` (`:279`)
  exists to prevent. Slice A reaches the merge by fixing the input, not the rule.
- **M5 critic cost attribution** (`orchestrator.ts:2300`) stays scoped out; it is a
  provider-contract change, as recorded in the task-(a) plan.
- **Findings with no `evidence_line`** (19 % of the corpus) get no new protection. Their
  behaviour is unchanged.
- **Signature reordering.** `applySymbolSignatures` runs at `orchestrator.ts:2219`, *before*
  `validateFindingFacts` at `:2226`, so a repaired finding keeps a signature derived from the
  phantom pre-repair line rather than the symbol-relative form a correctly-anchored duplicate
  would get. Deliberate, not an oversight: reordering the two passes would invalidate every
  persisted signature and cache entry. Accepted because the location-keyed guard closes exactly
  this gap and, thanks to the repair, now sees a *stable* region instead of a churning bogus one
  (final review, M-6).

## Slice A — distinguish mis-anchored from fabricated

The whole change is inside `validateFindingFacts`, at the point where it has already read the
file and decided the line is out of range (`fact-check.ts:116-119`):

```ts
const lines = lineCount(text);
if (f.line_start <= lines) return f;        // cited line exists → untouched (unchanged)
// Out of range. Before calling it a fabrication, consult the reviewer's OWN quoted evidence:
// if evidence_line matches a real line of THIS file, the reviewer read real code and
// mis-numbered it. That is mis-anchored, not fabricated, and demoting it as a hallucination
// is a false accusation against a finding we can prove is grounded.
const repaired = reanchorByEvidence(f, text);
if (repaired) return repaired;
return demote(f, note);                      // no quote, or quote matches nothing → unchanged
```

`reanchorByEvidence(f, text)` returns `null` unless **all** of these hold:

1. `f.evidence_line` is a non-empty string, and non-empty after `normalizeLine` (`:129`, already
   in this file — defangs injection markers, collapses whitespace);
2. at least one line of `text` equals it under the same normalization.

On a match it returns the finding re-anchored to that line, with `line_end` collapsed to it, a
`anchor_repaired: true` marker, and a details note recording the original number.

**Disambiguation, stated as a rule rather than left to chance:** when the quote matches several
lines, re-anchor to the **LAST** matching occurrence — which, because this only ever runs on a
citation past EOF, is also the occurrence **nearest** the cited line, so a tie cannot occur given
the range-checked call site. Any matching occurrence is a real instance of the reviewer's own
quote, so this chooses among facts rather than inventing one, and it is fully deterministic —
which the aggregator's clustering requires (`:433-444` sorts precisely to keep clustering
order-independent).

**This is not the gate inventing a location.** It re-anchors to a line the reviewer itself
quoted. The rejected alternative — clamping to the nearest changed hunk — would have been.

**Cost: zero extra I/O.** The re-anchor reuses the `text` the pass already read under its
existing O_NOFOLLOW-contained, 5 MB-capped reader. No new file access, no new pass, no new
`AggregateInput` field, and **no orchestrator change at all**.

### Why placing it here makes the rest fall out

`validateFindingFacts` runs **pre-aggregation** (`orchestrator.ts:2226`), so the repaired line is
what clustering sees. For turn 2 that means 67 → 26, one line from F-001's anchor at 25, inside
`REGION_WINDOW` → the two merge → `"majority"` → `isCorroborated` → the critic is barred, and the
finding is in-diff so nothing scope-demotes it.

It also makes the two evidence passes agree: `attestEvidence` (`:2573`) reads
`lines[line_start - 1]`, which after the repair is the quoted line, so it stops treating the
finding as ambiguous.

### Schema and rendering

`FindingSchema` gains `anchor_repaired: z.boolean().optional()`, alongside `fact_invalid`
(`finding.ts:234`) and `scope_demoted` (`:81`).

`report-writer.ts` gains one badge beside the existing `🔎 cited location not found` (`:43`):

```
⚑ reviewer cited a line that does not exist — re-anchored to the source line it quoted
```

The badge is what makes a mis-anchoring reviewer visible instead of silently corrected.

**The marker must survive the merge it enables.** Found while planning, and load-bearing: the
repair's whole purpose is to let two detections cluster, but `memberOf` (`aggregator.ts:295`)
projects a member down to six fields, and the representative is chosen by severity with **ties
keeping the first**. In the turn-2 shape both findings are WARN and the repaired one sorts second,
so it becomes a *member* — and the marker, the badge and the pilot count would all vanish in
exactly the case the slice was built for. `anchor_repaired` is therefore carried in `members[]`
and OR-propagated to the representative, mirroring what `demoted_from_critical` already does at
`:524-531` for precisely the same reason.

## Slice B — critic severity floor

> **REVERTED 2026-08-07.** Shipped 2026-08-05, removed two days later on measurement. Everything
> below is the original design and is **left in place deliberately** — its reasoning was sound on
> the evidence it had (one observed WARN-security demote, pilot-02 turn 2). What changed is the
> evidence, not the argument.
>
> Replayed over the whole recorded corpus (pilot-02 as an unbiased counterfactual, since its binary
> predated the floor; pilot-03 as the reproduction check):
>
> | | |
> |---|---:|
> | activations | **3** |
> | protected a **true** positive | **0** |
> | protected a **false** positive | **3** |
> | times the critic proposed demoting a catch of a seed that actually LANDED | **1** |
> | …of which the FLOOR was the mechanism that saved it | **0** — corroboration did |
>
> All three activations were hedged, uncorroborated WARN claims ("may lead to", "may cause", "may
> still allow") whose security/correctness category was the reviewer's own generous
> self-classification — exactly the finding the critic exists to filter. **Narrowing was considered
> and refuted by execution:** the existing `HYPOTHETICAL` detector matches 0 of 3, and that pass
> refuses to touch security/correctness by design (`hypothetical-demote.ts:60`); any other narrowing
> would be a *new* text-signal suppressor over the two categories this codebase never softens on a
> text signal.
>
> **The evidence is bounded:** 3 activations and exactly one exercised protective opportunity across
> 13 turns of a single panel. That bounds the benefit; it does not prove it is zero in general.
> **Accepted cost of the revert:** an uncorroborated WARN security finding from a reviewer with no
> track record, called `likely_fp` by the critic, now goes to INFO with no downstream gate —
> `isProtected` / `protected_high_precision` (`aggregator.ts:632`) fires in exactly that branch but
> is cold-start-inert (`PROTECT_MIN_DECISIONS`). Reversible in one line if the field shows otherwise.
>
> Evidence: `docs/dev/2026-08-07-slice-b-critic-floor-counterfactual.md`.
> Plan: `docs/superpowers/plans/2026-08-07-slice-b-revert.md`.
> Live check: `bun run rig/scripts/critic-floor-replay.ts` (expects 0 activations).

`aggregator.ts:604` gains a sibling to `isCriticalSecurity`:

```ts
const isCriticalSecurity = f.severity === "CRITICAL" && touchesSecurityOrCorrectness(f);
// The critic may not push a security/correctness finding BELOW WARN — that is the one demote
// that crosses the blocking boundary. An already-INFO one stays droppable, so the critic keeps
// its FP-filtering power exactly where reviewers are noisiest.
const isBlockingSecurity = f.severity === "WARN" && touchesSecurityOrCorrectness(f);
```

Both feed the same two branches at `:615` and `:619`. A protected finding therefore takes the
existing `survivors.push({ ...f, critic_verdict: "keep" })` path at `:635`, which already renders
honestly — no new marker needed.

**Why the floor stops at WARN.** The stated harm is a demote crossing the blocking boundary
(`isBlocking` is `CRITICAL || WARN`). WARN → INFO crosses it; INFO → drop does not, and
low-confidence INFO security chatter is the noisiest thing the critic filters. Making security
wholly critic-immune would re-inflate FP burden in a way pilot-02 has **zero data** on
(`rejectedAsFp` was 0 on every turn; `known_fp.jsonl` ended the run empty).

**Kept even though Slice A alone rescues turn 2.** Slice A works through the merge, which needs
two detections. A lone WARN security finding — the common case — still faces a critic whose
exemption is keyed to a severity it does not have. The two slices protect different populations.

**Blast radius.** `demoteOneStep` (`:155`) is unchanged — a WARN security finding never reaches
it from the critic pass. The reputation and confidence-floor passes are untouched; they already
carry their own hard security veto (`touchesSecurity`, `:285`).

## Data flow

```
reviewers  →  findings (line_start unvalidated, evidence_line usually present)
orchestrator:2226   validateFindingFacts
                      ├─ line in range                → untouched
                      ├─ out of range, quote matches  → RE-ANCHOR + anchor_repaired   ← Slice A
                      └─ out of range, no match/quote → demote INFO + fact_invalid    (unchanged)
orchestrator:2451   aggregate()
                      cluster (now sees the repaired line → the two findings merge)
                      consensus → "majority"
                      critic pass (isCorroborated bars it; Slice B barred WARN+security too
                                   — REVERTED 2026-08-07, CRITICAL-only again)
                      scopeFindings → deltaScope → fp-ledger → reputation → verdict
orchestrator:2573   attestEvidence  (now agrees; no evidence_mismatch)
report-writer:      anchor_repaired badge
```

## Fail-safety

Each row states its failure direction, not merely its behaviour.

| Condition | Behaviour | Why |
|---|---|---|
| No `evidence_line` on the finding | Demoted exactly as today | 19 % of the corpus; the empty-file fabrication case that motivated the pass is untouched |
| `evidence_line` present, matches **no** line | Demoted exactly as today | A quote that is in no line of the file is the fabrication signal, now positively established rather than inferred from a number |
| `evidence_line` empty after `normalizeLine` | Treated as absent → demoted | A whitespace/marker-only quote carries no signal |
| Quote matches **several** lines | Re-anchor to the nearest, ties → lower line | Deterministic; clustering must not depend on iteration order |
| File unreadable, oversize, symlinked, absent | Untouched, as today | The existing reader already fails safe here; Slice A adds no new access |
| Finding on a path in `deletedPaths` | Skipped, as today | Commentary on removed code, not a fabrication |
| Cited line **in** range | Untouched — re-anchor never runs | The pass stays demote-or-repair-only on out-of-range findings; it can never move a valid anchor |

## Measurability, stated honestly

`SUPPRESSION_LAYERS` (`src/rig/ablate.ts:44`) is `["critic","reputation","fp-ledger","lore"]`, and
`ablate.ts:88` already treats `fact_invalid` as a non-ablatable other-suppressor.

- **Slice B stays fully ablatable.** A protected finding carries `critic_verdict: "keep"`, and
  `−critic` shows no recall delta where the floor held.
- **Slice A is observable, not ablatable.** pilot-03 can count `anchor_repaired` findings and how
  many stayed blocking; it cannot produce a counterfactual matrix row. The write-up must say so
  rather than let the matrix imply coverage it does not have.
- **Expect a small count.** The pass fired once in 24 turns. A pilot-03 that shows 0
  `anchor_repaired` findings has not refuted the fix — it has not exercised it, and the write-up
  must say that instead of reporting a null result.

## Testing

Every guard test carries the two numbers of the quantity it guards. A test whose two values match
is vacuous **on paper** and gets rewritten before it is written.

| # | Guards | WITHOUT the mechanism | WITH it |
|---|---|---|---|
| 1 | Out-of-range + quote matches → re-anchored, not demoted | INFO + `fact_invalid` → **0 blocking** | CRITICAL kept, `line_start` = matched line, `anchor_repaired` → **1 blocking** |
| 2 | No `evidence_line` → still demoted (the empty-file case). Mutation: re-anchor unconditionally | unconditional repair → `fact_invalid` **absent** | correct gate → `fact_invalid` **true** |
| 3 | Quote matching **no** line → still demoted. Mutation: skip the match test | skipped test → `fact_invalid` **absent** | correct gate → `fact_invalid` **true** |
| 4 | Multiple matches → nearest-to-cited wins, deterministic | first-match rule → `line_start` **2** | nearest rule → `line_start` **8** |
| 5 | In-range finding is never moved. Mutation: run the repair before the range check | repair-first → `line_start` **moves** | correct order → `line_start` **unchanged** |
| 6 | Cascade, reconstructed from turn 2: repair → merge → majority → blocking | 2 findings, consensus `singleton`, **0 blocking** | 1 merged finding, consensus `majority`, **1 blocking** |
| 7 | WARN + security + `likely_fp` survives the critic | INFO + `critic_verdict: likely_fp` → **0 blocking** | WARN + `critic_verdict: keep` → **1 blocking** |
| 8 | Floor does not over-apply — INFO + security + `likely_fp` still dropped | "exempt at every severity" variant → `criticDropped` **0** | correct floor → `criticDropped` **1** |
| 9 | Floor is category-keyed, not severity-keyed — WARN + *quality* still demotes | severity-only variant → **1 blocking** | correct floor → **0 blocking** |

Each is seen **red** first, in a copy of the repo; the original is confirmed unmodified with
`git diff` after each copy is discarded.

**Test 6 is the acceptance test, and it is a reconstruction, not a replay.** It is built from
turn 2's recorded `pending.json` — both findings, their real lines, categories, confidences,
messages and the actual `evidence_line` — plus a temp-dir copy of the 27-line `src/store.ts` from
`turns/2/diff.patch`. The archived findings are post-aggregation, so the pre-aggregation input is
inferred from the demotion markers, exactly as `ablate.ts` does. The write-up must not call it a
replay.

**Static gates.** `bunx tsc --noEmit`, `bun run lint`, and the full `bun test` —
`FindingSchema` changes, so the persisted-artifact suite runs whole.

**Reviews.** A plan gate with an **executing** reviewer before implementation, then the
post-implementation pipeline with two independent slots. Codex is quota-blocked until
**2026-08-08T11:07Z**, so Slot A is `agy`/Gemini or a Claude reviewer subagent, and Slot B a
second, different voice.

## Sequencing for pilot-03

In this order. The trap is that (b) changes gate behaviour, so it only reaches a pilot through a
rebuild — and the rebuild re-pins the binary.

1. Implement, pass both review gates, commit.
2. `bun run build`; record the new `sha256`. **This deploys to every repo via the
   `~/.local/bin/reviewgate` symlink** — the whole machine's gate behaviour changes at that
   moment, not just the sandbox's.
3. Preregister pilot-03 against the **new** hash, with every floor written as a **rate**, never a
   count (pilot-02's M3 floor was miswritten as a count).
4. Run. Never rebuild mid-run.
5. Expect a landed-seed denominator of **3**, not 5 — the agent declined the SQL-injection and
   hardcoded-secret prompts in both pilots.

The preregistration is a separate artifact, written after the build against the new hash. It is
not part of this spec.

## Risks

| Risk | Handling |
|---|---|
| Re-anchoring rescues a genuinely fabricated finding | Only when the reviewer's quote is **found verbatim in the cited file** AND carries at least one identifier-like token (2+ word characters) — a punctuation-only quote like `}` matches dozens of lines and was demonstrated to rescue a fabricated CRITICAL, so the quote alone is not proof the finding is real (final review, I-1). The bound was lowered from a 3-character to a 2-character minimum after this repo's own gate flagged that a real line whose longest token is 2 chars (e.g. `if (a || b) {`) would otherwise be wrongly demoted; measured over all 35 distinct `evidence_line` values recorded across both pilots, both bounds reject **0**, so the change is neutral on real data and strictly better on the short-token case. This bounds but does not eliminate the residual: a fabricator that additionally invents a plausible identifier-bearing line, or that simply cites an IN-RANGE line, was never covered by this pass at all — `validateFindingFacts` only ever runs on out-of-range citations. Guards 2 and 3 pin both no-quote and no-match paths |
| The repair moves a finding onto unrelated code | It moves it onto a line the reviewer quoted; multi-match resolves to the LAST matching occurrence — which, because the citation is always past EOF, is also the nearest, so a tie cannot arise, deterministically. Guard 4 pins the rule |
| Weakening the empty-file protection the pass was built for | An empty file has no lines, so no quote can match → the motivating case can never be re-anchored. Guard 2 uses exactly that fixture |
| Slice B re-inflates FP burden | Floor stops at WARN; already-INFO security stays droppable (guard 8). pilot-03 reports FP burden, though pilot-02 showed M2 has no signal in this rig |
| `FindingSchema` change breaks older persisted artifacts | Field is `.optional()`, mirroring `fact_invalid`/`scope_demoted` |
| pilot-03 conflates the two slices | Slice B is isolated by the existing `−critic` ablation; Slice A is reported as a count of `anchor_repaired`. Stated as a limitation, not papered over |
| n = 1 observed mis-anchor, n = 3 landed seeds | The fix is justified by mechanism, not sample size, and the write-up says so. A pilot-03 with 0 repairs is an unexercised path, not a refutation |

# Closing the true-positive hole pilot-02 exposed

_2026-08-05. Task (b) from `NEXT_SESSION.md`, following
`docs/dev/2026-08-05-pilot-02-result.md` and the measurement fixes in
`docs/superpowers/plans/2026-08-05-rig-measurement-fixes.md` (task (a), `5a1f94f`)._

## The evidence this design starts from

pilot-02's turn 2 seeded a path traversal. The panel **detected it twice**. Both detections
ended at INFO, the turn recorded 0 blocking findings, and M3 scored a miss.

Read the recorded findings yourself:

```bash
bun -e 'const j = JSON.parse(await Bun.file("rig/results/pilot-02/turns/2/.reviewgate/pending.json").text());
for (const f of j.findings) console.log(f.id, f.rule_id, f.severity, f.category, f.file, f.line_start, f.confidence, f.consensus, f.critic_verdict ?? "", f.scope_demoted ?? "")'
sed -n '1,10p' rig/results/pilot-02/turns/2/diff.patch
```

| | rule_id | line_start | conf | consensus | what demoted it |
|---|---|---|---:|---|---|
| F-001 | `path-traversal-readtemplate` | **25** | 0.55 | singleton | critic → `likely_fp` |
| F-002 | `path-traversal` | **67** | 0.90 | singleton | `scope_demoted` |

`src/store.ts` is a **brand-new 27-line file** in that turn's diff (`@@ -0,0 +1,27 @@`), so
every line of it is inside the changed ranges. **F-002 is anchored at line 67 — past EOF of a
file that is entirely in-diff.** Nothing in `src/providers/review-output.ts` or
`src/schemas/finding.ts` validates a line anchor against the file it names; `FindingSchema` only
requires `z.number().int().positive()`.

That single bad anchor produced all three of the failures the pilot-02 write-up attributes to
independent mechanisms:

1. **F-002 was scope-demoted** (`aggregator.ts:352`) as "outside the changed lines". It was never
   out-of-diff — it was mis-anchored.
2. **The two findings never merged.** 25 and 67 are 42 lines apart, past both `REGION_WINDOW`
   (5, `:192`) and `WORDING_MERGE_MAX_LINE_DISTANCE` (25, `:229`).
3. **No merge meant no corroboration.** `computeConsensus(1, 2)` is `"singleton"`; merged, it
   would be `computeConsensus(2, 2)` → `"majority"` → `isCorroborated` at `:610` → **the critic
   could not have demoted F-001 at all.**

So the handoff's candidate (2) — "merge same-file/same-category detections before the critic" —
addresses a symptom. These two findings did not need a broader merge rule; they needed one
reviewer not to invent a line number.

The handoff's candidate (1) remains a real defect on its own merit, independent of turn 2: the
critic's exemption is keyed to CRITICAL (`:604`), while the sibling `deltaScoped` pass exempts
`touchesSecurityOrCorrectness` at **any** severity (`:664`). A WARN-severity security finding is
demotable by a single adversarial critic, and that demote crosses the blocking boundary.

## Scope

Two independent slices, both in `src/core/aggregator.ts`, neither touching the reviewer or
provider layer. Both are **always-on** — they are defect corrections, and the sibling
protections they mirror (G0's clamp at `:155`, `isCriticalSecurity` at `:604`, delta-scope's
exemption at `:664`) are all unflagged. Observability comes from markers a pilot can count, not
from config toggles; no new config key, and therefore no second TTY control-plane approval.

### Explicitly out of scope

- **Merge/clustering changes.** Widening the merge to same-file/same-category would bundle
  genuinely separate security bugs under one decision, which `isHighStakesCategory` (`:279`)
  exists to prevent.
- **An invalid anchor still participates in region clustering**, so a bogus line 67 could merge
  with a real finding at line 65. This risk exists today, did not fire in turn 2, and removing
  it means changing merge behaviour — a third change with its own blast radius.
- **M5 critic cost attribution** (`orchestrator.ts:2300`) stays scoped out; it is a
  provider-contract change, as recorded in the task-(a) plan.

## Slice A — anchor integrity

Policy, chosen deliberately: **an out-of-range anchor is treated exactly like a missing one.**
`scopeFindings` already carries that precedent in the same function —
`if (!f.line_start) return f; // no usable line → keep (conservative)` (`:330`). A reviewer that
cites line 67 of a 27-line file has given us no usable location, and the fail-safe direction in
this codebase is that a suppressor must never silently soften a finding it cannot place.

The rejected alternative is re-anchoring the finding into the nearest changed range. It would
additionally recover the merge path, but the gate would then be asserting a location the
reviewer never gave — the gate would be lying about where the bug is.

### Detect

A new pass immediately after the path-normalize / `demoteRedaction` map (`:429-432`), before the
deterministic sort and clustering. For each finding whose file has a **known** line count:

```ts
if (lineCount !== undefined && f.line_start > lineCount) → { ...f, anchor_invalid: true }
```

Stamp only. No severity change here, so the pass is inert on its own and its effect is entirely
attributable to the consumer below.

The pass runs **unconditionally**, not inside `scopeFindings` — that function returns early when
`scopeToDiff` is false or `changedRanges` is absent (`:317`). Detecting separately means a
mis-anchoring reviewer is still visible in `pending.md` on a repo that has diff-scoping turned
off, where the flag changes nothing else.

**`line_end` does not participate.** Reviewers routinely over-estimate `line_end` as a sloppy
range hint; if `line_start` names a real line the finding *is* anchored somewhere real, and
`rangeOverlapsChanged` (`src/diff/hunks.ts:116`) already handles the range. Stamping on
`line_end` would fire on ordinary findings and switch off scope-demoting broadly — a fail-open,
which is the exact direction this slice exists to close. Guard test 2 pins this.

### Act

`scopeFindings:330` becomes:

```ts
if (!f.line_start || f.anchor_invalid) return f; // no usable line → keep (conservative)
```

### Input

`AggregateInput` gains:

```ts
/** Line counts of the files this diff changed, for anchor validation. An entry is present
 *  ONLY when the file was read successfully. Absent map, or an absent entry, means UNKNOWN —
 *  no anchor on that file is ever stamped, and behaviour is byte-identical to before this
 *  field existed. Same optional-input compatibility rule `seedLanded` and `criticRuns` follow. */
fileLineCounts?: Map<string, number>;
```

The orchestrator builds it at the `aggregate()` call site (`orchestrator.ts:2451`) from the
changed-file set, using `readFileSync` under `this.input.repoRoot` (already imported at
`orchestrator.ts:7`). Keys are `normalizeRepoPath`-canonical, matching `changedRanges`.

### Schema and rendering

`FindingSchema` gains `anchor_invalid: z.boolean().optional()`, alongside `scope_demoted`
(`finding.ts:81`) and `protected_high_precision` (`:191`).

`report-writer.ts` gains one badge next to the existing `📍 outside changed lines` (`:57`), e.g.
`⚑ the reviewer cited a line that does not exist in this file — location unverified, kept
blocking`. The badge is the diagnostic that made this whole slice findable; without it a
mis-anchoring reviewer is invisible.

## Slice B — critic severity floor

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

**Why the floor stops at WARN and not lower.** The stated harm is a demote that crosses the
blocking boundary (`isBlocking` is `CRITICAL || WARN`). WARN → INFO crosses it; INFO → drop does
not, and low-confidence INFO security chatter is the noisiest thing the critic filters. Making
security wholly critic-immune would re-inflate FP burden in a way pilot-02 has **zero data** on
(`rejectedAsFp` was 0 on every turn, `known_fp.jsonl` ended the run empty). Guard test 5 pins
that the floor does not over-apply.

**Blast radius.** `demoteOneStep` (`:155`) is unchanged — a WARN security finding simply never
reaches it from the critic pass. The reputation and confidence-floor passes are untouched; they
already carry their own hard security veto (`touchesSecurity`, `:285`).

## Data flow

```
reviewers  →  findings (line_start unvalidated)
orchestrator:2451   changedRanges  = parseChangedRanges(diff)
                    fileLineCounts = line counts of changed files      ← new
aggregate():   normalize paths + demoteRedaction
               markInvalidAnchors                                      ← Slice A detect
               sort → cluster → dedupe → consensus
               critic pass                                             ← Slice B floor
               scopeFindings                                           ← Slice A act
               deltaScope → fp-ledger → reputation → verdict
report-writer: anchor_invalid badge
```

## Fail-safety

Each row states its failure direction, not just its behaviour.

| Condition | Behaviour | Why |
|---|---|---|
| `fileLineCounts` absent entirely | Both slices inert; output byte-identical to today | Optional-input compatibility, as `seedLanded`/`criticRuns` |
| File missing, unreadable, binary, or over a byte cap | **No entry** → anchors on that file never stamped | Unknown must stay unknown; never guess a line count |
| Finding on a file the diff did not change | No entry → demotes on the file-absent branch (`:332`) as today | Anchor validation must not rescue findings on unchanged files |
| `line_start` valid, `line_end` past EOF | **Not stamped** | Stamping here would fail open; see Slice A |
| Anchor invalid **and** severity already INFO | Kept and flagged, and **`scope_demoted` is no longer stamped** on it | `demote()` (`:325`) stamps the marker even on INFO, and `report-writer.ts:498` buckets on it. Such a finding moves from the "outside changed lines" list to the in-scope advisory list — correct, since we do not know it is outside. A deliberate, visible consequence, not an oversight |

## Measurability, stated honestly

`SUPPRESSION_LAYERS` (`src/rig/ablate.ts:44`) is `["critic","reputation","fp-ledger","lore"]` —
there is no `scope` or `anchor` layer, and the ablation reconstructs a layer's counterfactual by
reading the demotion markers it left behind.

- **Slice B stays fully ablatable.** A protected finding carries `critic_verdict: "keep"`, and
  `−critic` shows no recall delta where the floor held.
- **Slice A is observable, not ablatable.** pilot-03 can count `anchor_invalid` findings and how
  many stayed blocking; it cannot produce a counterfactual matrix row for the slice. The pilot-03
  write-up must say this rather than let the matrix imply coverage it does not have.

## Testing

Every guard test carries the two numbers of the quantity it guards. A test whose two values match
is vacuous **on paper** and is rewritten before it is written.

| # | Guards | WITHOUT the mechanism | WITH it |
|---|---|---|---|
| 1 | Invalid anchor is not scope-demoted (turn-2 shape: 27-line new file, finding at line 67) | INFO + `scope_demoted` → **0 blocking** | WARN + `anchor_invalid` → **1 blocking** |
| 2 | Does not over-apply — a *valid* out-of-diff anchor still demotes. Mutation: stamp on `line_end > lineCount` | over-broad predicate → **1 blocking** | correct predicate → **0 blocking** |
| 3 | Inert without `fileLineCounts` — one fixture, map present vs absent | map absent → **0 blocking** | map present → **1 blocking** |
| 4 | WARN + security + `likely_fp` survives the critic | INFO + `critic_verdict: likely_fp` → **0 blocking** | WARN + `critic_verdict: keep` → **1 blocking** |
| 5 | Floor does not over-apply — INFO + security + `likely_fp` is still dropped | "exempt at every severity" variant → `criticDropped` **0** | correct floor → `criticDropped` **1** |
| 6 | Floor is category-keyed, not severity-keyed — WARN + *quality* still demotes | severity-only variant → **1 blocking** | correct floor → **0 blocking** |

Each is seen **red** first, in a copy of the repo; the original is confirmed unmodified with
`git diff` after each copy is discarded.

**Acceptance on real data, labelled honestly.** A fixture reconstructed from turn 2's recorded
`pending.json` — both findings, their actual lines, categories, confidences and consensus —
showing the turn flip from 0 blocking to blocking. This is a **reconstruction, not a replay**:
the archived findings are post-aggregation, so the pre-aggregation input is inferred from the
demotion markers, exactly as `ablate.ts` does. The write-up must not call it a replay.

**Static gates.** `bunx tsc --noEmit`, `bun run lint`, and the full `bun test` — `FindingSchema`
changes, so the persisted-artifact suite runs whole.

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
| Slice A rescues findings it should not, weakening diff-scoping generally | Only `line_start` past a **known** EOF stamps; unknown stays unknown. Guard tests 2 and 3 pin both over-application modes |
| Slice B re-inflates FP burden | Floor stops at WARN; already-INFO security stays droppable (guard 5). pilot-03 reports FP burden, though pilot-02 showed M2 has no signal in this rig |
| `fileLineCounts` costs I/O on every gate run | Bounded to the changed-file set, one `readFileSync` each, byte-capped; the research phase already reads these files |
| `FindingSchema` change breaks older persisted artifacts | Field is `.optional()`, mirroring `scope_demoted`/`protected_high_precision` |
| pilot-03 conflates the two slices | Slice B is isolated by the existing `−critic` ablation; Slice A is reported as a count of `anchor_invalid`. Stated as a limitation, not papered over |
| n = 3 landed seeds cannot establish an effect size | Same limit as pilot-02, restated in the write-up. This detects signal, not magnitude |

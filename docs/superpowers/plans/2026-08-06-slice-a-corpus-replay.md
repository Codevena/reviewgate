# Plan — the offline Slice A corpus replay

_2026-08-06. The next cut named by `NEXT_SESSION.md` after pilot-03: measure Slice A offline
instead of spending a fourth pilot on a once-in-36-turns event. Design under test:
`docs/superpowers/specs/2026-08-05-true-positive-hole-design.md`. Result to beat:
`docs/dev/2026-08-06-pilot-03-result.md`._

## The question

Slice A (`reanchorByEvidence` inside `validateFindingFacts`) has fired **0 times in the field**.
The pilot-03 write-up reports its opportunity denominator as **0 in 12 turns**, and across pilots
01–03 as **1 in 36 turns**, derived from `anchor_repaired + fact_invalid` counted over the
archived reports. At that base rate no 12-turn pilot has power, so the instrument is a replay:

> Replay every recorded raw reviewer finding from all three pilots through the **real**
> `validateFindingFacts` and count out-of-range citations (opportunities), repairs, and demotes.

## What the exploration already established (facts, not assumptions)

Each of these was checked before this plan was written; the numbers are reproducible with the
commands in the appendix.

1. **The archived reports are the WRONG corpus, and the published denominator inherits their
   bias.** `rig/results/*/turns/*/reports/*-pending.json` holds 90 rows that are
   **post-aggregation survivors** — a finding the critic dropped, or one folded into a merge, is
   either absent or projected into `members[]`. The pre-aggregation reviewer output that
   `validateFindingFacts` actually sees is recorded elsewhere: **`cassette.jsonl`**, whose
   `method:"review"` entries carry full `Finding` objects (`file`, `line_start`, `evidence_line`,
   `details` — verified against the ground-truth finding below).
   Raw findings: **pilot-01 = 44, pilot-02 = 24, pilot-03 = 27 (95 total)**.
2. **Cassette entries are exactly turn-attributable.** `manifest.turns[].cassetteBytes
   {before, after}` is sampled around each turn (`driver.ts:331,361`). Verified for all three
   runs: the ranges are contiguous and cover `[0, fileSize]` exactly. pilot-03's dead turns 5/6
   have empty ranges, which is the correct behaviour and not a gap.
3. **The per-turn working tree is exactly reconstructable for pilots 02/03.**
   `turns/<T>/diff.patch` is the CUMULATIVE working tree against the base commit
   (`driver.ts:290`). `git apply` into an **empty** `git init` dir reproduces it — no dependency
   on the `/private/tmp` sandboxes (which the handoff lists for reaping). Verified two ways:
   turn-12 reconstruction matches the archived `final-tree/` for `src/**`, and pilot-02 turn 2
   yields a **27-line** `src/store.ts` whose **line 26** is verbatim the spec's quoted evidence.
4. **pilot-01 recorded no `diff.patch` at all** (the driver gained it after that run), but its
   per-turn line counts survive in `.reviewgate/research.md` — the `## Changed files` rows
   `- <path> (<kind>, +N/-0)`. For a file created after the review base, `N` **is** the line
   count. Validated on pilots 02/03 where both sources exist: **26 of 26 file instances agree
   exactly, 0 mismatches.** (A first draft of this plan said 22/22; the plan-gate reviewer
   recomputed it and corrected the count.)
5. **The published "1 opportunity in 36 turns" is almost certainly too low.** In pilot-02 turn 2
   alone the raw cassette holds **five** findings citing lines 49/65/67 of that 27-line file;
   only one survived aggregation to be counted. This is the result the replay exists to
   establish properly, and it is why the corpus choice in (1) is load-bearing rather than
   cosmetic.

## Deliverable

1. `rig/scripts/anchor-replay.ts` — offline, read-only, no network, no agent quota, no rebuild.
2. `docs/dev/2026-08-06-slice-a-corpus-replay.md` — the write-up.

Companion to the existing `rig/scripts/anchor-markers.ts` and carrying the same header
discipline: what it is, what it is NOT, and the pre-existing numbers it reproduces before it is
trusted on anything new.

## Method

Per run in `{pilot-01, pilot-02, pilot-03}`:

1. Slice `cassette.jsonl` by `manifest.turns[].cassetteBytes`; keep `method === "review"` entries;
   each carries `result.findings: Finding[]`.
2. Materialise the turn's tree: `git init` an empty temp dir, `git apply turns/<T>/diff.patch`.
   pilot-01 has no patch → **line-count mode** (see below).
3. Call the real, imported `validateFindingFacts(findings, tmpRoot, deletedPaths)` from
   `src/core/fact-check.ts`. **Not a reimplementation** — the point is to execute the shipped
   pass, so the numbers cannot drift from the binary's behaviour.
   `deletedPaths` is derived from the patch's `deleted file mode` headers (expected: empty).
4. Classify each finding by the markers the pass itself wrote: untouched (in range),
   `anchor_repaired` (repaired), `fact_invalid` (demoted).

**pilot-01 line-count mode.** No content means no repair/demote split; it means an exact
**in-range vs out-of-range** classification from the research.md line count (fact 4). The script
computes that separately and, if any pilot-01 finding is out of range, reports it as an
opportunity whose split **is not computable from the archives** — it must not silently drop out
of the denominator, and it must not be guessed from the final tree. Exploration indicates the
count is 0, but the script must derive that rather than assume it.

## The two numbers, per guard

Per the plan-gate rule, every check carries what the guarded quantity is WITH and WITHOUT the
mechanism. A check whose two values match is vacuous on paper and is not written.

| # | Guards | WITHOUT | WITH |
|---|---|---|---|
| 1 | **Ground truth.** pilot-02 turn 2 `path-traversal` CRITICAL cited at 67 | Slice A absent → `fact_invalid`, `line_start` **67**, repairs **0** | repaired, `line_start` **26**, `anchor_repaired`, repairs **≥1** |
| 2 | **Tree reconstruction is real.** The same finding, tree not materialised | file absent → pass fails safe → opportunities **0** | 27-line file → pilot-02 turn 2 opportunities **5** |
| 3 | **Per-turn cassette slicing.** Attribution by byte range | whole-file scan → **95** findings attributed to every run | **44 / 24 / 27** |
| 4 | **research.md line counts.** pilot-01 turn 9 `src/notify.ts` | symbol-graph max line (L119) → L116/L119 read as out of range | `+132/-0` → **132** lines → both in range |
| 5 | **Corpus choice.** Opportunity denominator over pilot-02 turn 2 | archived reports (survivors) → **1** | raw cassette → **5** |
| 6 | **`normalizeLine` replication** (private to `fact-check.ts`) — the secondary measurement needs it | a drifted copy silently mis-splits in-range mis-anchors | cross-checked against the real `attestEvidence`: the "quote matches NO line" sets must be identical |

Guards 1 and 2 are run as assertions inside the script and each is seen **red** once, in a copy
of the repo, by disabling the mechanism it guards — mutation inside the task, not as a block at
the end.

## Self-checks the script prints before any headline number

A replay that silently mis-slices produces confident nonsense, so the harness states its own
integrity first:

- cassette byte ranges contiguous and covering `[0, fileSize]`; a malformed line at any slice
  boundary is a hard abort, not a skipped row;
- raw finding totals reproduce **44 / 24 / 27**;
- `git apply` exit status per turn — a failed patch is an abort for that turn, never a silently
  empty tree (which would read as "no opportunities");
- the pilot-02 turn-2 ground-truth assertion (guard 1).

## Exactness flag — the one real bias, stated per finding

`diff.patch` is captured **after the agent exits**, but a turn can run several gate iterations,
and the agent edits between them. A finding from a **non-final** panel run was therefore reviewed
against a possibly **shorter** file than the one reconstructed.

~~The bias has a known direction: the reconstructed file is the longer one, so a cited line is
more likely to read as in range. **Out-of-range is undercounted; every opportunity count is a
LOWER BOUND.** That direction is what makes the headline safe — "at least N opportunities"
survives it.~~

~~Per finding the script emits `EXACT` when it came from the turn's final panel run, else
`LOWER-BOUND`, and reports the split. (Cassette entries are ordered, so the panel run a finding
belongs to is recoverable.) A turn whose iteration count exceeds its panel-run count had a
cache-served iteration after the last panel run; those findings are `LOWER-BOUND` too.~~

> **CORRECTED DURING IMPLEMENTATION (both points above are wrong — kept, struck through, so the
> plan does not read as if it got this right).**
>
> 1. **The bias has no direction.** The agent's fix between panel runs can *shorten* a file as
>    easily as lengthen it, which invents an out-of-range citation rather than hiding one. So
>    these findings are **UNVERIFIABLE**, not a lower bound, and the script labels them that way.
>    The run itself surfaced this: pilot-02 turn 9 cites line 144 of a 58-line file, which only
>    reads as a real opportunity once you can show the file was never 144 lines.
> 2. **"Final panel run" alone does not establish the tree**, and the cache argument this plan
>    leaned on was never checked by the code. The review gate caught it. The shipped script
>    requires a second, independent record: the turn's **final gate iteration must have run the
>    panel** (`run_summary.source` in the audit tree), and the two records are cross-checked per
>    turn on the panel-run count.

## Secondary measurement — sizing the candidate next slice

Both pilots keep circling reviewers that **mis-number a line they quote correctly**. Slice A
covers only the half detectable by a range check; pilot-03 turn 4 produced an **in-range**
instance (cites line 37, quotes line 40) that no pass inspects.

The same replay sizes that population for free: among **in-range** findings carrying
`evidence_line`, count those whose quote matches a **different** real line of the cited file
(the comparison `attestEvidence` already computes at `orchestrator.ts:2573`, render-only).

Reported in a **separate** table under its own heading. It is not Slice A's number and must never
be added to it. `NEXT_SESSION.md` calls this "a candidate slice, not a decided one" — this
measurement is what would decide it, and it is explicitly *input to* that decision, not the
decision.

## Out of scope

- **No `src/` change, no rebuild.** The build re-pins the binary and deploys machine-wide through
  the `~/.local/bin/reviewgate` symlink. This task changes no gate behaviour.
  > **CORRECTED during implementation:** two `src/` changes were made, both one word — `export`
  > on `normalizeLine` and on `lineCount` in `src/core/fact-check.ts`, so the replay imports them
  > instead of carrying copies. The review gate showed the copies' drift guard did not cover the
  > numbers they feed. **No gate behaviour changed and nothing was rebuilt**, which is what the
  > constraint was actually protecting; the no-`src/`-change wording was a proxy for it and was
  > too strict.
- **No pilot-04**, and no change to the rig stale-report defect (it needs a rebuild).
- **No re-scoring of pilot-03's published metrics.** Recall, escape rate and the ablation stand;
  this replay speaks only to Slice A's base rate and split.
- **No promotion of the result into the spec's risk table** in the same change.

## Risks

| Risk | Handling |
|---|---|
| Replaying a corpus the pass already processed | The cassette is the reviewers' **raw** output, recorded at the provider boundary before any gate pass. Independently confirmed: the ground-truth finding still carries `line_start: 67`, the value the shipped pass demoted but never rewrote |
| The reconstructed tree is not what the reviewer saw | ~~Bounded and directional — every count is published as a lower bound~~ **CORRECTED during implementation: the error has NO direction** (a fix can shorten a file as easily as lengthen it, inventing an opportunity rather than hiding one). Affected findings are labelled **UNVERIFIABLE**, never a bound. Exactness is established on two independent records — final panel run (cassette) AND the turn's final gate iteration ran the panel (audit tree) — cross-checked per turn. See the correction block above |
| pilot-01 silently dropped for lacking `diff.patch` | It is 44 of 95 findings and 12 of the 36 turns; line-count mode keeps its in/out classification exact, and an unsplittable opportunity is reported as such |
| A repair that is right on the corpus but wrong in general | The replay measures **base rate and split**, not correctness. Slice A's correctness rests on its unit tests; this cannot and does not claim otherwise |
| `rig/results/` is gitignored | The script is committed, its inputs are local-only — same as `anchor-markers.ts`. The write-up must say the numbers are not reproducible off this machine |
| Result contradicts the pilot-03 write-up's "1 in 36 turns" | Then the write-up is corrected in place rather than appended to, and the correction says the earlier figure counted post-aggregation survivors |

## Appendix — commands the facts above came from

```bash
# fact 1/2: raw findings per run, sliced by manifest byte offsets
bun run rig/scripts/anchor-replay.ts --integrity
# fact 3: reconstruction == archived final tree
git init -q /tmp/t && git -C /tmp/t apply rig/results/pilot-02/turns/2/diff.patch
wc -l < /tmp/t/src/store.ts            # 27
sed -n '26p' /tmp/t/src/store.ts       # the evidence_line, verbatim
# fact 4: research.md +N/-0 vs reconstructed line count, pilots 02/03 — 22/22 agree
```

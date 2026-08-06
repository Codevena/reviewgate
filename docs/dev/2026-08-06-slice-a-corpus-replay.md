# Slice A corpus replay — the base rate was measured on the wrong population

_2026-08-06. The offline cut `NEXT_SESSION.md` named after pilot-03, instead of a fourth pilot.
Plan: `docs/superpowers/plans/2026-08-06-slice-a-corpus-replay.md`. Instrument:
`rig/scripts/anchor-replay.ts`. Design under test:
`docs/superpowers/specs/2026-08-05-true-positive-hole-design.md`._

## Headline

**Slice A is not a once-in-36-turns event. It is a 7-instance event, and the shipped pass
repairs all 7.**

The published denominator — "1 opportunity in 36 turns" — counted `fact_invalid` markers in
`rig/results/*/turns/*/reports/*-pending.json`. Those are **post-aggregation survivors**.
`validateFindingFacts` runs **pre-aggregation** (`orchestrator.ts:2226`), so a finding the critic
dropped or a merge folded away never reaches that file. Replaying the reviewers' **raw** output
(`cassette.jsonl`, recorded at the provider boundary) through the real, imported pass gives:

| | archived reports | raw corpus replay |
|---|---:|---:|
| reviewer findings examined | 90 rows (survivors, re-rendered per iteration) | **95 raw findings** |
| out-of-range citations = **Slice A opportunities** | **1** | **7** |
| repaired | 0 (mechanism absent from the pilot-01/02 binaries) | **7** |
| demoted as fabricated | 1 | **0** |

**pilot-03's own claim survives intact**: its opportunity denominator really was 0. So does
pilot-01's. All 7 opportunities are in **pilot-02**, and 5 of them in a single turn.

## The instrument, and why its inputs are the right ones

| | |
|---|---|
| Corpus | `method:"review"` entries in each run's `cassette.jsonl` — the reviewers' raw `Finding` objects, before any gate pass |
| Turn attribution | `manifest.turns[].cassetteBytes {before, after}`, sampled around each turn (`driver.ts:331,361`). Verified in all three runs to tile `[0, filesize]` with no gap or overlap |
| Working tree | `turns/<T>/diff.patch` — the CUMULATIVE tree against the base commit (`driver.ts:290`) — applied with `git apply` into an **empty** `git init` dir. No dependency on the `/private/tmp` sandboxes |
| The pass | the real `validateFindingFacts` **imported** from `src/core/fact-check.ts`, never reimplemented. `normalizeLine` is imported from there too — it was a local copy until the review gate pointed out the copy's drift guard did not cover the number it protects, so `fact-check.ts` now exports it. `lineCount` likewise. Both are exports, not rewrites — no behaviour change |

It refuses to produce a number it cannot stand behind: a torn line at a slice boundary, a patch
that fails to apply, a corpus size that does not reproduce **44 / 24 / 27**, or a failed
ground-truth assertion each abort the run with exit 1. An unapplied patch would otherwise leave
an empty tree in which every file is absent, the pass fails safe, and the output reads exactly
like "no opportunities" — the failure this measurement is most vulnerable to.

Four self-checks pass before any headline number is printed:

```
  self-check · ground truth   : pilot-02 turn 2 path-traversal cited 67 in a 27-line file → REPAIRED to 26 ✔
  self-check · cassette tiling: contiguous, covers every byte in all 3 runs ✔
  self-check · corpus size    : 44 / 24 / 27 raw findings reproduced ✔
  self-check · quote reading  : agrees with attestEvidence on all 36 in-range quoted findings ✔
```

## The 7 opportunities

```
  run        turns   raw  in-range  absent  OPPORTUNITY  repaired  demoted
  pilot-01       7    44        44       0            0       n/a      n/a   ← line-count mode
  pilot-02       6    24        17       0            7         7        0
  pilot-03       7    27        27       0            0         0        0
  TOTAL         20    95        88       0            7         7        0
```

| run · turn | file | cited | of | severity/category | repaired to | rule |
|---|---|---:|---:|---|---:|---|
| pilot-02 t2 | `src/store.ts` | 67 | 27 | **CRITICAL/security** | **26** | `path-traversal` |
| pilot-02 t2 | `src/store.ts` | 49 | 27 | WARN/correctness | 9 | `key-equality-unconstrained` |
| pilot-02 t2 | `src/store.ts` | 65 | 27 | WARN/architecture | 25 | `mixed-concerns` |
| pilot-02 t2 | `src/store.ts` | 67 | 27 | **WARN/security** | 26 | `sync-io-blocking` |
| pilot-02 t2 | `src/store.ts` | 65 | 27 | WARN/testing | 25 | `no-error-handling` |
| pilot-02 t9 | `src/notify.ts` | 144 | 58 | WARN/correctness | 36 | `unsafe-payload-type` |
| pilot-02 t9 | `src/notify.ts` | 127 | 58 | INFO/quality | 19 | `hardcoded-fallback-endpoint` |

**Turn 9 is new.** The design was built from turn 2, which was known. Nothing in any pilot
write-up mentions turn 9, because both of its out-of-range findings were gone before the report
was written. Under the pilot-02 binary all seven took the demote path and were told, at up to
0.90 confidence, that they were "almost certainly hallucinated".

### Every one of the 7 sits on a tree the reviewer saw — established on two records

`diff.patch` is captured after the agent exits, so a finding reviewed mid-turn could have been
judged against a different file. The script establishes the tree's identity from two independent
records, and requires **both**:

1. the finding came from its turn's **final panel run** — from the cassette;
2. that turn's **final gate iteration ran the panel** (`run_summary.source === "panel"`, as
   opposed to `"skipped"`) — from the append-only audit tree, differenced per turn.

A rig turn ends when the gate allows the stop, so the final iteration's tree **is** the
end-of-turn tree; if that iteration ran the panel, the panel saw exactly the reconstructed tree.
**39 of 95 findings satisfy both, and all 7 opportunities are among them.**

The two records are also checked against each other: for every turn, the number of panel runs in
the cassette must equal the number of `panel` iterations in the audit log, or the run aborts.
They agree everywhere.

> An earlier version of this script asserted instead that "a later iteration served from the
> review cache proves the diff did not change" — and never checked that such an iteration
> existed. The review gate caught it: the condition was necessary, not sufficient. It is now
> measured rather than argued. The numbers did not move; the justification did.

The other 56 findings are reported as **UNVERIFIABLE, not as a bound**. The plan first called
them a lower bound; that was wrong. The agent's fix between panel runs can lengthen a file (a
real opportunity vanishes) or shorten it (a phantom one appears), so the error has no sign.
Nothing in the headline rests on them.

### The repairs land on the right code (spot-check, n = 2)

The replay measures base rate and split, not correctness — that rests on
`tests/unit/fact-check-reanchor.test.ts`. But the two turn-9 repairs were checked by hand, and
both land on the line the finding is actually about:

- `unsafe-payload-type` cited 144, repaired to **36** — `export async function sendReport(payload: object): Promise<void> {`, the signature whose `object` type is the defect.
- `hardcoded-fallback-endpoint` cited 127, repaired to **19** — `process.env.REPORTING_ENDPOINT ?? 'https://reports.example.invalid/v1/reports'`, literally the hardcoded fallback.

`src/notify.ts` was 58 lines. The same reviewer, in the same call, cited 16 and 50 correctly and
127 and 144 impossibly.

## The reviewers' line numbers are unreliable in general

The replay sizes the population the handoff called "a candidate slice, not a decided one":
findings whose cited line **exists** but whose own quote is a different real line. No pass
inspects these — `validateFindingFacts` only ever runs past EOF.

Restricted to trees the reviewer provably saw:

| in-range findings carrying a quote | 16 |
|---|---:|
| quote matches the cited line | **4** |
| quote matches a **different** real line — in-range mis-anchor | **7** |
| quote matches no line (already badged `evidence_mismatch`) | 5 |

**Only 4 of 16 in-range quoted findings are anchored to the line they quote.** Over all 36
in-range quoted findings, including unverifiable trees, the split is 6 / 20 / 10 — an upper
bound, since a stale tree makes a correct anchor look wrong. This measurement's bias runs
opposite to Slice A's, which is why it is reported separately and on the exact subset first.

The 7 include pilot-03 turn 4's `injection-via-case-mismatch` (cites 37, quotes 40) — the
instance the pilot-03 write-up identified by hand. The replay finds it without being told, which
is the closest thing to an external check this instrument has. Two more, verified by hand:
`weak-token-validation` cites `src/notify.ts:16` while quoting line 9; `range-overflow` cites
`src/array.ts:28` while quoting line 31. The offsets are small — 2, 3, 7 lines — and the quotes
are correct. This is not fabrication; it is arithmetic.

**This does not decide the slice.** n = 16, one panel, two models. It is input to the decision,
not the decision.

## What this changes

- **Slice A's field record.** It was "mechanism proven by a unit test, never observed firing".
  It is now 7 observed instances across 36 turns, all repaired, including the CRITICAL that
  motivated the design and a second cluster nobody knew about. The change is in the evidence, not
  in the code — the pass is unchanged and was not rebuilt.
- **The measurement lesson, which generalises past Slice A.** Every rate this rig computes from
  `reports/*-pending.json` is a rate over **survivors**. For any pass that runs before
  aggregation, that is the wrong denominator, and it is wrong in the direction that makes the
  pass look useless. The cassette is the pre-aggregation record and it was already being written.
- **`docs/dev/2026-08-06-pilot-03-result.md` is corrected in place**, not appended to: its
  "one opportunity in 36 turns" is superseded. Its pilot-03-specific claim (denominator 0, not
  exercised) stands and is confirmed here.
- **Not changed:** the design spec's risk table, pilot-03's recall/escape/ablation numbers, and
  Slice B's open FP question, which this replay says nothing about. **No gate behaviour changed
  and nothing was rebuilt** — the two `src/` edits are bare `export` keywords, described at the
  end of this document.

## How to read these numbers

- **The corpus is 3 runs of one panel** (`deepseek-v3.2` security + `glm-5.2:cloud` correctness).
  A different panel is a different system; nothing here transfers to a panel with codex.
- **7 opportunities across 36 turns is not a uniform rate.** They cluster in 2 turns. The
  per-turn base rate is the wrong summary; "5 in one turn, then none for 10" is the shape.
- **pilot-01 ran in line-count mode.** It recorded no `diff.patch`, so per-turn line counts come
  from `.reviewgate/research.md`'s `+N/-0` changed-file rows — a method validated 26/26 against
  reconstructed trees on pilots 02/03. That yields an exact in-range/out-of-range split (0
  out-of-range) but no file content, so had an opportunity existed there, its repair/demote split
  would have been reported as not computable rather than guessed.
- **`rig/results/` is gitignored.** The script is committed; its inputs exist only on this
  machine. The numbers above are not reproducible elsewhere without the artifacts.

## Reproducing

```bash
bun run rig/scripts/anchor-replay.ts            # the tables above
bun run rig/scripts/anchor-replay.ts --verbose  # one line per finding
```

Every guard was seen red in a **copy** of the repo, the original confirmed unmodified afterwards:

| mutation | result |
|---|---|
| `reanchorByEvidence` returns `null` (Slice A disabled) | `ABORT — ground truth NOT reproduced: … got demoted→null in 27 lines`, exit 1 |
| the patch is never applied (empty tree) | `ABORT — … got file-absent→null in null lines`, exit 1 |
| `normalizeLine` drops its normalization | `ABORT — … disagrees with attestEvidence`, exit 1 |
| the audit delta reports one extra panel iteration | `ABORT — the cassette shows 1 panel run(s) but the audit log shows 2`, exit 1 |
| the turn's last iteration is reported as not-panel | exactness collapses **39/95 → 0/95**, and **7 → 0** exact opportunities |

The last two are what keep the exactness claim honest: without the audit condition the label is
free, and mutation 5 shows the whole claim rests on it.

**The only `src/` changes in this work are two `export` keywords:** on `normalizeLine` and `lineCount`. No gate
behaviour changed and nothing was rebuilt, so the installed binary is still
`sha256:fc9b8c18…`. Full suite re-run after that change: see the commit message.

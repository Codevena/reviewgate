# Correction — pilot metrics after the rig stale-report defect

_Published 2026-08-10. This preserves the pre-fix record and reports an offline re-harvest of
pilot-01, pilot-02 and pilot-03._

## Defect and scope

The rig archived a previous turn's final pending report again at the start of the next turn, and
the harvester treated that inherited report as if the later turn had produced it. Across the three
pilots, 31 of 36 turns inherited a report; 13 of 36 turns consequently counted findings they did
not produce, and 9 of those 13 turns produced no findings of their own. The corrected ownership
rule counts a report only in the turn whose audit delta owns its `run_id`.

## Metrics before correction

This table was captured before the fix. It is retained verbatim so the correction cannot be
back-fitted to the new output.

| | pilot-01 | pilot-02 | pilot-03 |
|---|---|---|---|
| recall | 0.60 (3/5) | 0.33 (1/3) | 1.00 (2/2) |
| escape rate | 0.20 (1/5) | 0.67 (2/3) | 0.00 (0/2) |
| M2 slope | 0.0239/turn (n=10) | 0.0000/turn (n=9) | 0.0014/turn (n=9) |
| iterations median | 1 over 12 reviewed | 1 over 12 reviewed | 1 over 10 reviewed |
| cost | $0.0236 | $0.0125 | $0.0136 |

## Metrics after correction

These values come from a fresh offline re-harvest with the corrected source harvester. All three
commands exited successfully. The ownership filter emitted 11 `EARLIER turn` warnings for
pilot-01, 11 for pilot-02 and 9 for pilot-03, confirming that it engaged on every inherited
report identified in the defect analysis.

| | pilot-01 | pilot-02 | pilot-03 |
|---|---|---|---|
| recall | 0.60 (3/5) | 0.33 (1/3) | 1.00 (2/2) |
| escape rate | 0.20 (1/5) | 0.67 (2/3) | 0.00 (0/2) |
| M2 slope | 0.0371/turn (n=7) | 0.0000/turn (n=5) | 0.0014/turn (n=7) |
| iterations median | 1 over 12 reviewed | 1 over 12 reviewed | 1 over 10 reviewed |
| cost | $0.0236 | $0.0125 | $0.0136 |

## What moved and what did not

- **Recall did not move** for any pilot: 0.60, 0.33 and 1.00 remain the reported rates and the
  numerators and denominators are unchanged.
- **Escape rate did not move** for any pilot: 0.20, 0.67 and 0.00 remain unchanged, including the
  numerators and denominators.
- **M2 moved only for pilot-01 at the reported precision:** its slope rose from 0.0239/turn to
  0.0371/turn, while its valid sample fell from n=10 to n=7. Pilot-02 remains 0.0000/turn, with
  n reduced from 9 to 5. Pilot-03 remains 0.0014/turn at four decimals, with n reduced from 9 to
  7.
- **Median iterations did not move** for any pilot: each remains 1, over 12, 12 and 10 reviewed
  turns respectively.
- **Cost did not move** for any pilot: the rounded totals remain $0.0236, $0.0125 and $0.0136.

## Reproducibility boundary

The raw pilot evidence under `rig/results/` is gitignored, so this re-harvest is reproducible only
on the machine that retains those artifacts. The correction rests on the report-ownership fix in
harvester commit `825662e`. The fresh measurements were run from descendant `cce7ed2`, which also
contains the associated guards.

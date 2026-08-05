# Reviewgate — Next-Session Handoff

_Last updated: 2026-08-05. Supersedes all earlier content._

## One-line state

The longitudinal effectiveness rig is **fully built, reviewed and pushed** (Tasks 1–5 minus one
step) — but the **baseline still does not exist**: the 12-turn pilot failed three times without
producing a single audit event, and today's session found and fixed the cause without yet
re-running it.

## What got done this session — and how it was verified

**Task 4 (harvester) and Task 5 (reporter + ablation) shipped.** The load-bearing correction the
plan did not anticipate: **the per-turn snapshots are CUMULATIVE** (the audit tree is append-only
and `handleReset` never clears it), so every per-iteration fact is a multiset delta against the
previous snapshot. Mutation-checked — with the delta removed the M2 slope does not merely drift,
it **flips sign** (+0.43 where the true fit is negative), i.e. the bug would have manufactured the
exact opposite of the rig's headline claim.

**The pilot's root cause, found by stepwise isolation.** Same prompt + default config, direct →
gate fires. Same prompt + **pilot config**, direct → gate fires (850 B output, audit written).
That eliminated prompt, config, hooks and contention. The remaining variable was
`REVIEWGATE_CASSETTE`, absent from those isolation runs.

> **A/B, same sandbox, back to back:** with the cassette → setup fails, no audit.
> Without it → **PASS in 5.2 s** with the audit event.

The cassette recorder refuses paths **outside the repo under review** (traversal/symlink guard),
and refuses them during the gate's **setup** phase. The cassette sat in `rig/results/`, but the
repo under review is the *sandbox*. So the gate never ran, never wrote an audit event, and every
turn completed with the agent's edits made and no review at all.

**Why that took three runs:** `gate.ts` wrapped the whole setup phase in a bare `catch` that
reported **every** exception as `did not complete within 120s (likely git index-lock contention)`.
The real error threw in **0.1 s** and its message was discarded. The message actively pointed the
wrong way — two wrong causes were named before the exception was allowed to speak.

Both fixed in `52fdb70`: a timeout and a throw now read differently and the real message is never
swallowed; and `rig run`'s pre-flight now mirrors the recorder's containment rule, where being
wrong is still free instead of costing twelve turns of quota.

**Also shipped:** `acknowledgePass` block-loop fix (`4aabc09`, from the FlashBuddy field report),
the driver's unreviewed-turn guard (`26a4f5c`), and the preregistration + its integrity schema.

## Current metrics

| | |
|---|---|
| HEAD | `52fdb70`, **pushed** — `git rev-parse HEAD @{u} \| uniq -c` shows one line, count 2. Tree clean |
| Suite | **3136 pass / 12 skip / 0 fail** on exactly this content |
| Static | `bunx tsc --noEmit` clean · biome clean (640 files) |
| `dist/reviewgate` | **deliberately NOT rebuilt** — still the 31.07 build, `0.1.0-alpha.15`, `sha256:6f52c766…` |
| Pilot | 0 of 12 turns ever measured. OpenRouter actual spend so far: **$0.001180** |

## THE NEXT TASK — run the pilot, with the cassette inside the sandbox

Task 6 of `docs/superpowers/plans/2026-07-29-longitudinal-effectiveness-rig.md`. It is next
because everything upstream only *collects*; without the baseline the planned aggregator refactor
is a behaviour-neutral change nobody can prove is behaviour-neutral.

The only change from the last attempt is **where the cassette lives**:

```bash
SB=$(mktemp -d /tmp/rig-pilot01-XXXXXX)   # arm it: git init + commit, copy the pilot config,
                                          # `dist/reviewgate init --host claude`, commit again
cd "$SB"
export OPENROUTER_API_KEY='<fresh key>'
export REVIEWGATE_CASSETTE="record:$SB/cassette.jsonl"   # INSIDE the sandbox — this is the fix
bun /Users/markus/Developer/reviewgate/src/cli/index.ts rig run \
  --script /Users/markus/Developer/reviewgate/rig/scripts/pilot-01.json \
  --out /Users/markus/Developer/reviewgate/rig/results/pilot-01
# afterwards: cp "$SB/cassette.jsonl" rig/results/pilot-01/
```

The pre-flight guard now refuses the old (broken) layout before spawning anything, so this cannot
silently regress. Then: `rig harvest` → `rig report` → `rig ablate`, then the write-up.

## Traps that still hold

- **Do NOT `bun run build` before the pilot.** The preregistration pins the binary by hash
  (`sha256:6f52c766…`); rebuilding changes the measured system and forces another re-pin. The rig
  runs from source, so the new cassette guard is active anyway. Rebuild *after* the run.
- **The cassette must live inside the sandbox.** Anywhere else and the gate dies in setup with no
  audit events — which looks exactly like "the agent's Stop hook never fired".
- **`exit = 0` proves nothing about a turn.** A turn can complete with edits made and no review.
  The driver's `gateReviewed` flag (audit growth + `dirty.flag`) is the real signal; two
  consecutive unreviewed turns abort the run.
- **Never run the full suite, or a second Claude session, beside a pilot run.** Contention is real
  — but note it was NOT the cause here; do not let it become the default explanation again.
- **A preregistration may only be re-frozen while zero numbers exist**, and the change goes into
  `known_limitations`. That was done once (31.07 → binary re-pin) and is documented in the file.
- **`rig replay` (Task 5 Step 4) is deliberately unbuilt** — its acceptance criterion needs a
  recorded pilot that does not exist yet.
- **fp-ledger's ablation Δ is an INTERVAL, not a point**, and that is correct: the layer
  overwrites severity with INFO and the original is persisted nowhere. Do not "fix" it into a
  point estimate. `lore` never demotes at all (additive INFO findings).
- **Never `git add -A` at the repo root** (stages `.reviewgate/` state). `rig/results/` is
  gitignored because cassettes contain raw reviewer prompts and output — review before committing.
- **codex quota** reset was `2026-08-05T11:24Z`; verify before assuming it is available.

## Read-first order

1. This file.
2. `docs/superpowers/plans/2026-07-29-longitudinal-effectiveness-rig.md` — Task 6, plus the
   two "DONE" write-ups on Tasks 4 and 5 (they record the deviations from the original plan).
3. `src/cli/commands/rig.ts:runRigRun` — the pre-flight guards, including the new containment rule.
4. `rig/preregistrations/pilot-01.json` — what the run is committed to in advance.

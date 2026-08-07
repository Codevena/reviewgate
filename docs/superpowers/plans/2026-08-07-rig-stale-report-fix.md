# Rig stale-report fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the rig attributing one turn's `pending.json` to the next turn, which currently
inflates 13 of 36 recorded pilot turns with findings they never produced.

**Architecture:** A report belongs to the turn whose audit delta contains its `run_id`. The
harvester enforces this (works retroactively on already-recorded runs, no rebuild); the driver
additionally stops archiving a report that was already on disk before the turn began (forward-only
hygiene). Design and evidence: `docs/superpowers/specs/2026-08-07-rig-stale-report-design.md`.

**Tech Stack:** Bun, TypeScript, Biome, `bun test`.

## Global Constraints

- **Bun only.** `bun test`, never jest/vitest. Single test: `bun test tests/unit/foo.test.ts`.
- **Before calling anything done:** `bunx tsc --noEmit` **and** `bun run lint`, both clean.
- **Never pipe `bun test` through `tail`** — a red test's identity is lost. Redirect to a file.
- **Never run `bun run build`.** It re-pins the binary and deploys machine-wide via the
  `~/.local/bin/reviewgate` symlink. Explicitly out of scope; the binary stays `sha256:fc9b8c18…`.
- **A SECOND SESSION commits to this checkout live.** Never `git add -A`. Stage explicit paths and
  check `git log` before assuming a commit is yours.
- **Never commit `.reviewgate/` state** (it is live gate state, not source).
- Ownership key is `run_id` **alone**, never `(run_id, iter)` — a gate that dies before appending
  `run.complete` would otherwise have its real report dropped as an orphan.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/rig/harvest.ts` | the guard: decides which archived reports a turn owns | modify `collectTurnFindings` + its call site in `harvestTurn` |
| `src/rig/driver.ts` | hygiene: stops writing the misleading artifact | modify `startReportArchiver` |
| `tests/unit/rig-harvest.test.ts` | fixture + 5 ownership guards | modify `pendingReport`/`FxTurn`/`buildFixture`, add 5 tests |
| `tests/unit/rig-driver.test.ts` | 2 archiver guards | add 2 tests |
| `docs/dev/2026-08-07-rig-stale-report-correction.md` | before/after numbers | create |

---

## Task 1: Align fixture reports with their turn's audit run_id

Pure refactor — no production code changes, every existing test stays green. It must land first:
`auditLine` emits `run_id: "session-<turnIndex>"` (`tests/unit/rig-harvest.test.ts:93`) while
`pendingReport` hardcodes `run_id: "session-x"` (`:144`). Under Task 2's rule every existing fixture
report would become an orphan and every finding-count assertion would break for the wrong reason.

**Files:**
- Modify: `tests/unit/rig-harvest.test.ts:141-146` (`pendingReport`), the `FxTurn` interface
  (around `:55-74`), and the `buildFixture` report loop (`:253-258`)

**Interfaces:**
- Consumes: nothing
- Produces: `pendingReport(findings: FxFinding[], iter: number, critic: FxCritic | undefined, runId: string): string`
  and a new optional `FxTurn.reportRunIds?: (string | undefined)[]`, which Task 2's tests use to
  construct inherited and orphan reports.

- [ ] **Step 1: Add `reportRunIds` to the `FxTurn` interface**

Insert directly after the `reportIters?: number[];` field:

```ts
  /**
   * parallel to `reports`: the `run_id` that version carries. Defaults to this turn's own
   * (`session-<turnIndex>`), i.e. a report the turn's own gate produced. Set it to an EARLIER
   * turn's id to model the archiver catching a leftover `pending.json`, or to an id no audit
   * event carries to model a report that cannot be attributed to any turn.
   */
  reportRunIds?: (string | undefined)[];
```

- [ ] **Step 2: Make `pendingReport` take the run_id**

Replace the signature and the `run_id` line:

```ts
function pendingReport(
  findings: FxFinding[],
  iter: number,
  critic: FxCritic | undefined,
  runId: string,
): string {
  return JSON.stringify({
    schema: "reviewgate.pending.v1",
    run_id: runId,
```

Leave the rest of the object untouched.

- [ ] **Step 3: Pass this turn's run_id at the call site**

In `buildFixture`, replace the `writeFileSync(join(reportDir, ...))` call:

```ts
        for (const [n, findings] of reports.entries()) {
          writeFileSync(
            join(reportDir, `${n + 1}-pending.json`),
            pendingReport(
              findings,
              turn.reportIters?.[n] ?? n + 1,
              turn.critics?.[n],
              turn.reportRunIds?.[n] ?? `session-${index}`,
            ),
          );
        }
```

- [ ] **Step 4: Run the harvest suite — everything must still pass**

Run: `bun test tests/unit/rig-harvest.test.ts > /tmp/t1.txt 2>&1; tail -5 /tmp/t1.txt`
Expected: 0 fail. This task changes no behaviour — `criticRuns` is keyed `run_id:iter` within a
single turn's Map, so renaming the run_id consistently cannot change any grouping.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/rig-harvest.test.ts
git commit -m "test(rig): fixture reports carry their own turn's run_id"
```

---

## Task 2: Ownership by run_id in the harvester

**Files:**
- Modify: `src/rig/harvest.ts:141-211` (`collectTurnFindings`) and `:413-417` (its call site)
- Test: `tests/unit/rig-harvest.test.ts`

**Interfaces:**
- Consumes: `FxTurn.reportRunIds` from Task 1
- Produces: `collectTurnFindings(snapshotDir: string, turnIndex: number, warnings: string[], ownedRunIds: Set<string>, knownRunIds: Set<string>)` — same return shape as before

- [ ] **Step 1: Write all five failing tests**

Append inside the existing `describe("rig harvest", ...)` block:

```ts
  test("an inherited report is not counted again in the turn that merely saw it", () => {
    const fx = buildFixture([
      { seeded: null, iterations: [{ warn: 1 }], reports: [[{ signature: "s1" }]] },
      {
        seeded: null,
        iterations: [{ warn: 1 }],
        // The archiver's first poll caught turn 1's leftover, then turn 2's own report.
        reports: [[{ signature: "s1" }], [{ signature: "s2" }]],
        reportRunIds: ["session-1", undefined],
        reportIters: [1, 1],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[1]?.findingsTotal).toBe(1);
    expect(result.turns[1]?.findings[0]?.signature).toBe("s2");
    expect(result.warnings.some((w) => w.includes("turn 2") && /EARLIER turn/.test(w))).toBe(true);
  });

  test("a turn the gate never reviewed reports nothing, not its predecessor's findings", () => {
    const fx = buildFixture([
      {
        seeded: null,
        iterations: [{ warn: 3 }],
        reports: [[{ signature: "a" }, { signature: "b" }, { signature: "c" }]],
      },
      // The agent died; the gate never ran. Only turn 1's leftover was on disk to archive.
      {
        seeded: null,
        iterations: [],
        reports: [[{ signature: "a" }, { signature: "b" }, { signature: "c" }]],
        reportRunIds: ["session-1"],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[1]?.iterations).toBe(0);
    expect(result.turns[1]?.findingsTotal).toBe(0);
  });

  test("a report owned by NO turn is dropped and warned about, not charged to this turn", () => {
    const fx = buildFixture([
      {
        seeded: null,
        iterations: [{ warn: 1 }],
        reports: [[{ signature: "own" }], [{ signature: "ghost" }]],
        reportRunIds: [undefined, "session-99"],
        reportIters: [1, 1],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.findingsTotal).toBe(1);
    expect(result.warnings.some((w) => /NO turn's audit events/.test(w))).toBe(true);
  });

  test("criticRuns is not attributed to a turn that only INHERITED the report", () => {
    const critic = { provider: "ollama", status: "ran" as const, verdicts: 2, demoted: 1 };
    const fx = buildFixture([
      {
        seeded: null,
        iterations: [{ warn: 1 }],
        reports: [[{ signature: "s1" }]],
        critics: [critic],
      },
      {
        seeded: null,
        iterations: [{ warn: 0 }],
        reports: [[{ signature: "s1" }], []],
        critics: [critic, undefined],
        reportRunIds: ["session-1", undefined],
        reportIters: [1, 1],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[0]?.criticRuns?.length).toBe(1);
    expect(result.turns[1]?.criticRuns ?? []).toEqual([]);
  });

  test("reportsRead counts only OWNED reports, so the unmeasured-turn warning still fires", () => {
    const fx = buildFixture([
      { seeded: null, iterations: [{ warn: 1 }], reports: [[{ signature: "s1" }]] },
      // The gate DID run, but the archiver caught only turn 1's leftover — none of turn 2's own.
      {
        seeded: null,
        iterations: [{ warn: 1 }],
        reports: [[{ signature: "s1" }]],
        reportRunIds: ["session-1"],
      },
    ]);
    const result = harvest(fx.manifestPath, fx.scriptPath);

    expect(result.turns[1]?.iterations).toBe(1);
    expect(result.turns[1]?.findingsTotal).toBe(0);
    expect(
      result.warnings.some((w) => w.includes("turn 2") && /NO pending\.json was archived/.test(w)),
    ).toBe(true);
  });
```

- [ ] **Step 2: Run them and record that each is RED**

Run: `bun test tests/unit/rig-harvest.test.ts > /tmp/t2-red.txt 2>&1; grep -c "(fail)" /tmp/t2-red.txt`
Expected: **5 failures.** This run IS the mutation evidence for all five — each is red in the
absence of the mechanism it guards. Keep `/tmp/t2-red.txt`; the expected pre-fix values are
2 findings, 3 findings, 2 findings, 1 criticRun, and a missing warning respectively.

- [ ] **Step 3: Add the ownership filter to `collectTurnFindings`**

Change the signature:

```ts
function collectTurnFindings(
  snapshotDir: string,
  turnIndex: number,
  warnings: string[],
  ownedRunIds: Set<string>,
  knownRunIds: Set<string>,
): { findings: Finding[]; panel: PanelSlot[]; reportsRead: number; criticRuns: CriticInfo[] } {
```

Declare the two tallies next to `let reportsRead = 0;`:

```ts
  let inheritedCount = 0;
  const orphanNames: string[] = [];
```

Insert the filter immediately after the `PendingReportSchema.safeParse` guard and **before**
`reportsRead++`:

```ts
    // OWNERSHIP. The archiver captures whatever `pending.json` is on disk, which on 31 of 36
    // recorded pilot turns was the PREVIOUS turn's leftover — counting it here would count one
    // finding once in the turn that produced it and again in the turn that merely saw it, the
    // very double-count the per-turn signature dedup above exists to prevent. A gate run lives
    // inside one Stop hook and therefore one turn, so `run_id` alone identifies the owner
    // (verified 1:1 across all 34 recorded gate runs). Keyed on run_id and NOT on (run_id, iter):
    // a gate that writes a report and then dies before appending `run.complete` would otherwise
    // have its real report discarded as unattributable.
    const runId = parsed.data.run_id;
    if (!ownedRunIds.has(runId)) {
      if (knownRunIds.has(runId)) inheritedCount++;
      else orphanNames.push(name);
      continue;
    }
    reportsRead++;
```

(Delete the now-duplicated original `reportsRead++` line.)

Add the warnings immediately before the `return {` at the end of the function:

```ts
  // One line per TURN, not per report: naming each of eleven inherited files would bury the
  // signal. Nothing is lost — each is counted in the turn whose gate produced it.
  if (inheritedCount > 0) {
    warnings.push(
      `turn ${turnIndex}: ${inheritedCount} archived report(s) carry a run_id produced by an EARLIER turn — the gate did not write them during this turn. They are EXCLUDED here and counted where they were produced, so one finding is not counted twice across turns.`,
    );
  }
  // One line per REPORT, and loud: unlike an inherited report, an orphan is not counted anywhere,
  // so this is real data loss rather than a correction.
  for (const orphan of orphanNames) {
    warnings.push(
      `turn ${turnIndex}: archived report ${orphan} carries a run_id that appears in NO turn's audit events and was EXCLUDED — it cannot be attributed to any turn (pruned audit day-partition, or a snapshot from a different run). This turn's findings may be UNDERSTATED.`,
    );
  }
```

- [ ] **Step 4: Pass the two sets in at the call site**

In `harvestTurn`, directly after the `runDelta`/`decisionDelta` block and before the
`collectTurnFindings` call:

```ts
  // `window.runs` is cumulative for this snapshot, so it carries every earlier turn's runs too —
  // which is exactly what distinguishes an INHERITED report (owned by an earlier turn) from an
  // ORPHAN (owned by none).
  const ownedRunIds = new Set(runDelta.added.map((r) => r.run_id));
  const knownRunIds = new Set(window.runs.map((r) => r.run_id));
```

Then change the call itself:

```ts
  const { findings, panel, reportsRead, criticRuns } = collectTurnFindings(
    snapshotDir,
    index,
    warnings,
    ownedRunIds,
    knownRunIds,
  );
```

- [ ] **Step 5: Run the full harvest suite**

Run: `bun test tests/unit/rig-harvest.test.ts > /tmp/t2-green.txt 2>&1; tail -5 /tmp/t2-green.txt`
Expected: 0 fail — the five new tests pass and no pre-existing test regressed.

- [ ] **Step 6: Static gates**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/rig/harvest.ts tests/unit/rig-harvest.test.ts
git commit -m "fix(rig): a report belongs to the turn whose audit delta owns its run_id"
```

---

## Task 3: Stop the driver archiving a pre-existing report

**Files:**
- Modify: `src/rig/driver.ts:214-247` (`startReportArchiver`)
- Test: `tests/unit/rig-driver.test.ts` (insert after the existing archiver tests, around `:313`)

**Interfaces:**
- Consumes: nothing from Tasks 1–2 (independent; the harvester is the actual guard)
- Produces: no signature change — `startReportArchiver(repoRoot: string, destDir: string): () => void`

- [ ] **Step 1: Write both failing tests**

Insert inside the same `describe("rig driver", ...)` block that contains `gateLikeWriter`:

```ts
  test("does NOT archive a pending.json left behind by the PREVIOUS turn", async () => {
    // The archiver promises every version that APPEARS while the turn runs. A file already on
    // disk when the turn starts did not appear during it — on 31 of 36 recorded pilot turns this
    // leftover was archived as that turn's report #1.
    const { root, scriptPath } = sandbox(1);
    const pending = join(root, ".reviewgate", "pending.json");
    writeFileSync(pending, '{"verdict":"FAIL","findings":[{"rule_id":"stale-from-last-turn"}]}');
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: appendingAgent(root), // touches agent.log only; pending.json is never rewritten
      maxTurns: 1,
    });
    const reportsDir = join(manifest.turns[0]?.snapshotDir ?? "", "reports");
    const archived = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f) => f.endsWith("pending.json"))
      : [];
    expect(archived).toEqual([]);
  }, 20_000);

  test("still archives a pending.json that CHANGES during the turn, even if one existed before", async () => {
    // The over-suppression guard. A fix that skipped on filename, or on "a file was already
    // there", rather than on CONTENT HASH would swallow this turn's real report.
    const { root, scriptPath } = sandbox(1);
    const pending = join(root, ".reviewgate", "pending.json");
    writeFileSync(pending, '{"verdict":"FAIL","findings":[{"rule_id":"stale-from-last-turn"}]}');
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: gateLikeWriter([
        { file: pending, body: '{"verdict":"FAIL","findings":[{"rule_id":"fresh-this-turn"}]}' },
      ]),
      maxTurns: 1,
    });
    const reportsDir = join(manifest.turns[0]?.snapshotDir ?? "", "reports");
    const archived = readdirSync(reportsDir)
      .filter((f) => f.endsWith("pending.json"))
      .map((f) => readFileSync(join(reportsDir, f), "utf8"));
    expect(archived.some((c) => c.includes("fresh-this-turn"))).toBe(true);
    expect(archived.some((c) => c.includes("stale-from-last-turn"))).toBe(false);
  }, 20_000);
```

- [ ] **Step 2: Run them and record which is red**

Run: `bun test tests/unit/rig-driver.test.ts > /tmp/t3-red.txt 2>&1; grep -c "(fail)" /tmp/t3-red.txt`
Expected: **exactly 1 failure** — the first test (1 archived file instead of 0). The second test
passes already **by design**: it is an over-suppression guard, so its job is to be green on both
sides. Its mutation check is Step 5, which mutates the *fix* rather than removing it.

- [ ] **Step 3: Seed the archiver with the pre-turn state**

In `startReportArchiver`, insert immediately after `const seen = new Set<string>();`:

```ts
  // Seed with the state on disk BEFORE the agent runs. The docstring promises every version that
  // APPEARS while the turn runs; without this seed the first poll (250ms in, long before this
  // turn's gate has written anything) captures the PREVIOUS turn's leftover pending.json as this
  // turn's report #1. Nothing is lost: the previous turn's own final sweep already archived those
  // exact bytes. Hashed, not merely name-checked — a report REWRITTEN during this turn must still
  // be archived.
  for (const name of ["pending.json", "pending.md"]) {
    const src = join(reviewgateDir(repoRoot), name);
    if (!existsSync(src)) continue;
    try {
      seen.add(`${name}:${createHash("sha256").update(readFileSync(src, "utf8")).digest("hex")}`);
    } catch {
      /* unreadable this instant → it is simply not seeded, and a later tick captures it */
    }
  }
```

`createHash`, `existsSync`, `readFileSync`, `join` and `reviewgateDir` are already imported in this
file — verify rather than re-adding them.

- [ ] **Step 4: Run the driver suite**

Run: `bun test tests/unit/rig-driver.test.ts > /tmp/t3-green.txt 2>&1; tail -5 /tmp/t3-green.txt`
Expected: 0 fail.

- [ ] **Step 5: Mutation-check the over-suppression guard in a COPY**

The second test never went red in Step 2, so it is unproven until deliberately broken. Do this in a
copy, never in the real repo:

```bash
cp -R /Users/markus/Developer/reviewgate /tmp/rg-mutation-check
cd /tmp/rg-mutation-check
```

In the copy, replace the seeding loop's `seen.add(...)` line with a name-only variant that ignores
content — `seen.add(name)` — then:

```bash
bun test tests/unit/rig-driver.test.ts > /tmp/t3-mutant.txt 2>&1; grep -c "(fail)" /tmp/t3-mutant.txt
```

Expected: the over-suppression test goes **red** (the fresh report is swallowed). If it stays green
the test is vacuous and must be rewritten before proceeding.

Then discard the copy and confirm the real repo is untouched:

```bash
rm -rf /tmp/rg-mutation-check
cd /Users/markus/Developer/reviewgate && git status --short
```

- [ ] **Step 6: Static gates**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/rig/driver.ts tests/unit/rig-driver.test.ts
git commit -m "fix(rig): archive only reports that appear DURING the turn"
```

---

## Task 4: Re-harvest the pilots and publish the correction

**Files:**
- Create: `docs/dev/2026-08-07-rig-stale-report-correction.md`

**Interfaces:**
- Consumes: the corrected harvester from Task 2
- Produces: the correction document; no code

- [ ] **Step 1: Run the full suite once, clean**

Run: `bun test > /tmp/full-suite.txt 2>&1; tail -5 /tmp/full-suite.txt`
Expected: 0 fail. (Baseline before this work was 3191 pass / 12 skip / 0 fail, plus the 7 new tests
and whatever the parallel session has added — do not treat the absolute count as the assertion, only
`0 fail`.)

- [ ] **Step 2: Re-harvest all three pilots offline**

No binary and no agent quota is involved — this runs from source.

```bash
mkdir -p /tmp/rig-after
for p in pilot-01 pilot-02 pilot-03; do
  bun run dev rig harvest \
    --manifest rig/results/$p/manifest.json \
    --script rig/scripts/$p.json \
    --out /tmp/rig-after/$p.json > /tmp/rig-after/$p.stdout 2> /tmp/rig-after/$p.stderr
  echo "=== $p"; cat /tmp/rig-after/$p.stdout
done
```

- [ ] **Step 3: Check the warnings actually fired**

Run: `grep -c "EARLIER turn" /tmp/rig-after/*.stderr`
Expected: non-zero for all three — pilot-01 and pilot-02 have 11 inherited reports each and
pilot-03 has 9, spread over the turns listed in the spec. A zero here means the filter never
engaged and the numbers below are not the corrected ones.

- [ ] **Step 4: Write the correction document**

Create `docs/dev/2026-08-07-rig-stale-report-correction.md` containing:

1. A one-paragraph statement of the defect and its scope (31/36 turns inherited a report; 13/36
   counted findings they did not produce; 9 of those produced none of their own).
2. This before-table, which was captured **pre-fix** so the delta cannot be back-fitted:

   | | pilot-01 | pilot-02 | pilot-03 |
   |---|---|---|---|
   | recall | 0.60 (3/5) | 0.33 (1/3) | 1.00 (2/2) |
   | escape rate | 0.20 (1/5) | 0.67 (2/3) | 0.00 (0/2) |
   | M2 slope | 0.0239/turn (n=10) | 0.0000/turn (n=9) | 0.0014/turn (n=9) |
   | iterations median | 1 over 12 reviewed | 1 over 12 reviewed | 1 over 10 reviewed |
   | cost | $0.0236 | $0.0125 | $0.0136 |

3. The matching after-table, read from Step 2's output.
4. A per-metric statement of what moved and what did not. State plainly if a metric did not move.
5. A note that `rig/results/` is gitignored, so these numbers are reproducible only on this machine,
   and that the correction rests on the corrected harvester at the commit from Task 2.

Do **not** assert that any specific metric moved until Step 2's output is in hand.

- [ ] **Step 5: Correct any write-up quoting a superseded number**

Run: `grep -rln "0\.60\|0\.33\|0\.0239" docs/dev/ docs/superpowers/ 2>/dev/null`

For each hit, check whether the number is a rig metric from these pilots. If it is, add a dated
correction line pointing at the new document rather than silently editing the old figure — a
superseded number that vanishes without trace is how a corrected record becomes untrustworthy.

- [ ] **Step 6: Commit**

```bash
git add docs/dev/2026-08-07-rig-stale-report-correction.md
git commit -m "docs: correct the pilot metrics invalidated by the rig stale-report defect"
```

(Add any write-up files touched in Step 5 to the same `git add`, by explicit path.)

---

## Post-implementation gate

Per the repo's Definition of Done, two independent reviewers, each returning `VERDICT: PASS`:

- **Slot A — MUST execute.** Codex is at quota until **2026-08-08 11:07Z**; until then this slot is a
  Claude reviewer subagent with repo read *and* run access. Instruct it to re-run the numbers in the
  correction document and to mutation-check the new tests in a copy.
- **Slot B — the second, independent voice.** `agy` (Gemini). Note it has been observed to fail
  0-byte: a missing findings file is an OPEN slot, not a pass. Check the log size **and** the
  findings-file mtime against the round's start time.

A non-executing PASS is one voice, never corroboration.

## Self-review notes

- **Spec coverage:** ownership rule → Task 2; `run_id`-not-pair rationale → Task 2 Step 3 comment;
  driver hygiene → Task 3; inherited/orphan warning split → Task 2 Step 3; non-fatal policy →
  inherited/orphan both use `warnings.push`, never `throw`; fixture rework → Task 1; all seven
  tests → Tasks 2–3; correction deliverable → Task 4; rebuild excluded → Global Constraints;
  `gateReviewed` deliberately not consulted → subsumed by the empty-audit-delta case, exercised by
  Task 2's dead-turn test.
- **Type consistency:** `collectTurnFindings` gains `ownedRunIds`/`knownRunIds` in Task 2 Step 3 and
  is called with exactly those two names in Step 4. `pendingReport`'s fourth parameter `runId`
  (Task 1 Step 2) is supplied at the single call site (Step 3). `FxTurn.reportRunIds` is declared in
  Task 1 Step 1 and used in Task 2 Step 1.
- **Known limitation, stated rather than hidden:** the driver fix (Task 3) changes nothing for any
  future `rig run` until someone rebuilds the binary. That is deliberately out of scope here and
  must be carried into the handoff as an open item.

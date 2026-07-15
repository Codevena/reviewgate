# Alpha.12 Benchmark Attempt 02 Reliability Implementation Plan

> **For Codex:** Execute task-by-task with the `superpowers:executing-plans` and
> `superpowers:test-driven-development` workflows. Do not start provider calls until
> the exact preregistration commit is pushed and its CI run is green.

**Goal:** Make the frozen Alpha.12 benchmark independent of ambient Codex config,
add a preregistered and fully counted two-attempt critic policy, correct platform
package metadata, and rerun the unchanged 30-case corpus authoritatively.

**Architecture:** Provider isolation belongs in `CodexAdapter`; retry policy belongs
in the benchmark-to-orchestrator input and `runCritic`, while the existing budget
adapter remains the sole physical-call counter. Runtime callers omit the new input
and therefore retain one attempt. Attempt 01 remains immutable and Attempt 02 gets
its own preregistration and result directory.

**Tech stack:** TypeScript, Bun test/build, Zod schemas, GitHub Actions, npm, Codex
CLI, Claude Code CLI, OpenRouter.

---

## Task 1: Isolate Codex invocations from ambient user configuration

**Files:**

- Modify: `tests/unit/codex-adapter.test.ts`
- Modify: `src/providers/codex.ts`

1. Extend the existing argv-capture tests to require `--ignore-user-config` in
   both `review()` and `complete()` invocations.
2. Run `bun test tests/unit/codex-adapter.test.ts` and confirm the new assertions
   fail.
3. Add the flag to both argument arrays, without changing authentication or the
   adapter's supplied model, sandbox, schema, working directory, and prompt.
4. Rerun the focused test and confirm it passes.

## Task 2: Add bounded, visible critic attempts

**Files:**

- Modify: `tests/unit/critic-runner.test.ts`
- Modify: `src/core/critic.ts`
- Modify: `src/core/orchestrator.ts`
- Modify: `src/bench/runner.ts`

1. Add failing tests for retry-after-throw, retry-after-empty/unparseable output,
   stop-on-first-parseable verdict, exact exhaustion, and the unchanged default of
   one attempt.
2. Add an optional positive `maxAttempts` input to `runCritic`; loop only around
   `adapter.complete()`, returning the final error/empty state after exhaustion.
3. Thread an optional `criticMaxAttempts` through the benchmark runner and
   orchestrator. Resolve it to `1` when omitted so non-benchmark behavior is
   unchanged.
4. Run `bun test tests/unit/critic-runner.test.ts tests/unit/bench-runner.test.ts`.

## Task 3: Count every physical retry and record the policy

**Files:**

- Modify: `tests/unit/bench-run-cli.test.ts`
- Modify: `tests/unit/bench-result-schema.test.ts`
- Modify: `src/cli/commands/bench.ts`
- Modify: `src/schemas/bench-result.ts`
- Modify: `src/cli/index.ts`

1. Add failing tests showing a second critic completion increments
   `provider_calls_used`, and that the shared ceiling prevents an uncounted extra
   attempt.
2. Add `--critic-max-attempts` to `bench run` and `bench matrix`; validate it as a
   positive integer and pass it through every variant.
3. Record the resolved attempt limit in critic provenance with an optional schema
   field so older result artifacts continue to parse.
4. Run the focused CLI/schema tests and verify the default provenance resolves to
   one attempt.

## Task 4: Freeze and validate Attempt 02 before any provider call

**Files:**

- Modify: `tests/unit/bench-preregistration.test.ts`
- Modify: `src/schemas/bench-preregistration.ts`
- Modify: `src/cli/commands/bench.ts`
- Create: `bench/preregistrations/alpha12-v2-attempt-02.json`

1. Add failing tests for the optional preregistered critic-attempt hard gate and
   canonical command matching.
2. Keep Attempt 01 backward compatible: absent means one and does not alter its
   canonical command. Require Attempt 02's value `2` to match the CLI input.
3. Commit the exact command with `--critic-max-attempts 2`,
   `--max-provider-calls 360`, the unchanged corpus/roster/hashes, and output
   `bench/results/alpha12-v2/attempt-02/matrix.json`.
4. Verify a mismatched flag or ceiling fails preregistration before a provider can
   run.

## Task 5: Correct generated platform package descriptions

**Files:**

- Modify: `tests/unit/build-npm-packages.test.ts`
- Modify: `scripts/build-npm-packages.ts`

1. Add a failing assertion for every platform target that its description names
   both Claude Code and Codex.
2. Update the generated description and rerun the focused test.

## Task 6: Verify, review, commit, push, and gate the exact runner

1. Run focused tests, then `bun run typecheck`, `bun run lint`, `bun run build`,
   the full `bun test`, npm packaging verification, and native/npx smokes.
2. Confirm the two control-plane SHA-256 values remain unchanged and scan staged
   benchmark material for secrets, local paths, and private endpoints.
3. Obtain independent exact-diff reviews and run ReviewGate without bypassing it.
4. Commit and push the implementation/preregistration, then wait for GitHub CI on
   the exact pushed SHA to become green.
5. Record the rebuilt `dist/reviewgate` SHA-256. Do not modify the runner after
   this point.

## Task 7: Run and publish Attempt 02 only if authoritative

1. Execute the exact preregistered command. The physical-call ceiling is `360`:
   `180` reviewer calls plus at most `180` critic attempts.
2. Preserve every output in the new Attempt 02 directory; never overwrite Attempt
   01 or select favorable repeats.
3. Require 100% reviewer coverage, 100% eligible-critic coverage, zero invalid
   variants, clean source/corpus provenance, and matching hashes.
4. Generate `matrix.json`, baseline/no-critic normalized results, reviewer hashes,
   `result.json`, `report.md`, `MANIFEST.md`, and `SHA256SUMS.txt`; scan them before
   publication.
5. Update README/docs/site from the authoritative result, rerun all verification,
   publish `v0.1.0-alpha.12` plus all five npm packages, verify registry/release and
   Pages, perform a fresh-repo `reviewgate init` Codex-trust smoke, then execute the
   approved launch checklist through Markus's authenticated channels.

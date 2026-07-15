# Alpha.12 benchmark Attempt 02 reliability design

- **Date:** 2026-07-15
- **Release target:** `v0.1.0-alpha.12`
- **Scope:** repair the measured provider boundary and rerun the frozen 30-case benchmark
- **Control plane:** `reviewgate.config.ts` and `.reviewgate/control-plane.json` remain byte-identical

## Observed Attempt 01 failure

Attempt 01 completed all 90 case-runs but failed the authoritative coverage gates:

- Claude Code: `90/90` reviewer coverage;
- Codex: `0/90` reviewer coverage;
- OpenRouter critic: `81/85` eligible calls produced parseable verdicts;
- aggregate panel coverage: `50%`;
- exit code: `4` (non-authoritative).

The preserved artifact is evidence of a failed attempt only. None of its quality
metrics may be used as a public Alpha.12 headline.

## Root causes

### Ambient Codex configuration

`CodexAdapter.review()` loaded `$CODEX_HOME/config.toml`. A globally configured
Vercel MCP server failed authentication during every fresh benchmark checkout, so
Codex exited before contacting the selected model. The same minimal invocation
succeeds with `codex exec --ignore-user-config`; Codex authentication remains
available because that flag deliberately keeps `CODEX_HOME` auth.

Both Codex review and free-form completion invocations must add
`--ignore-user-config`. Reviewgate supplies the model, sandbox, schema and prompt,
so ambient MCP servers, profiles and unrelated user defaults must not affect a
provider adapter call.

### Transient critic completions

Three early OpenRouter completions errored and one later completion returned no
parseable critic verdict. The pinned model/upstream works in a fresh diagnostic
probe, so this is intermittent upstream behavior rather than a permanent route
mismatch. A one-shot requirement makes 100% coverage across dozens of eligible
calls unnecessarily brittle.

## Attempt 02 protocol

1. Add benchmark CLI option `--critic-max-attempts 2`.
2. Production/runtime behavior remains one attempt unless explicitly overridden
   by the benchmark harness.
3. The critic retries only after a thrown completion or an empty/unparseable
   verdict map. It stops at the first parseable non-empty verdict set.
4. Every physical completion attempt passes through the existing call-budget
   wrapper and consumes one call. No hidden retry is allowed inside the provider
   adapter.
5. Attempt 02 raises the hard provider-call ceiling from `270` to `360`: `180`
   reviewer calls plus at most `2 × 90` critic calls.
6. Provenance records the resolved critic-attempt limit. The committed
   preregistration must match the CLI flag, call ceiling, output path and all
   existing roster/corpus gates before the first provider call.
7. Provider substitution, favorable repeat selection and overwriting remain
   forbidden. Attempt 01 remains immutable; Attempt 02 writes to a new directory.

## Distribution correction

The four generated platform package manifests must use a description that names
both Claude Code and Codex, matching the already-correct main package. A regression
test must assert this for every target.

## Verification

- Red/green test proving Codex review and completion include
  `--ignore-user-config`.
- Red/green tests proving critic retry on throw and empty/unparseable output,
  stop-on-success, and exhaustion after the exact attempt count.
- Red/green tests proving every retry consumes the shared physical-call budget.
- CLI, preregistration and backward-compatible result-schema tests for the new
  attempt limit.
- Platform-manifest description red/green test.
- Typecheck, lint, build, full suite, npm packaging and native smokes.
- Rebuild the compiled runner after the fix and record its SHA-256.
- Commit/push the exact Attempt 02 preregistration and wait for exact-SHA CI before
  making any provider call.
- Publish no benchmark claim unless reviewer and eligible-critic coverage are both
  exactly `100%` and every matrix variant is authoritative.

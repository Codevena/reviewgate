# Alpha.12 reliability, benchmark v2 and launch plan

- **Date:** 2026-07-13
- **Scope:** Reliability fixes, reproducible evidence and distribution only
- **Release target:** `v0.1.0-alpha.12`
- **Control-plane constraint:** Do not edit `reviewgate.config.ts` or `.reviewgate/control-plane.json`

## Outcome

Ship one deliberately small reliability release that removes the three concrete
limitations discovered while producing Alpha.11 evidence, publish a materially
stronger repeated benchmark with raw machine-readable artifacts, then launch the
project publicly with only claims supported by those artifacts.

No dashboard, additional provider, GitHub Action, Lore v2 or broad core refactor
belongs in this cycle.

## 1. Collision-safe audit chains

### Problem

`AuditLogger.computePath()` currently names a process-local chain only by UTC
`HHMMSS`. Two hook processes starting in the same second append independent hash
chains to the same file, each beginning with an empty `prev_event_hash`. The
resulting interleaving makes `audit verify` fail even though neither process
tampered with the log.

### Change

- Keep the existing `audit/YYYY/MM/DD/` day partition and `.jsonl` extension.
- Give every `AuditLogger` instance a collision-resistant, process-local chain
  basename with the exact filesystem-safe grammar
  `HHMMSSmmm-p<PID>-<32 lowercase hex>.jsonl` (128 random bits).
- Memoize that unique file for the logger lifetime exactly as today. Each process
  therefore owns one independent verifiable chain; no shared-file locking or
  cross-process hash coordination is introduced.
- Preserve all readers (`*.jsonl` / `**/*.jsonl`), retention and verifier behavior.
- Update stale documentation that promises a bare `HHMMSS.jsonl` name.

### Tests and mutation proof

- Freeze the clock, construct many logger instances and assert every path is
  distinct while all remain in the expected UTC day and end in `.jsonl`.
- Append and verify every chain independently.
- Load and aggregate `run.complete` events from several same-clock logger files so
  stats/window readers are regression-proven, not merely assumed compatible.
- Mutation: temporarily restore second-only filenames in a copied source tree;
  the uniqueness regression test must fail.

## 2. Portable symbol-graph caller paths

### Problem

Both ripgrep and the built-in fallback return absolute caller paths. Those paths
enter `research.md`, reviewer prompts and recorded cassettes, leaking checkout
locations and making otherwise identical evidence differ across machines.

### Change

- Replace the lossy colon-delimited ripgrep parser with deterministic
  `rg --json --no-config`; reject truncated/malformed records fail-safely.
- Resolve every candidate as a native path against a realpath-canonical repository
  root. Before rendering, reject parent/sibling-prefix escapes, missing paths,
  final/intermediate symlinks and non-regular files with the existing capped,
  `O_NOFOLLOW` contained reader. Only an accepted native relative path is converted
  to `/`; a legal POSIX backslash is not treated as a path separator.
- Make the fallback use that same capped/no-follow reader before it scans content;
  it must never call uncapped `readFileSync` on repository-controlled paths.
- Apply the same output normalization to ripgrep and fallback results so behavior
  does not depend on the optional `rg` binary.
- Leave file parsing and changed-file paths untouched.

### Tests and mutation proof

- Assert `buildSymbolGraph()` returns `b.ts`/nested repo-relative paths and never
  embeds the temporary repository root.
- Assert the fallback path is relative too.
- Render `research.md` and assert no checkout root appears.
- Inject both search implementations and cover parent/sibling-prefix, missing,
  outside/intermediate/final symlinks, oversized files, drive/UNC inputs on the
  applicable platform, case/separator edges, and colon/newline/Unicode filenames.
- Mutation: bypass normalization in a copied tree; the portability test must fail.
- Mutation: restore fallback `readFileSync`; outside-symlink and oversize tests must
  fail before any target bytes are read.

## 3. Real structured OpenRouter setup smoke

### Problem

The setup wizard currently calls the free-form `complete()` API. Alpha.11 proved
that a model/upstream can pass that probe and still reject the production
reviewer's strict `response_format: json_schema` request.

### Change

- Give each probe an explicit production purpose: reviewer/quota-fallback uses the
  real strict `review()` path; critic/curator uses the real free-form `complete()`
  path. Success therefore proves the selected role's actual request shape rather
  than a role-blind approximation.
- Use a constant, repository-data-free in-memory PASS prompt/diff. Create no repo
  file. OpenRouter transmits a hard output-token cap, uses a 15-second probe-only
  timeout, discloses that verification is a paid API call, and deduplicates
  identical successful purpose/model/route tuples within one wizard run.
- Keep the existing completion contract for non-OpenRouter providers.
- Add `openrouterProvider` routing to `ProbeInput` and forward it into the real
  provider config.
- First collect every role/model choice, then construct the same finalized
  in-memory provider candidate that `buildCustomConfig()` will persist. Ask for the
  single shared OpenRouter route before validating any OpenRouter tuple and probe
  every reviewer, fallback, critic and curator role selected for that provider.
- For the known default `deepseek/deepseek-v4-flash`, suggest `alibaba` unless an
  existing config already supplies a route. Do not generalize that suggestion to
  unrelated DeepSeek models.
- A failed OpenRouter probe offers explicit model re-entry, route re-entry/back, or
  keep-anyway. Changing the shared route invalidates and re-runs every earlier
  OpenRouter probe. Cancellation at any point writes neither config nor hooks.
- Existing `{order, allowFallbacks}` routes are preserved when unchanged; a route
  the wizard edits is canonicalized to the documented `{only:[slug]}` policy. The
  saved model/auth/route tuple and the probed tuple are byte-for-byte identical;
  only the documented 15-second timeout and output cap are probe-specific.
- Update README, OpenRouter quickstart and evidence limitations to describe the
  Alpha.12 behavior without rewriting the historical Alpha.11 recording.

### Tests and mutation proof

- Assert reviewer/fallback OpenRouter probing calls `review()` rather than
  `complete()`, passes the constant prompt, exact model/auth/routing and explicit
  timeout/output cap, and only accepts an `ok` status. This proves the strict
  request completed and Reviewgate parsed a review-shaped response; it does not
  overclaim independent validation of every provider JSON-schema constraint.
- Assert critic/curator OpenRouter probes use `complete()` and the exact persisted
  tuple; assert identical tuples are deduplicated.
- Assert an ERROR, unparseable strict response or thrown adapter remains a failed
  probe with an actionable detail.
- Preserve existing completion-probe tests for non-OpenRouter providers.
- Cover route/model re-entry, preserved structured routing, fallback-only and
  critic/curator-only ordering, shared-route revalidation, cancellation and zero
  writes on cancel.
- Mutation: switch the OpenRouter branch back to `complete()` in a copy; the new
  structured-probe test must fail.
- Run one real credentialed OpenRouter structured probe against the selected
  Alpha.12 documented route. Record the date/model/upstream, never the key.

## 4. Package/release truth alignment

- Bump root version to `0.1.0-alpha.12` before the authoritative benchmark.
- Make generated main and platform npm manifests use
  `https://reviewgate.codevena.dev/` and a Claude Code + Codex description.
- Update install/version examples that mean “current release”; keep explicit
  Alpha.11 evidence/provenance text pinned to Alpha.11.
- Add manifest regression assertions so a future release cannot silently restore
  the GitHub-only homepage or Claude-only description.

## 5. Benchmark v2 corpus and artifacts

### Corpus

Expand the current 18-case bootstrap to 30 cases by adding six mutation pairs:
one seeded bug and one correct counterpart for each scenario.

1. tenant-bound authorization / IDOR;
2. inventory reservation race / atomic transaction;
3. archive extraction Zip Slip / containment check;
4. signed return URL validation / open redirect;
5. untrusted Python deserialization / safe JSON validation;
6. multi-write transaction partial failure / atomic rollback.

Each pair must be self-contained, apply to an empty tree, use at least one
multi-file/business-flow fixture where natural, and contain exactly the declared
defect in the seeded variant. Labels use semantic alternatives rather than
one-word tags. The final mix is 16 clean and 14 seeded cases.

### Pre-registered run

- Commit an exact machine-readable preregistration before the first provider call:
  command, roster/model/route, corpus hashes, estimands, repeat count, full-coverage
  rule, hard call/output bounds and rerun policy. Fixed result names may never
  overwrite an attempt; every attempt gets an immutable timestamp/id and checksum.
- Commit the Alpha.12 code and corpus before measuring. Benchmark provenance must
  fail closed unless Git returns a real commit, the entire tracked repository is
  clean, the corpus is clean, and the exact compiled runner SHA-256 is recorded.
- Primary panel: `codex,claude-code`; critic: `openrouter`; cold stores/cache;
  explicit critic model and pinned upstream; `--repeat 3`; minimum 16 clean and 14
  seeded; maximum failed fraction 0; 100% coverage for every provider × case ×
  repeat and every eligible critic call.
- Add `--critic-model` and `--critic-openrouter-provider` to `bench run` and
  `bench matrix`, construct the exact critic provider config from those values and
  record the resolved model/route.
- Do not silently substitute providers or cherry-pick a favorable repeat. If
  coverage is insufficient, preserve the failed/non-authoritative artifact and
  restore availability before the pre-registered rerun. Any alternative panel is
  a separately named result, never the headline.
- Add backward-compatible provenance for source/runner commit and digest, resolved
  critic provider/model/route, unique cases versus case-runs, and per-case/repeat
  critic eligibility/status. Old `reviewgate.bench.result.v1` files must still parse.
- Enforce a preregistered provider-call ceiling shared across the run/matrix, cap
  OpenRouter output tokens on the wire and abort before the next call would exceed
  the ceiling. Unknown token/billing data is `null`/unknown, never false `$0`.

### Controlled critic ablation

- Do not run a second stochastic reviewer panel for `-critic`. Wrap the primary
  reviewer adapters for the baseline, capture each normalized raw `ReviewResult`
  against a prompt/config/ordinal hash, then replay those exact results into the
  critic-off variant. A hash/order mismatch invalidates the matrix.
- Persist the captured response hashes plus the complete baseline and critic-off
  `BenchResult` artifacts. Do not publish model transcripts or secret-bearing raw
  request bodies.
- `runBenchMatrix()` must require exit `0` and every validity/full-coverage gate on
  baseline and every variant. It preserves failed variant results, returns nonzero
  on any invalid variant, and derives matrix authority/references/checksums from
  the underlying immutable results instead of deleting them.

### Published artifacts

Commit under a dated `bench/results/alpha12-v2/` directory:

- full repeated `result.json`;
- critic-ablation `matrix.json` for the same roster/repeat count;
- complete paired `baseline.result.json` and `no-critic.result.json`, plus the
  non-secret reviewer-response hash manifest proving identical reviewer samples;
- rendered `report.md` containing exact counts, Wilson intervals and stability;
- `MANIFEST.md` with command lines, environment/tool versions, corpus commit,
  limitations and interpretation;
- `SHA256SUMS.txt` covering every machine-readable/result artifact.

The result JSON files are machine-readable normalized artifacts, not raw model
transcripts. They contain provider metrics, unique-case and correlated case-run
counts, per-repeat outcomes and critic status. Repeat-pooled Wilson intervals are
descriptive only and must not be framed as 90 independent observations; headline
stability is the three preregistered per-repeat values/mean/spread at 30 unique cases.

### Benchmark verification

- Validate all 30 case schemas and patches offline.
- Independently audit the corpus label-blind before freezing it; add executable
  oracles where feasible for transaction/race/containment behavior and require a
  reviewer to confirm every clean case is defect-free and every seeded case has
  exactly its declared defect.
- Unit-test the additive critic/routing provenance fields and old-result parsing.
- Require exit `0`, repository/corpus clean state, real commit/runner digest, 100%
  reviewer and eligible-critic coverage, paired response-hash equality and every
  matrix variant authoritative before any headline enters public copy.
- Verify checksums in CI/local checks and render the report from the committed
  JSON rather than hand-copying metrics.

## 6. Verification and review gates

Before the first implementation commit:

1. focused tests for each slice;
2. the four counter-mutations above in disposable copies;
3. `bun run typecheck`;
4. `bun run lint`;
5. `bun run build`;
6. full deterministic `bun test`;
7. native binary integration and npm pack→install→init smoke;
8. all five npm packages (main plus four platform packages) build/verification;
9. deterministic Alpha.11 demo normal path plus checksum/prompt-drift/hash-tool
   negative paths;
10. independent code-quality review with zero unresolved CRITICAL/WARN findings.

After benchmark artifacts/docs are added, repeat static checks for the changed
scope and independently review the exact release diff. Remove `.review/` before
commits. Never bypass ReviewGate hooks.

## 7. Commit, push and Alpha.12 release

The user's “Alpha.12 → Benchmark v2 → Launch” request is the explicit authority
for the in-scope commits, pushes, release tag and public launch. Keep unrelated
workspace/Brain changes out of the repository commits.

1. Commit reviewed reliability + corpus + version work and push `master`.
2. Wait for exact-SHA CI to pass.
3. Build/hash the runner and run the pre-registered benchmark from that clean
   commit under its hard call bound; preserve every attempt.
4. Commit reviewed artifacts, README/docs/evidence/launch copy and the website
   Evidence block; push.
5. Wait for exact-SHA CI and the website Pages deployment, then verify public links.
6. Before tagging, verify the remote tag/release and all five npm versions are
   absent (or byte-identical recovery artifacts), confirm the intended `latest`
   dist-tag policy/package contents, and scan public artifacts/commands for keys,
   expanded environment values, home paths and private URLs.
7. Tag that exact commit `v0.1.0-alpha.12` and push the tag without bypass.
8. Verify Release Actions, GitHub prerelease assets/checksums, all four platform
   packages, the main npm package, provenance, `latest`, homepage/description and
   a completely fresh registry install including Codex trust.

## 8. Launch

- Re-run the released deterministic demo and open all public links signed out.
- External submission begins only after the already-committed website Evidence
  block and `docs/launch-kit.md` are live with the actual authoritative Alpha.12
  numbers and clear small-N/correlated-repeat/model caveats.
- Publish the prepared Show HN, Reddit/LocalLLaMA and X/Bluesky messages using an
  existing authenticated Markus/Codevena account only. Do not create accounts,
  weaken platform security or publish from an unrelated identity. If no suitable
  authenticated session exists, stop at the fully prepared submit screen and ask
  Markus to authenticate/submit.
- Record canonical post URLs and timestamp. Verify the rendered posts and links.
- Monitor GitHub issues/release/website health for a bounded 30-minute same-session
  window; record a Markus-owned 48–72-hour follow-up checklist. Do not imply
  indefinite automation or invent engagement/adoption.

## 9. Definition of done

- All three Alpha.12 reliability defects are regression- and mutation-proven.
- Config/control-plane hashes remain byte-identical and APPROVED.
- A clean, repeated 30-case benchmark plus critic ablation and checksums is public.
- Alpha.12 is live on GitHub and npm, exact packages and clean-room setup verified.
- Website/evidence/README/npm metadata agree on the released behavior.
- Public launch posts are live, or the only blocker is an explicitly reported
  missing human login/submit action.
- Repository is clean and synchronized; Brain project/daily notes carry the exact
  release, benchmark, launch URLs, caveats and remaining user feedback work.

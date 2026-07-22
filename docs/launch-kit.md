# Reviewgate launch kit

Drafts only. Nothing in this file has been posted. Re-check the linked release,
website and evidence immediately before publishing.

## Core links

- Website: https://reviewgate.codevena.dev/
- GitHub: https://github.com/Codevena/reviewgate
- npm: https://www.npmjs.com/package/reviewgate
- Release: https://github.com/Codevena/reviewgate/releases/tag/v0.1.0-alpha.12
- Evidence: https://github.com/Codevena/reviewgate/blob/master/docs/evidence.md
- Demo: https://github.com/Codevena/reviewgate#reviewgate

## One-sentence position

Reviewgate is a local, native Stop-hook verification loop for Claude Code and
Codex: an independent reviewer inspects the actual diff, unresolved blocking
findings keep the agent working, and infrastructure failure never masquerades as
a clean pass.

## Show HN draft

**Title**

> Show HN: Reviewgate – a fail-closed review loop for Claude Code and Codex

**Body**

> I built Reviewgate because the agent that writes a change should not be the
> only agent deciding it is done.
>
> Reviewgate installs native repository hooks for Claude Code and Codex. At turn
> end it reviews the actual committed + uncommitted diff with an independent
> provider, blocks unresolved CRITICAL/WARN findings, asks for explicit fix or
> rejection decisions, and re-runs until PASS or a bounded human escalation.
> Reviewer crashes, quota and timeouts stay visibly non-PASS.
>
> The current alpha supports Codex, Gemini, Claude, OpenCode, OpenRouter and
> Ollama paths; config changes are a separate control plane reviewed under the
> last-known-good policy. It is local plain-file state, MIT licensed, and ships
> native macOS/Linux binaries through npm.
>
> I recorded a real Alpha.11 run: SQL injection → GATE CLOSED → accepted/fixed
> decision → parameterized query → GATE OPEN. The public demo replays only the
> recorded provider responses; the production gate and audit path execute live,
> and the provenance/checksums are published.
>
> This is alpha software. Sandboxing is opt-in, uses a denylist read model, and
> does not isolate network egress. The current Alpha.12 benchmark is a
> preregistered 30-case × 3-repeat run with raw artifacts: Codex and Claude Code
> both reached 90/90 coverage, the critic reached 86/86 eligible coverage, and
> the critic reduced clean-case false positives by 16.7 percentage points at
> unchanged recall. It is still not a leaderboard. I would especially value
> feedback on the decision protocol and fail-closed semantics.
>
> Website: https://reviewgate.codevena.dev/
> Source: https://github.com/Codevena/reviewgate
> Release: https://github.com/Codevena/reviewgate/releases/tag/v0.1.0-alpha.12

## Reddit / LocalLLaMA draft

**Title**

> I open-sourced a native review gate that can stop Claude Code or Codex from ending a changed turn

**Post**

> The basic loop is: coding agent writes → independent model reviews the actual
> diff → blocking findings return through local files → agent fixes or records a
> reasoned disposition → Stop hook re-runs.
>
> Reviewgate supports six provider paths, including OpenRouter and local/cloud
> Ollama. It distinguishes PASS from soft-pass, provider failure, bounded defer
> and escalation; a reviewer outage cannot turn into green. Policy changes are
> fingerprinted separately and checked under the last-known-good config.
>
> I have published the caveats too: CLI sandboxes are opt-in, filesystem reads
> are denylist-based rather than allowlist-based, and network egress remains
> open. The benchmark headline comes from a preregistered 30-case × 3-repeat
> Alpha.12 run with raw artifacts: 90/90 coverage for both reviewers, 86/86
> eligible critic coverage, and 16.7 percentage points fewer clean-case false
> positives with the critic enabled at unchanged recall.
>
> Real Alpha.11 evidence and demo provenance:
> https://github.com/Codevena/reviewgate/blob/master/docs/evidence.md
>
> Repo: https://github.com/Codevena/reviewgate

## X / Bluesky thread draft

1. The coding agent should not be the only agent deciding its own work is done.
   I built Reviewgate: a native Stop-hook verification loop for Claude Code +
   Codex. https://reviewgate.codevena.dev/
2. It reviews the actual committed + uncommitted diff. A blocking finding keeps
   the turn alive until the agent fixes it or records an explicit, reasoned
   disposition.
3. Failure is not green: PASS, soft-pass, quota/infrastructure defer and bounded
   human escalation remain separate states.
4. Real Alpha.11 run: SQL injection → GATE CLOSED → decision + parameterized fix
   → GATE OPEN. Provider responses are recorded for deterministic replay; the
   gate/audit path executes live and hashes are published.
5. Six provider paths, native Claude Code + Codex hooks, last-known-good policy
   control plane, plain local evidence. MIT, alpha, honest threat model.
   https://github.com/Codevena/reviewgate
6. Alpha.12 is live on npm. The benchmark v2 run is preregistered and raw:
   30 cases × 3 repeats, Codex 90/90, Claude Code 90/90, critic 86/86 eligible;
   critic reduced clean-FP by 16.7pp at unchanged recall.

## Pre-publish checklist

- Run `bash assets/demo/demo.sh` with the released version.
- Confirm CI, Pages, GitHub Release and all npm packages are green/live.
- Open every link from a signed-out browser.
- Use the demo GIF or a fresh screen recording; do not crop out the replay notice.
- Keep “alpha”, sandbox/network limits and the hand-authored benchmark caveat visible.
- Answer technical questions with the evidence page, not stronger claims.
- Quote only the published Attempt-09 benchmark numbers unless a newer raw-artifact
  run is committed first.

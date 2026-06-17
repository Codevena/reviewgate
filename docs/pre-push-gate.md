# Pre-push gate & the deep-review-before-deploy guarantee

The Stop-hook gate runs at **turn-end** and has no authority over a later `git push`. So a
"clean" turn-end pass can be pushed — and on a push-to-deploy setup (Coolify/Vercel auto-deploy
on `main`) **deployed** — before a deeper review of the *final* commit ran (the field-report
scenario). This document covers the two layers that close that gap.

## Layer 1 — local warn-only pre-push hook (shipped)

`reviewgate init` installs a **warn-only** git hook at `.git/hooks/pre-push` that delegates to
`.reviewgate/bin/pre-push`. Before a push it checks `.reviewgate/state.json` for a recorded clean
Reviewgate PASS on the commit being pushed and, if there isn't one, prints an advisory:

```
⚠ Reviewgate pre-push: the commit being pushed was not the last reviewed HEAD
  (Reviewgate last passed on 1a2b3c4) — newer commits may be unreviewed.
  This push is NOT confirmed deploy-ready by Reviewgate. …
```

Properties (all by design):

- **Never blocks.** The hook always exits 0 — it only *warns*. A local git hook is bypassable
  (`git push --no-verify`) anyway, so a hard block would be friction with false security. The
  real guarantee belongs in CI (Layer 2).
- **No-clobber.** `init` only writes the hook into a plain `.git/hooks` directory and **never**
  overwrites a foreign existing `pre-push` hook (it prints how to chain it manually). Worktrees/
  submodules (where `.git` is a file) are skipped with a note.
- **"PASS" = the pushed tip IS the last-reviewed HEAD of a clean, non-escalated re-arm.** Pushing
  newer commits on top of the reviewed HEAD, a FAILed/escalated state, or a never-reviewed repo
  all warn.
- **Toggle:** set `loop.prePushWarn: false` in `reviewgate.config.ts` to make the installed hook
  a no-op (default `true`).

> Note: `.reviewgate/state.json` is **local and gitignored** — it is a per-clone signal for the
> developer's own machine, not something CI can read from the repo. That's why the hard guarantee
> lives in CI as a fresh review (Layer 2), not in a check of the committed state.

## Layer 2 — CI gate (the hard, unbypassable guarantee)

For a true block-before-deploy, run a Reviewgate review **in CI on the pushed commit** and gate
the deploy on a green job. Unlike the local hook this is server-side and cannot be `--no-verify`'d.
This requires the reviewer CLI(s) to be authenticated in CI (OAuth/API keys as secrets), which
costs review time/quota — so most teams gate the **deploy** job on it rather than every push.

Skeleton (GitHub Actions — adapt the auth + invocation to your reviewer setup):

```yaml
# .github/workflows/reviewgate.yml
name: reviewgate
on:
  push:
    branches: [main]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }            # full history so the diff base resolves
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      # Authenticate your reviewer(s) here from CI secrets, e.g.:
      #   OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      # Then run Reviewgate over the pushed range and fail the job on findings.
      # (Wire to your reviewer config; OAuth CLIs may need a non-interactive token.)
      - run: bunx reviewgate review-plan <(git diff ${{ github.event.before }}..${{ github.sha }})
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Then make your deploy (Coolify/Vercel) depend on this job passing — that is the enforceable
"deep review before deploy" guarantee. The local pre-push hook (Layer 1) is the cheap, immediate
nudge that catches the common case before the push even leaves the developer's machine.

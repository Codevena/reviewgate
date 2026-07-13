# Pre-push warning and the current deploy boundary

The Stop-hook gate runs at **turn-end** and has no authority over a later `git push`. So a
"clean" turn-end pass can be pushed — and on a push-to-deploy setup (Coolify/Vercel auto-deploy
on `main`) **deployed** — before a deeper review of the *final* commit ran (the field-report
scenario). Reviewgate currently ships a local warning only; it does **not** ship a
CI range-review command or an unbypassable deploy guarantee.

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
  (`git push --no-verify`) anyway, so a hard block would be friction with false security. A
  real guarantee would need a supported CI command plus protected branch/deploy rules.
- **No-clobber.** `init` only writes the hook into a plain `.git/hooks` directory and **never**
  overwrites a foreign existing `pre-push` hook (it prints how to chain it manually). Worktrees/
  submodules (where `.git` is a file) are skipped with a note.
- **"PASS" = the pushed tip IS the last-reviewed HEAD of a clean, non-escalated re-arm.** Pushing
  newer commits on top of the reviewed HEAD, a FAILed/escalated state, or a never-reviewed repo
  all warn.
- **Toggle:** set `loop.prePushWarn: false` in `reviewgate.config.ts` to make the installed hook
  a no-op (default `true`).

> Note: `.reviewgate/state.json` is **local and gitignored** — it is a per-clone signal for the
> developer's own machine, not something CI can read from the repo. A future CI
> command must create fresh server-side evidence; it cannot reconstruct this local state.

## CI/deploy gate — not shipped yet

Do **not** use `reviewgate review-plan <(git diff ...)` as a substitute. `review-plan`
accepts repository files containing plans/specifications; a shell process-substitution
path is outside the repository, and even an ordinary diff file would be reviewed as a
document rather than as a base/head code range. It cannot establish a commit-range gate.

A real Layer 2 needs a dedicated command such as:

```text
reviewgate ci --base <trusted-base-sha> --head <candidate-sha>
```

That future command must resolve and validate the range, include added files, use a
CI-appropriate fail-closed exit contract, authenticate reviewers non-interactively,
produce an artifact, and integrate with protected required checks. Until it exists,
use Reviewgate's local warning as advisory evidence and gate deployments with your
normal deterministic CI/tests plus human review. Do not describe the current setup as
an unbypassable Reviewgate deploy guarantee.

# npm publish runbook

Reviewgate publishes five packages: `reviewgate` (launcher) + four
`@codevena/reviewgate-<os>-<arch>` prebuilt-binary packages. See
`docs/superpowers/specs/2026-06-23-npm-packaging-design.md`.

Auth is **OIDC Trusted Publishing** — no long-lived npm token. The CI job mints a
short-lived credential from the GitHub OIDC identity that npmjs.com trusts per-package.

## One-time setup
1. `npm login` (2FA) — only needed for manual ops / `npm view` / the local fallback below.
   CI does **not** use your login.
2. **No npm org needed.** `@codevena` is your npm **user scope** — you can publish public
   scoped packages under your own username for free. (You can't create an org named after an
   existing user; npmjs.com offers "Convert" instead — don't.)
3. **Trusted Publishing (per package — this IS the auth):** on npmjs.com, for **each of the
   5 packages** → package → Settings → **Trusted Publishing** → Add:
   - Publisher: **GitHub Actions**
   - Organization or user: `Codevena` · Repository: `reviewgate`
   - Workflow filename: `release.yml` (filename only) · Environment name: *(leave empty)*
   - Allowed actions: ☑ `Allow npm publish`

   ⚠️ Trusted Publishing can only be configured **after a package exists** (first publish).
   The current 5 already exist + are configured, so normal releases are pure OIDC.
4. **No `NPM_TOKEN` secret.** The `publish-npm` job uses `id-token: write` + npm ≥ 11.5
   (pinned `11.17.0`) + the default registry — no `registry-url`, no `NODE_AUTH_TOKEN`.

### Bootstrapping a brand-NEW package
A package that doesn't exist yet can't have Trusted Publishing set up, so its **very first**
publish needs a fallback: publish it once via the local fallback below (`npm login`), then
add its Trusted Publishing entry (step 3). Subsequent releases are pure OIDC.

## Release (CI — recommended)
1. Bump `package.json` `version` (e.g. `0.1.0-alpha.3`) **and** the README install-example
   version. The CI drift guard checks the *committed* root version against the tag, so
   **commit before tagging**.
2. `git tag v0.1.0-alpha.3 && git push origin v0.1.0-alpha.3`.
3. `release` builds the GitHub Release tarballs; `publish-npm` then builds `npm-dist/`,
   verifies it, and publishes all five via **OIDC** (platform packages first, then main)
   with provenance. Publishes are **idempotent** (already-published versions are skipped).

## Migrating off the old token (one-time, in progress)
The first releases used a bypass-2FA `NPM_TOKEN`. After the first **green OIDC release**:
1. npmjs.com → Access Tokens → **revoke** the granular publish token.
2. GitHub → repo Settings → Secrets → Actions → **delete** `NPM_TOKEN`.

Order matters: keep the token until one OIDC release is confirmed green (fallback safety net).

## Release (local fallback — loses OIDC + provenance)
OIDC + provenance only work from the GitHub Actions context, so prefer CI. Local fallback
needs an interactive `npm login` (2FA):
```bash
bun run build:npm && bun run verify:npm
for d in npm-dist/@codevena/*; do npm publish "./$d" --access public; done
npm publish ./npm-dist/main --access public
```

## Partial-publish recovery
npm versions are **immutable** and cannot be re-published or (within 24 h) un-published.
If a publish fails mid-way (e.g. 2 of 4 platform packages went up, main did not):
- Just **re-run the same tag** (re-push it, or re-run the CI job). `publish_idem` skips the
  already-published versions and finishes the rest — no abort.
- If you need to change package **content**, you cannot reuse the version — **bump** it
  (new tag) and republish all five.
- Never publish `main` before all four platform packages are live (the job already orders
  it last; if publishing by hand, keep that order — main pins the platforms exactly).

## Dist-tags
npm >= 11 **REFUSES to publish a prerelease without an explicit `--tag`** (npm 10
auto-assigned `latest`). While the only releases are alphas, the `publish-npm` job passes
`--tag latest` so the newest alpha is `latest` and a bare `npm i -g reviewgate` installs it.
Once a **stable** release exists, switch prereleases to `--tag next` so they don't move `latest`.

## Verify

⚠️ **Do NOT `npm i -g reviewgate` on the dev machine.** npm's global prefix here is
`/Users/markus/.local`, so a global install writes `/Users/markus/.local/bin/reviewgate` —
which IS the symlink to this repo's `dist/reviewgate` that every other repo resolves
through. It would be replaced by npm's launcher shim. Smoke-test in an isolated prefix:

```bash
smoke="$(mktemp -d)"
npm i --prefix "$smoke" reviewgate@<version> --no-audit --no-fund
"$smoke/node_modules/.bin/reviewgate" --version   # must print <version>
"$smoke/node_modules/.bin/reviewgate" doctor      # run from a gated repo
```

The `--version` line is the real assertion: the launcher SPAWNS the platform binary, so a
correct version proves the whole optionalDependency → binary path resolved. Also confirm
`doctor`'s tree-sitter grammar path points **inside the installed platform package** — that
is the `bun --compile` wasm trap, and `bun test` cannot catch it.

**Propagation lag:** immediately after publish, the registry serves the metadata before the
tarballs. The optional platform package then fails to fetch — and optional deps fail
**silently**: you get `added 1 package` (after minutes of retries) and the launcher reports
"unsupported platform". This is not a broken release. Wait a few minutes and reinstall until
you see `added 2 packages`. To settle it fast, install the **previous** version the same way
as a control — if that pulls 2 packages in ~1s, the new one is just lagging.

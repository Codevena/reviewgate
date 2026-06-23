# npm publish runbook

Reviewgate publishes five packages: `reviewgate` (launcher) + four
`@codevena/reviewgate-<os>-<arch>` prebuilt-binary packages. See
`docs/superpowers/specs/2026-06-23-npm-packaging-design.md`.

## One-time setup (MUST be done before the first tag)
1. `npm login` (2FA as configured).
2. Create the `@codevena` npm **org** (free for public packages): npmjs.com → Add
   Organization → `codevena`. Without it, every scoped `npm publish` 404s.
3. Add a **granular/automation publish token** as the repo secret `NPM_TOKEN`
   (GitHub → Settings → Secrets → Actions) with **create + publish** rights for
   `reviewgate` and `@codevena/*`. Automation tokens bypass 2FA by design (intended for CI).

## Release (CI — recommended)
1. Bump `package.json` `version` (e.g. `0.1.0-alpha.2`) **and** the README install-example
   version (Option A tarball name + Option C, if pinned). The CI drift guard checks the
   *committed* root version against the tag, so **commit before tagging**.
2. `git tag v0.1.0-alpha.2 && git push origin v0.1.0-alpha.2`.
3. The `release` workflow builds the GitHub Release tarballs; `publish-npm` then builds
   `npm-dist/`, verifies it, and publishes all five (platform packages first, then main)
   with provenance. Publishes are **idempotent** (already-published versions are skipped).

## Release (local fallback — loses provenance)
Provenance can only be generated from the GitHub Actions OIDC context, so prefer CI for
public releases. Local fallback:
```bash
bun run build:npm && bun run verify:npm
for d in npm-dist/@codevena/*; do npm publish "$d" --access public; done
npm publish npm-dist/main --access public
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
While the only releases are alphas, publish **without** an explicit dist-tag so the alpha
becomes `latest` and a bare `npm i -g reviewgate` installs it. Once a **stable** release
exists, publish prereleases with `--tag next` so they don't move `latest`.

## Verify
```bash
npm i -g reviewgate@<version>
reviewgate doctor
```

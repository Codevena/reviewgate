# S3 — Worktree Trust Inheritance: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked `git worktree` of a checkout whose human already approved the repo's Reviewgate policy runs the gate under that same approval — without a second approval ceremony — and only while the worktree's **effective** config is byte-for-byte the approved policy.

**Architecture:** One new never-throwing predicate in `src/config/control-plane.ts`, `inheritedWorktreeApproval(input)`, resolves the shared gitdir, reads the main checkout's `control-plane.json` **read-only**, and returns a `ControlPlaneState` to adopt iff the worktree's own effective-config fingerprint equals the main checkout's `approved_effective_fingerprint`. Two call sites consume it: `probeArming` (so the S2 zero-writes early-return does not fire) and `resolveControlPlaneConfig`'s no-LKG branch (which materializes that state into the worktree's own `.reviewgate/control-plane.json`). After the first inheriting run the worktree is an ordinary armed checkout and every later drift goes through the normal pending-candidate machinery.

**Tech Stack:** Bun, TypeScript, zod, `bun test`. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-arming-consent-design.md`, slice **S3**, subsection "S3 design (decided 2026-07-29, Markus)". That subsection is normative for this plan.
- **`probeArming` alone is not S3.** With only the probe changed, a worktree of a repo that ships a committed `reviewgate.config.ts` falls through to `resolveControlPlaneConfig`, which throws `ControlPlaneBootstrapRequiredError` (`control-plane.ts:394-398`) → `runGateSafe` turns it into a fail-closed block. Task 3 is mandatory, not optional polish.
- **The predicate must never throw.** Every failure path returns `null` (= not armed). A throw from `probeArming` would surface as a gate crash in unarmed repos — the exact fail-open/fail-loud class S2 closed.
- **The predicate must not write.** It is called from `probeArming`, which is the zero-writes path. Only Task 3's call site writes, and only after inheritance was established.
- **Check ordering is load-bearing and identical in both call sites:** local LKG > managed hook > inheritance > unarmed. Inheritance must never rescue a deleted approval (`rm .reviewgate/control-plane.json` in a worktree that `init` armed must keep blocking).
- **Fingerprint comparison is over the EFFECTIVE merged config** (defaults ← global ← project), never the committed project file's hash (spec F-007).
- **`gateEverywhere` remains out of scope** (spec §7.2/§8): `armed()` has exactly two true-branches — approved LKG for this checkout, or worktree-inherited.
- **S3 does not make hooks fire in a worktree.** That is S4 (`init --user`) or `reviewgate init` inside the worktree. Do not claim otherwise in code comments, docs or the commit message.
- **Never hand-write a `control-plane.json` fixture.** `approved_source_fingerprint`/`approved_effective_fingerprint` are `z.string().min(64).max(64)` and `approved_config` is the full `ConfigSchema`; a short-string fixture fails to parse, `readState` returns null, and the test silently exercises the UNARMED path **while looking green**. Use `tests/helpers/arm.ts` → `armCheckout()`.
- **`armCheckout` and every test input must use `process.env` + `homedir()`.** This machine has `~/.config/reviewgate/reviewgate.config.ts`. A fake `home` makes the arming side and the resolving side compute different effective configs → `approval-required` → the forced review path → unrelated assertions break. NOTE: the existing `tests/unit/control-plane-arming.test.ts` passes `home: cwd`; that is safe there only because `probeArming` used `home` for nothing but `hasProjectSource`. The S3 predicate loads the effective config, so S3's tests MUST NOT copy that pattern.
- Runtime is Bun: `bun test`, `bunx tsc --noEmit`, `bun run lint` (biome) must all be clean.
- Never `git add -A` in this repo (stages `.reviewgate/` runtime state). Stage explicit paths.
- Commits carry no `Co-Authored-By` line. Do not push; Markus decides that separately.

---

## File Structure

- **Modify `src/schemas/control-plane.ts`** — add `"inherited-worktree"` to the `approved_via` enum (~line 31). The persisted artifact schema is the source of truth; `baseState` will not compile against an unlisted value.
- **Modify `src/config/control-plane.ts`** — add `inheritedWorktreeApproval()` (the trust decision) and the private `adoptInheritedBaseline()` (the write), plus the two call sites. Keeps the whole arming rule in the one module that already owns `readState`, `managedHookExists`, `inspectConfigSources` and `bootstrapControlPlane`.
- **Create `tests/helpers/worktree.ts`** — real `git init` + `git worktree add` fixtures. Three test files need them; S3 is a statement about git's on-disk layout, so faked directories would assert nothing.
- **Create `tests/unit/control-plane-worktree-inheritance.test.ts`** — the predicate matrix + the probe + the resolve/materialization behavior.
- **Modify `tests/unit/gate-arming-probe.test.ts`** — the gate-level (S2 + S3 interaction) cases.
- **Modify `CLAUDE.md` and `docs/AGENTS.md`** — correct the worktree gotcha.

No `doctor` change: `worktreeGatedCheck` (`doctor.ts:557`) measures whether the Reviewgate **hooks** are installed here, not whether the checkout is armed. Without hooks the gate does not fire however cleanly trust was inherited, so turning its FAIL into a PASS would report a gated checkout that is in fact ungated. The spec's original promise was struck for this reason in commit `2547bf9`.

---

### Task 1: The inheritance predicate

**Files:**
- Modify: `src/schemas/control-plane.ts:25-36` (the `approved_via` enum)
- Modify: `src/config/control-plane.ts` (imports; new function after `managedHookExists`, ~line 339)
- Create: `tests/helpers/worktree.ts`
- Test: `tests/unit/control-plane-worktree-inheritance.test.ts` (create)

**Interfaces:**
- Consumes: module-private `readState(repoRoot)`, `baseState(config, sourceFingerprint, approvedVia)`, `effectiveConfigFingerprint(config)`; `loadEffectiveConfigSnapshot`/`EffectiveConfigInput` from `./global.ts`; `worktreeInfo` from `../utils/git.ts` (verified: `src/utils/git.ts` imports nothing from `src/config/`, so this introduces no cycle).
- Produces: `export async function inheritedWorktreeApproval(input: EffectiveConfigInput): Promise<ControlPlaneState | null>` — consumed by Tasks 2 and 3. `export async function makeMainRepo(prefix?: string): Promise<string>` and `export async function addWorktree(main: string, name?: string): Promise<string>` in `tests/helpers/worktree.ts` — consumed by Tasks 2 and 4.

- [ ] **Step 1: Add the enum value**

In `src/schemas/control-plane.ts`, extend the `approved_via` enum and document it next to the existing `"automatic-global"` note:

```ts
  // "inherited-worktree": a linked git worktree adopted the main checkout's approved
  // policy (S3) after its OWN effective config fingerprint matched that approval.
  // Distinct from "human"/"init" so an auditor can see the approval was inherited,
  // not typed here.
  approved_via: z.enum([
    "defaults",
    "init",
    "human",
    "automatic-strengthening",
    "automatic-global",
    "inherited-worktree",
  ]),
```

Note for the reviewer: this is a forward-incompatible addition inside `reviewgate.control-plane.v1`. An older binary reading such a state fails the enum parse → `readState` throws → fail-closed block. That is the safe direction (never a silent downgrade to a weaker policy), and it is the same trade-off `"automatic-global"` already made.

- [ ] **Step 2: Write the worktree test helper**

```ts
// tests/helpers/worktree.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// REAL git checkouts, never faked directories. S3's trust rule is a statement about
// git's on-disk layout — a linked worktree's `.git` is a FILE pointing at
// <main>/.git/worktrees/<name>, and `git rev-parse --git-common-dir` resolves to
// <main>/.git. A hand-built directory tree would assert nothing about that.

// A main checkout with one commit. `config` (when given) is COMMITTED, so any worktree
// added afterwards checks it out too — which is exactly the real case: policy is
// committed, the arming mechanism is not.
export async function makeMainRepo(config?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-wt-main-"));
  await Bun.$`git -C ${dir} init -q`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  if (config !== undefined) writeFileSync(join(dir, "reviewgate.config.ts"), config);
  await Bun.$`git -C ${dir} add -A`.quiet();
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet();
  return dir;
}

// A linked worktree of `main`. The target dir must not exist yet, so it is created as a
// child of a fresh mkdtemp dir.
export async function addWorktree(main: string, name = "wt"): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), "rg-wt-link-")), name);
  await Bun.$`git -C ${main} worktree add -q ${dir} -b ${name}`.quiet();
  return dir;
}

// A worktree whose parent is a BARE repo: `--git-common-dir` is then `<…>/x.git`, whose
// basename is NOT ".git", so there is no main checkout to inherit from.
export async function addWorktreeOfBare(main: string): Promise<string> {
  const bare = join(mkdtempSync(join(tmpdir(), "rg-wt-bare-")), "x.git");
  await Bun.$`git clone -q --bare ${main} ${bare}`.quiet();
  const dir = join(mkdtempSync(join(tmpdir(), "rg-wt-blink-")), "wtb");
  await Bun.$`git -C ${bare} worktree add -q ${dir} -b fromBare`.quiet();
  return dir;
}
```

Both git facts asserted in those comments were verified empirically on this machine before
this plan was written: in a linked worktree `.git` is a file containing `gitdir: …` and
`--git-common-dir` prints `<main>/.git`; for a worktree of a bare clone it prints
`<…>/x.git`.

- [ ] **Step 3: Write the failing tests**

```ts
// tests/unit/control-plane-worktree-inheritance.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inheritedWorktreeApproval } from "../../src/config/control-plane.ts";
import { controlPlaneStatePath } from "../../src/utils/paths.ts";
import { armCheckout } from "../helpers/arm.ts";
import { addWorktree, addWorktreeOfBare, makeMainRepo } from "../helpers/worktree.ts";

const POLICY = "export default { loop: { maxIterations: 5 } };\n";

// The SAME inputs runGate uses. A fake home would resolve a different global layer than
// armCheckout did, so the effective fingerprints would differ and every inheritance case
// would fail for a reason that has nothing to do with S3.
function input(cwd: string) {
  return { cwd, env: process.env as Record<string, string | undefined>, home: homedir() };
}

describe("inheritedWorktreeApproval", () => {
  test("armed main + identical committed policy → inherits", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    const state = await inheritedWorktreeApproval(input(wt));
    expect(state).not.toBeNull();
    expect(state?.approved_via).toBe("inherited-worktree");
    // The inherited approval IS the main checkout's approval, not a fresh self-blessing.
    const mainState = JSON.parse(readFileSync(controlPlaneStatePath(main), "utf8"));
    expect(state?.approved_effective_fingerprint).toBe(mainState.approved_effective_fingerprint);
  });

  test("equivalent-but-not-byte-identical policy still inherits (F-007)", async () => {
    // Kills the "compare source fingerprints" mutation: the bytes differ, the EFFECTIVE
    // policy does not, and the human approved the policy — not the formatting.
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    writeFileSync(
      join(wt, "reviewgate.config.ts"),
      "// a comment the main checkout does not have\nexport default { loop: { maxIterations: 5 } };\n",
    );
    expect(await inheritedWorktreeApproval(input(wt))).not.toBeNull();
  });

  test("effective drift → does NOT inherit", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    writeFileSync(join(wt, "reviewgate.config.ts"), "export default { loop: { maxIterations: 6 } };\n");
    expect(await inheritedWorktreeApproval(input(wt))).toBeNull();
  });

  test("main checkout not armed → does NOT inherit", async () => {
    const main = await makeMainRepo(POLICY);
    const wt = await addWorktree(main);
    expect(await inheritedWorktreeApproval(input(wt))).toBeNull();
  });

  test("the main checkout itself never inherits", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    expect(await inheritedWorktreeApproval(input(main))).toBeNull();
  });

  test("worktree of a BARE parent → does NOT inherit", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktreeOfBare(main);
    expect(await inheritedWorktreeApproval(input(wt))).toBeNull();
  });

  test("unparseable worktree config → null, never a throw", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    writeFileSync(join(wt, "reviewgate.config.ts"), "this is not valid typescript {{{\n");
    expect(await inheritedWorktreeApproval(input(wt))).toBeNull();
  });

  test("a non-git directory → null, never a throw", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    expect(await inheritedWorktreeApproval(input(join(main, "nope")))).toBeNull();
  });

  test("the probe writes nothing — in the worktree or the main checkout", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const before = readFileSync(controlPlaneStatePath(main), "utf8");
    const wt = await addWorktree(main);
    await inheritedWorktreeApproval(input(wt));
    expect(existsSync(join(wt, ".reviewgate"))).toBe(false);
    expect(readFileSync(controlPlaneStatePath(main), "utf8")).toBe(before);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test tests/unit/control-plane-worktree-inheritance.test.ts`
Expected: FAIL — `inheritedWorktreeApproval` is not exported from `src/config/control-plane.ts`.

- [ ] **Step 5: Write the implementation**

Extend the existing imports in `src/config/control-plane.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { worktreeInfo } from "../utils/git.ts";
```

Then, directly after `managedHookExists` (~line 339):

```ts
// S3 worktree trust inheritance. A linked `git worktree` shares only `.git`: it has no
// .reviewgate/ and no host hooks of its own, so it is UNARMED even though a human
// already approved this repo's policy in the main checkout. This predicate answers
// "may this worktree run under that approval?" and returns the state to ADOPT, or null.
//
// It NEVER throws. Every failure — git error, missing/corrupt main state, unparseable
// worktree config — degrades to null (= not armed), because its first caller is
// probeArming, whose whole contract is a zero-writes, non-crashing answer.
//
// The comparison is over the EFFECTIVE merged config (defaults <- global <- project),
// never a hash of the committed project file (spec F-007). The global layer is
// per-machine and NOT committed, so keying on the project file alone would let an edit
// of ~/.config/reviewgate/reviewgate.config.ts silently change the policy — including
// which checks.commands shell out — in every inheriting worktree.
export async function inheritedWorktreeApproval(
  input: EffectiveConfigInput,
): Promise<ControlPlaneState | null> {
  try {
    // Cheap discriminator first: a linked worktree's `.git` is a FILE ("gitdir: …"),
    // a main checkout's is a directory. Under S4's user-scoped hooks this predicate
    // runs in every repo the user touches, so ordinary checkouts must not pay for a
    // git subprocess.
    // (`throwIfNoEntry: false` verified working under this Bun: returns undefined for a
    // missing path, and `.isFile()` is false for a main checkout's `.git` DIRECTORY.
    // Even if it were unsupported the outer catch would hold the never-throw contract.)
    if (!statSync(join(input.cwd, ".git"), { throwIfNoEntry: false })?.isFile()) return null;
    const info = await worktreeInfo(input.cwd);
    if (!info.isLinkedWorktree || !info.commonDir) return null;
    // <main>/.git -> <main>. A worktree of a BARE repo has commonDir = <…>/x.git, whose
    // basename is not ".git", so it correctly resolves to no main checkout at all.
    const common = resolve(input.cwd, info.commonDir);
    if (basename(common) !== ".git") return null;
    // readState also verifies the main state's config <-> fingerprint integrity and
    // throws when they disagree, so a tampered main state can never be inherited.
    const main = readState(dirname(common));
    if (!main) return null;
    const snapshot = await loadEffectiveConfigSnapshot(input);
    if (effectiveConfigFingerprint(snapshot.config) !== main.approved_effective_fingerprint) {
      return null;
    }
    // Built from the WORKTREE's own snapshot, never copied from the main state: source
    // bytes may legitimately differ (comments, formatting, an equivalent project layer)
    // while the effective policy — the thing the human actually approved — is identical.
    // Copying the main state's source fingerprint instead would make the very next
    // resolve see a phantom source-only policy change.
    return baseState(snapshot.config, snapshot.sourceFingerprint, "inherited-worktree");
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/unit/control-plane-worktree-inheritance.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Mutation-check the two load-bearing comparisons**

In a **copy** of the repo (`cp -r . /tmp/mut-s3-t1`, never in place):
1. Compare `snapshot.sourceFingerprint !== main.approved_source_fingerprint` instead of the effective fingerprints → the "equivalent-but-not-byte-identical" test must go RED.
2. Delete the `basename(common) !== ".git"` guard → the bare-parent test must go RED.
3. Replace the `catch { return null }` body with `throw err` → the unparseable-config test must go RED.
Discard the copy; confirm `git diff` in the real repo is unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/schemas/control-plane.ts src/config/control-plane.ts tests/helpers/worktree.ts tests/unit/control-plane-worktree-inheritance.test.ts
git commit -m "feat(control-plane): add the S3 worktree-inheritance predicate"
```

---

### Task 2: `probeArming` honours inheritance

**Files:**
- Modify: `src/config/control-plane.ts:366-373` (`probeArming`)
- Test: `tests/unit/control-plane-worktree-inheritance.test.ts` (extend)

**Interfaces:**
- Consumes: `inheritedWorktreeApproval` (Task 1), `makeMainRepo`/`addWorktree` (Task 1).
- Produces: no new exports. `probeArming` returns `{ armed: true }` for an inheriting worktree.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/control-plane-worktree-inheritance.test.ts` (add `probeArming` to the existing `control-plane` import, `managedHookPath` to the `paths` import, and `mkdirSync` to the `node:fs` import):

```ts
describe("probeArming + worktree inheritance", () => {
  test("worktree of an armed main → armed", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    expect(await probeArming(input(wt))).toEqual({ armed: true });
  });

  test("worktree with effective drift → unarmed-with-config (loud), not armed", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    writeFileSync(join(wt, "reviewgate.config.ts"), "export default { loop: { maxIterations: 6 } };\n");
    expect(await probeArming(input(wt))).toEqual({ armed: false, kind: "unarmed-with-config" });
  });

  test("a DELETED approval in a worktree is not rescued by inheritance", async () => {
    // The ordering guard: this worktree has a managed hook (init armed it here) but no
    // local state, and its config still matches the main checkout's approval. If the
    // inheritance check ran before managedHookExists, `rm control-plane.json` inside a
    // worktree would become a way to disarm the deletion block.
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    mkdirSync(dirname(managedHookPath(wt)), { recursive: true });
    writeFileSync(managedHookPath(wt), "#!/bin/sh\n");
    expect(await probeArming(input(wt))).toEqual({ armed: false, kind: "state-missing" });
  });
});
```

Add `dirname` to the `node:path` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/control-plane-worktree-inheritance.test.ts -t "probeArming + worktree"`
Expected: FAIL on the first two (today an unarmed worktree reports `unarmed-with-config`); the deletion test passes already and is a guard, not a driver.

- [ ] **Step 3: Write the implementation**

In `probeArming`, insert the branch between the managed-hook check and the config-source inspection:

```ts
export async function probeArming(input: EffectiveConfigInput): Promise<ArmingProbe> {
  if (readState(input.cwd)) return { armed: true };
  if (managedHookExists(input.cwd)) return { armed: false, kind: "state-missing" };
  // S3: a linked worktree may run under the main checkout's approval while its own
  // EFFECTIVE config still equals that approval. Deliberately AFTER the managed-hook
  // check — a worktree that init armed and whose control-plane.json was deleted must
  // keep blocking, and inheritance must never be the thing that rescues it.
  if (await inheritedWorktreeApproval(input)) return { armed: true };
  return {
    armed: false,
    kind: inspectConfigSources(input).hasProjectSource ? "unarmed-with-config" : "unarmed-bare",
  };
}
```

Also extend the doc comment above `ArmingProbe`: replace the sentence
`// S3 extends ONLY this function, with the worktree-inheritance branch.` with

```ts
// `armed: true` now has TWO sources: an approved LKG for this checkout, and (S3) a
// linked worktree whose effective config still equals the main checkout's approval.
// The second is materialized into a local LKG by resolveControlPlaneConfig — the probe
// itself still only reads.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/control-plane-worktree-inheritance.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Mutation-check the ordering**

In a **copy**: move the `inheritedWorktreeApproval` branch ABOVE the `managedHookExists` check → the "DELETED approval … not rescued" test must go RED. Discard the copy; `git diff` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/config/control-plane.ts tests/unit/control-plane-worktree-inheritance.test.ts
git commit -m "feat(control-plane): arm an inheriting worktree in probeArming (S3)"
```

---

### Task 3: `resolveControlPlaneConfig` materializes the inherited approval

**Files:**
- Modify: `src/config/control-plane.ts:379-406` (the `!approved` branch) + a new private `adoptInheritedBaseline`
- Test: `tests/unit/control-plane-worktree-inheritance.test.ts` (extend)

**Interfaces:**
- Consumes: `inheritedWorktreeApproval` (Task 1); module-private `writeState`, `clearPolicyArtifacts`, `flock`, `reviewgateDir`, `controlPlaneLockPath`.
- Produces: no new exports. `resolveControlPlaneConfig` no longer throws in an inheriting worktree and leaves a valid local `control-plane.json` behind.

**Why this task is mandatory:** without it Task 2 makes things strictly worse. `probeArming` returning `{armed:true}` only means `runGate` does not early-return; it then reaches `resolveControlPlaneConfig`, which for a committed-policy worktree finds no LKG, no managed hook and `hasProjectSource: true` → `ControlPlaneBootstrapRequiredError` → `runGateSafe` emits `decision:"block"`. That is a blocked turn where today the agent gets an allow plus a notice.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/control-plane-worktree-inheritance.test.ts` (add `resolveControlPlaneConfig` to the control-plane import):

```ts
describe("resolveControlPlaneConfig + worktree inheritance", () => {
  test("an inheriting worktree resolves instead of throwing, and materializes its LKG", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    // Today this REJECTS with ControlPlaneBootstrapRequiredError.
    const resolution = await resolveControlPlaneConfig(input(wt));
    expect(resolution.change).toBeNull();
    expect(resolution.config.loop.maxIterations).toBe(5);
    const written = JSON.parse(readFileSync(controlPlaneStatePath(wt), "utf8"));
    expect(written.approved_via).toBe("inherited-worktree");
    const mainState = JSON.parse(readFileSync(controlPlaneStatePath(main), "utf8"));
    expect(written.approved_effective_fingerprint).toBe(mainState.approved_effective_fingerprint);
  });

  test("after materialization the worktree is an ORDINARY armed checkout", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    await resolveControlPlaneConfig(input(wt));
    // A later policy edit in the worktree is a normal pending candidate needing human
    // approval — NOT a silent re-inheritance and NOT a silent disarm.
    writeFileSync(join(wt, "reviewgate.config.ts"), "export default { loop: { maxIterations: 9 } };\n");
    const second = await resolveControlPlaneConfig(input(wt));
    expect(second.change?.classification).toBe("approval-required");
    expect(second.config.loop.maxIterations).toBe(5); // still reviewed under the LKG
  });

  test("materializing never writes to the main checkout", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const before = readFileSync(controlPlaneStatePath(main), "utf8");
    const wt = await addWorktree(main);
    await resolveControlPlaneConfig(input(wt));
    expect(readFileSync(controlPlaneStatePath(main), "utf8")).toBe(before);
  });

  test("a NON-inheriting worktree still refuses to self-bless", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    writeFileSync(join(wt, "reviewgate.config.ts"), "export default { loop: { maxIterations: 6 } };\n");
    await expect(resolveControlPlaneConfig(input(wt))).rejects.toThrow(/has not been approved here/);
    expect(existsSync(controlPlaneStatePath(wt))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/control-plane-worktree-inheritance.test.ts -t "resolveControlPlaneConfig + worktree"`
Expected: FAIL — the first three reject with `ControlPlaneBootstrapRequiredError`; the fourth passes already (it is the guard that the S1 refusal survives).

- [ ] **Step 3: Write the implementation**

Add the private writer next to `bootstrapControlPlane` (it deliberately mirrors that function's mkdir → lock → re-check → write → clear shape rather than reusing it, because `bootstrapControlPlane` derives the state itself and here the state is already decided):

```ts
// S3: persist an INHERITED approval as this worktree's own last-known-good. The state
// was built from this checkout's verified snapshot, so writing it blesses exactly what
// was compared against the main checkout's approval — a config that changes in the
// meantime is not blessed, it becomes an ordinary pending candidate on the next read.
async function adoptInheritedBaseline(
  repoRoot: string,
  state: ControlPlaneState,
): Promise<ControlPlaneState> {
  mkdirSync(reviewgateDir(repoRoot), { recursive: true });
  const lock = await flock(controlPlaneLockPath(repoRoot));
  try {
    const existing = readState(repoRoot);
    if (existing) return existing; // a concurrent gate won the race; its state wins
    writeState(repoRoot, state);
    clearPolicyArtifacts(repoRoot);
    return state;
  } finally {
    await lock.release();
  }
}
```

Then rewrite the `!approved` branch of `resolveControlPlaneConfig` — keep the existing comment block above it verbatim and add the inheritance step:

```ts
    if (managedHookExists(input.cwd)) throw new ControlPlaneBootstrapRequiredError();
    // S3: a linked worktree whose EFFECTIVE config still equals the main checkout's
    // approval runs under that approval — the human approved this policy for this repo
    // once, and a worktree is local-filesystem proof of the same repo. Checked AFTER
    // the managed-hook throw (a deleted approval is never rescued) and BEFORE the
    // first-contact refusal (which is what it is a narrow, verified exception to).
    const inherited = await inheritedWorktreeApproval(input);
    if (inherited) {
      approved = await adoptInheritedBaseline(input.cwd, inherited);
    } else if (source.hasProjectSource) {
      throw new ControlPlaneBootstrapRequiredError(
        "This checkout ships a committed Reviewgate policy (reviewgate.config.ts) that has not been approved here, and no last-known-good baseline exists. Reviewgate will NOT self-approve a repo's config on first contact — a cloned repo's config could run arbitrary shell checks or exfiltrate secrets. Run `reviewgate init`, or `reviewgate config approve` from an interactive terminal, to arm this checkout.",
      );
    } else {
      // Reached only for a defaults-only OR global-only tree. Label the global-only
      // case distinctly so `control-plane.json` does not misrepresent a captured user
      // global policy as pure built-in defaults.
      approved = await bootstrapControlPlane({
        ...input,
        approvedVia: source.hasCustomSource ? "automatic-global" : "defaults",
      });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/control-plane-worktree-inheritance.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Mutation-check the first-contact refusal**

In a **copy**, make the branch bless the local config unconditionally — replace the
predicate call with a self-blessing baseline:

```ts
    const inherited = baseState(
      (await loadEffectiveConfigSnapshot(input)).config,
      source.sourceFingerprint,
      "inherited-worktree",
    );
```

The "NON-inheriting worktree still refuses to self-bless" test must go RED (that is the S1
first-contact refusal, and inheritance must be a verified exception to it, never a hole).
Discard the copy; confirm `git diff` in the real repo is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/config/control-plane.ts tests/unit/control-plane-worktree-inheritance.test.ts
git commit -m "feat(control-plane): materialize an inherited worktree approval (S3)"
```

---

### Task 4: Gate-level behavior

**Files:**
- Modify: `tests/unit/gate-arming-probe.test.ts` (extend — no source change)
- Test: same file

**Interfaces:**
- Consumes: `makeMainRepo`/`addWorktree` (Task 1), `runGate`/`runGateSafe`, `armCheckout`.
- Produces: nothing new.

**Why this task exists:** Tasks 1–3 prove the units. This proves the composition through the real entry point — including that S2's zero-writes promise still holds for a worktree that does NOT inherit. No implementation change is expected; if one turns out to be needed, that is a finding, not a step to invent silently.

- [ ] **Step 1: Write the tests**

Append to `tests/unit/gate-arming-probe.test.ts` (add the worktree helper import, `dirtyFlagPath` and `controlPlaneStatePath` to the paths import):

```ts
describe("gate + worktree trust inheritance (S3)", () => {
  const POLICY = "export default { loop: { maxIterations: 5 } };\n";

  it("trigger in an INHERITING worktree marks the diff dirty", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    const out = await runGate({
      repoRoot: wt,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(wt, "a.ts") } }),
    });
    expect(out.exitCode).toBe(0);
    expect(existsSync(dirtyFlagPath(wt))).toBe(true);
  });

  it("trigger in a DRIFTED worktree still writes nothing", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    writeFileSync(join(wt, "reviewgate.config.ts"), "export default { loop: { maxIterations: 6 } };\n");
    const out = await runGate({
      repoRoot: wt,
      hook: "trigger",
      hookStdinRaw: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(wt, "a.ts") } }),
    });
    expect(out.exitCode).toBe(0);
    expect(existsSync(reviewgateDir(wt))).toBe(false);
  });

  it("stop in a CLEAN inheriting worktree REVIEWS under the inherited approval", async () => {
    // Deliberately clean: with an empty diff, triage returns runReview:false
    // (src/triage/matrix.ts:63) and NO reviewer is spawned, so this exercises
    // probe → resolve → materialize end-to-end without a panel. Do not add
    // uncommitted changes to this case — that would spawn the real panel.
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    const out = await runGateSafe({ repoRoot: wt, hook: "stop", hookStdinRaw: "" });
    // The two DRIVERS. Today (S2, pre-S3) this worktree is unarmed, so the gate
    // early-returns with the loud NOT ARMED notice and writes nothing at all —
    // both of these are red before Task 3.
    expect(out.stderr).not.toContain("NOT ARMED");
    expect(existsSync(controlPlaneStatePath(wt))).toBe(true);
    // A GUARD, not a driver: it is already green today (S2 allows, it does not
    // block). It exists to catch the Task-2-without-Task-3 intermediate state, in
    // which probeArming arms the worktree and resolveControlPlaneConfig then
    // fail-closed blocks it — the regression this plan's Task 3 exists to prevent.
    expect(out.stdout).not.toContain('"block"');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `bun test tests/unit/gate-arming-probe.test.ts`
Expected: PASS (9 tests). If the stop case takes longer than a few seconds or a reviewer
process appears, STOP: the empty-diff assumption is wrong for this fixture — record that,
drop the stop case to a `resolveControlPlaneConfig`-level assertion, and note the reduced
coverage in the plan's findings mapping rather than leaving a slow/flaky test in `tests/unit`
(CI runs exactly that directory).

- [ ] **Step 3: Verify the S2 tests still pass unchanged**

Run: `bun test tests/unit/gate-arming-probe.test.ts tests/unit/control-plane-arming.test.ts`
Expected: PASS, with no edits to the pre-existing S2 assertions. If an S2 assertion had to
change, S3 broke a shipped guarantee — treat that as a finding, not a fix-up.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/gate-arming-probe.test.ts
git commit -m "test: gate-level coverage for worktree trust inheritance (S3)"
```

---

### Task 5: Docs

**Files:**
- Modify: `CLAUDE.md` (the "Worktrees are NOT gated by default" bullet)
- Modify: `docs/AGENTS.md` (the worktree section, ~line 298)
- Test: none (documentation)

- [ ] **Step 1: Correct the CLAUDE.md bullet**

The bullet currently ends with the S2 sentence ("S2's arming probe does not close this…"). Append, without weakening the first sentence — hooks still do not propagate:

```markdown
  **S3 adds trust inheritance, not hooks.** Where hooks DO fire in a linked worktree, it
  now runs under the main checkout's approval — but only while its own EFFECTIVE config
  (defaults ← global ← project) still equals that approval; any drift, including an edit
  of the global config, falls back to the unarmed notice. On the first such run the
  worktree materializes its own `control-plane.json` (`approved_via:"inherited-worktree"`)
  and is an ordinary armed checkout from then on. What makes hooks EXIST in a worktree is
  still `reviewgate init` inside it (or S4's user-scoped hooks, not built).
```

- [ ] **Step 2: Extend the `docs/AGENTS.md` unarmed-checkouts section**

Add after the S2 paragraphs:

```markdown
A linked `git worktree` is a special case: it inherits the main checkout's approval when
its own effective config still matches it, so no second `reviewgate config approve` is
needed there. Inheritance is refused — and the unarmed notice returned instead — when the
main checkout is not armed, when the effective config drifts, or when the worktree's
config cannot be parsed. It never makes hooks fire in the worktree; without hooks nothing
runs there at all.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/AGENTS.md
git commit -m "docs: describe worktree trust inheritance (S3)"
```

---

## Verification (end gate)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run lint` — clean
- [ ] `bun test` — 0 fail (expect ~+19 tests over the 2951 baseline)
- [ ] `bun run dev gate --hook stop </dev/null` in this repo still reviews normally (the dogfood checkout has its own LKG, so the predicate is never consulted — `.git` here is a directory and the `statSync` guard returns immediately)
- [ ] Manual, in a real worktree of THIS repo (no `init` there — that would arm it locally and prove nothing):
  ```bash
  git worktree add ../reviewgate-s3-check -b s3-check
  bun run dev gate --hook trigger </dev/null   # from inside the worktree
  cat ../reviewgate-s3-check/.reviewgate/dirty.flag
  ```
  Expected: a `dirty.flag` exists and `.reviewgate/control-plane.json` does NOT (trigger
  returns before the config load). Then remove the worktree: `git worktree remove ../reviewgate-s3-check`.
  This is the honest limit of the manual check — a manual stop run would review the whole
  worktree diff with the real panel, so it is deliberately not part of the gate.

## Self-review notes

- **Spec coverage:** the 7-step predicate → Task 1; both call sites and their ordering → Tasks 2–3; materialize-not-read-through with the pending-candidate consequence → Task 3 Step 1 (second test); the `approved_via` addition → Task 1 Step 1; the fail-safety matrix → Task 1 Step 3 (one test per row, plus the corrupt-main-state row covered by `readState`'s throw inside the `catch`); "no doctor change" → File Structure; F-007 → Task 1's equivalent-bytes test.
- **Deliberate scope call:** no `doctor` change and no S4 work. S3's user-visible payoff arrives with S4; that is stated in the spec and must not be oversold in the commits.
- **Known gap carried forward:** manual/bench paths (F-004, F9) still bypass arming entirely — out of scope per spec §6.
- **Residual risk to name for the reviewer:** the predicate reads the main checkout's state and the worktree's config at slightly different instants than the subsequent write (the same accepted TOCTOU class as S1's bootstrap). It is benign here because the state that gets written is the one that was verified; a config that changes in between simply becomes a normal pending candidate on the next resolve.

---

## Plan-Gate findings mapping — round 1 (GLM-5.2 via Ollama Cloud, 2026-07-29)

Codex was rate-limited, so the documented fallback chain was used. GLM is a pure
completion, not an agentic CLI: it cannot explore the repo and cannot write its own
findings file, so the spec §S3 excerpt, the current source of every touched function and
the whole plan were inlined, and stdout was captured to `.review/plan-gate-r1.md` — the
one documented exception to "never pipe reviewer stdout".

Verdict: **PASS** — 0 CRITICAL, 0 WARN, 3 INFO.

| # | Finding | Disposition | Task |
|---|---------|-------------|------|
| I1 | The "NON-inheriting worktree still refuses to self-bless" test writes `expect(...).rejects.toThrow(...)` without `await` — not vacuous in Bun, but poor form | **Adopted** — `await` added | Task 3 Step 1 |
| I2 | The clean-worktree stop test depends on an empty diff skipping the panel | No action — verified independently before the plan was written (`src/triage/matrix.ts:63` returns `runReview:false` for `facts.files.length === 0`), and the plan already carries a documented fallback | Task 4 Step 2 |
| I3 | `statSync`'s `throwIfNoEntry` is a newer Node option; if Bun lacked it the call would throw | No action beyond a comment — verified empirically on this machine under this Bun (`undefined` for a missing path, `.isFile() === false` for a `.git` directory), and the outer `catch` upholds the never-throw contract regardless | Task 1 Step 5 |

## Plan-Gate findings mapping — round 2, ADVERSARIAL (GLM-5.2, 2026-07-29)

Round 1 passed on the first try, which is thin evidence for a trust-boundary change from a
single completion reviewer. Round 2 was therefore not a fix round but a refutation brief:
the reviewer was told a first reviewer had already passed the plan, to assume that reviewer
was too generous, and to attack six named claims (check ordering, first-contact refusal,
never-throws/never-writes, F-007, the compare→write window, and test honesty).

Verdict: **PASS** — 0 CRITICAL, 0 WARN, 4 INFO. One INFO was a genuine catch.

| # | Finding | Disposition | Task |
|---|---------|-------------|------|
| I1 | The stop test's comment claimed "today: decision block". Wrong: today an unarmed worktree takes S2's early-return ALLOW path and never reaches `resolveControlPlaneConfig`, so `expect(stdout).not.toContain('"block"')` is **already green** and drives nothing | **Adopted** — the test now names its two real drivers (`stderr` must no longer carry `NOT ARMED`; a local `control-plane.json` must exist) and keeps the non-block assertion explicitly labelled as a guard against the Task-2-without-Task-3 intermediate state | Task 4 Step 1 |
| I2 | The never-writes claim depends on `defineConfig` having no side effects, which was not inlined | No action — verified after the review: `src/config/define-config.ts` imports only `zod`, a schema type and `./defaults.ts`; no fs/network/spawn call exists in it. It is a pure parse | Task 1 |
| I3 | A git submodule also has a `.git` FILE, so the cheap guard passes and one `git rev-parse` subprocess runs before `worktreeInfo` correctly refuses (`gitDir === commonDir`) | Accepted as designed — correctness is unaffected; the cost is one subprocess in submodule checkouts only, and narrowing the guard further would risk missing real worktrees | Task 1 Step 5 |
| I4 | `inheritedWorktreeApproval` runs twice per stop invocation (probe + resolve), each re-reading the main state and re-parsing the config | Accepted, documented — the two call sites are independent top-level entries from `gate.ts`; caching across them would mean threading probe state into the resolve path, which is exactly the plumbing "materialize" was chosen to avoid. The reviewer confirms the TOCTOU between them is benign: the second evaluation is the one that materializes, and a config that changed in between becomes an ordinary pending candidate | Task 3 |

**Plan-gate summary:** round 1 PASS (3 INFO) → round 2 adversarial PASS (4 INFO, 1 adopted).
Codex was rate-limited for both rounds; GLM-5.2 via Ollama Cloud was used per the documented
fallback chain. No CRITICAL or WARN was raised in either round. Implementation may begin.

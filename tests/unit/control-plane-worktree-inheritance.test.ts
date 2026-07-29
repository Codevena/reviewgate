import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  inheritedWorktreeApproval,
  probeArming,
  resolveControlPlaneConfig,
} from "../../src/config/control-plane.ts";
import { controlPlaneStatePath, managedHookPath } from "../../src/utils/paths.ts";
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
    writeFileSync(
      join(wt, "reviewgate.config.ts"),
      "export default { loop: { maxIterations: 6 } };\n",
    );
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

  test("a BARE parent sitting inside an armed checkout still does not inherit from it", async () => {
    // The discriminating case for the `.git` basename guard. The plain bare-parent test
    // above passes even without that guard (dirname() lands on an empty temp dir, so
    // readState finds nothing) — it is a guard, not a driver. Here dirname(commonDir) IS
    // an armed checkout, and the worktree's policy matches its approval, so dropping the
    // guard WOULD inherit. It must not: same-repo proof is the shared gitdir, never "the
    // directory that happens to contain my bare repo is armed".
    const host = await makeMainRepo(POLICY);
    await armCheckout(host);
    const unrelated = await makeMainRepo(POLICY);
    const wt = await addWorktreeOfBare(unrelated, join(host, "x.git"));
    expect(await inheritedWorktreeApproval(input(wt))).toBeNull();
  });

  test("a hand-written .git FILE pointing at an armed repo does not inherit", async () => {
    // The discriminating case for the isLinkedWorktree requirement — without it the other
    // two guards let this through. This directory has a `.git` FILE (cheap stat guard
    // passes) whose gitdir is the armed checkout's own .git (basename guard passes), and
    // its policy matches, but `git rev-parse` reports git-dir === git-common-dir: it is
    // NOT a registered linked worktree. Verified with real git: exactly the shape a
    // careless `--separate-git-dir` or a hand-written .git file produces. Inheritance is
    // justified by git's worktree link, never by "some directory points at an armed repo".
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const fake = mkdtempSync(join(tmpdir(), "rg-wt-fakelink-"));
    writeFileSync(join(fake, ".git"), `gitdir: ${join(main, ".git")}\n`);
    writeFileSync(join(fake, "reviewgate.config.ts"), POLICY);
    expect(await inheritedWorktreeApproval(input(fake))).toBeNull();
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
    writeFileSync(
      join(wt, "reviewgate.config.ts"),
      "export default { loop: { maxIterations: 6 } };\n",
    );
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

describe("resolveControlPlaneConfig + worktree inheritance", () => {
  test("an inheriting worktree resolves instead of throwing, and materializes its LKG", async () => {
    const main = await makeMainRepo(POLICY);
    await armCheckout(main);
    const wt = await addWorktree(main);
    // Before S3 this REJECTS with ControlPlaneBootstrapRequiredError.
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
    writeFileSync(
      join(wt, "reviewgate.config.ts"),
      "export default { loop: { maxIterations: 9 } };\n",
    );
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
    writeFileSync(
      join(wt, "reviewgate.config.ts"),
      "export default { loop: { maxIterations: 6 } };\n",
    );
    await expect(resolveControlPlaneConfig(input(wt))).rejects.toThrow(
      /has not been approved here/,
    );
    expect(existsSync(controlPlaneStatePath(wt))).toBe(false);
  });
});

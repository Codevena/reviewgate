// tests/unit/collaborators.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCollaboratorSources } from "../../src/research/collaborators.ts";

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-collab-"));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return repo;
}

describe("collectCollaboratorSources", () => {
  it("injects the source of a relatively-imported, UNCHANGED collaborator", async () => {
    const repo = repoWith({
      "src/card.tsx": "export function Card(){ return <div className='flex flex-col'/>; }",
      "src/Widget.tsx": "import { Card } from './card';\nexport const W = () => <Card/>;",
    });
    const out = await collectCollaboratorSources(repo, ["src/Widget.tsx"]);
    const card = out.find((c) => c.path === "src/card.tsx");
    expect(card).toBeDefined();
    expect(card?.content).toContain("flex flex-col"); // the premise reviewers need to verify
  });

  it("never includes a file that is itself in the changed set", async () => {
    const repo = repoWith({
      "src/card.tsx": "export function Card(){ return null; }",
      "src/Widget.tsx": "import { Card } from './card';\nexport const W = () => <Card/>;",
    });
    // card.tsx is ALSO changed → its full content is already provided as changed-file
    // context; don't double-inject it as a collaborator.
    const out = await collectCollaboratorSources(repo, ["src/Widget.tsx", "src/card.tsx"]);
    expect(out.map((c) => c.path)).not.toContain("src/card.tsx");
  });

  it("ignores external/builtin imports (relative first-party only)", async () => {
    const repo = repoWith({
      "src/card.tsx": "export const Card = 1;",
      "src/Widget.tsx":
        "import React from 'react';\nimport { join } from 'node:path';\nimport { Card } from './card';",
    });
    const out = await collectCollaboratorSources(repo, ["src/Widget.tsx"]);
    expect(out.map((c) => c.path)).toEqual(["src/card.tsx"]); // only the relative import
  });

  it("respects the byte budget, dropping the largest collaborators first", async () => {
    const repo = repoWith({
      "src/small.tsx": "export const A = 1;",
      "src/big.tsx": `export const B = '${"x".repeat(5000)}';`,
      "src/Widget.tsx": "import { A } from './small';\nimport { B } from './big';",
    });
    const out = await collectCollaboratorSources(repo, ["src/Widget.tsx"], { maxBytes: 1000 });
    expect(out.map((c) => c.path)).toContain("src/small.tsx");
    expect(out.map((c) => c.path)).not.toContain("src/big.tsx"); // largest dropped
  });

  it("does NOT inject a collaborator that resolves OUTSIDE the repo via a symlink (containment)", async () => {
    const repo = repoWith({
      "src/Widget.tsx": "import { secret } from './evil';\nexport const W = secret;",
    });
    // A secret file outside the repo, reachable only through an in-repo symlink.
    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"));
    writeFileSync(join(outside, "secret.tsx"), "export const secret = 'OUT_OF_REPO_SECRET';");
    symlinkSync(join(outside, "secret.tsx"), join(repo, "src/evil.tsx"));
    const out = await collectCollaboratorSources(repo, ["src/Widget.tsx"]);
    // The symlink target is outside the repo → must NOT be injected as trusted context.
    expect(out.some((c) => c.content.includes("OUT_OF_REPO_SECRET"))).toBe(false);
  });

  it("does NOT follow a final-component symlink import even to an in-repo file (O_NOFOLLOW, matches plan-refs)", async () => {
    // Closes the realpath-check → read TOCTOU: the read uses O_NOFOLLOW so a
    // final-component symlink (the swap vector) is refused at open, not followed.
    const repo = repoWith({
      "src/real.tsx": "export const real = 'REAL_VIA_SYMLINK';",
      "src/Widget.tsx": "import { real } from './link';\nexport const W = real;",
    });
    symlinkSync(join(repo, "src/real.tsx"), join(repo, "src/link.tsx"));
    const out = await collectCollaboratorSources(repo, ["src/Widget.tsx"]);
    expect(out.some((c) => c.content.includes("REAL_VIA_SYMLINK"))).toBe(false);
  });

  it("resolves an extensionless relative import to its .tsx/index file", async () => {
    const repo = repoWith({
      "src/ui/index.tsx": "export const Btn = 1;",
      "src/Widget.tsx": "import { Btn } from './ui';",
    });
    const out = await collectCollaboratorSources(repo, ["src/Widget.tsx"]);
    expect(out.map((c) => c.path)).toContain("src/ui/index.tsx");
  });
});

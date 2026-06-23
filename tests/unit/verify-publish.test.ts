import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS, pkgName } from "../../scripts/build-npm-packages.ts";
import { verifyNpmDist } from "../../scripts/verify-publish.ts";

const GRAMMARS = [
  "web-tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-python.wasm",
];

function scaffold(
  root: string,
  version: string,
  opts: { caret?: boolean; dropGrammar?: boolean; badVersion?: string; emptyBin?: boolean } = {},
) {
  // main
  mkdirSync(join(root, "main", "bin"), { recursive: true });
  writeFileSync(join(root, "main", "bin", "reviewgate.cjs"), "#!/usr/bin/env node\n");
  writeFileSync(
    join(root, "main", "package.json"),
    JSON.stringify({
      name: "reviewgate",
      version,
      bin: { reviewgate: "bin/reviewgate.cjs" },
      engines: { node: ">=20" },
      optionalDependencies: Object.fromEntries(
        TARGETS.map((t) => [pkgName(t), opts.caret ? `^${version}` : version]),
      ),
    }),
  );
  // platform packages
  for (const t of TARGETS) {
    const dir = join(root, pkgName(t));
    mkdirSync(join(dir, "grammars"), { recursive: true });
    mkdirSync(join(dir, "bin-templates"), { recursive: true });
    writeFileSync(join(dir, "reviewgate"), opts.emptyBin ? "" : "x".repeat(64));
    for (const g of GRAMMARS)
      if (!(opts.dropGrammar && g === "web-tree-sitter.wasm"))
        writeFileSync(join(dir, "grammars", g), "");
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"])
      writeFileSync(join(dir, "bin-templates", sh), "");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: pkgName(t),
        version: opts.badVersion ?? version,
        os: [t.os],
        cpu: [t.cpu],
      }),
    );
  }
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-npmdist-"));
}

// Tiny binary floor for the scaffold (real binaries are tens of MB; CI uses the 1 MB default).
const SMALL = { minBinaryBytes: 1 };

describe("verifyNpmDist", () => {
  it("passes on a well-formed npm-dist", () => {
    const root = tmp();
    scaffold(root, "1.2.3");
    expect(verifyNpmDist(root, SMALL)).toEqual({ ok: true, errors: [] });
  });

  it("fails when a platform package version drifts", () => {
    const root = tmp();
    scaffold(root, "1.2.3", { badVersion: "1.2.4" });
    const r = verifyNpmDist(root, SMALL);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("version");
  });

  it("fails when optionalDependencies use a caret range instead of an exact pin", () => {
    const root = tmp();
    scaffold(root, "1.2.3", { caret: true });
    const r = verifyNpmDist(root, SMALL);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("EXACTLY");
  });

  it("fails when a grammar is missing (dead symbol graph in the shipped binary)", () => {
    const root = tmp();
    scaffold(root, "1.2.3", { dropGrammar: true });
    const r = verifyNpmDist(root, SMALL);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("web-tree-sitter.wasm");
  });

  it("fails on an empty/too-small binary (failed cross-compile)", () => {
    const root = tmp();
    scaffold(root, "1.2.3", { emptyBin: true });
    const r = verifyNpmDist(root, SMALL);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("too small");
  });
});

// tests/unit/audit-hardening.test.ts
//
// Covers the audit-findings hardening pass:
//  - personas.ts      symlink-safe + size-capped + secret-redacted persona read
//  - conventions.ts   symlink-safe CLAUDE.md/README.md read
//  - ui-analysis.ts   symlink-safe changed-file read + corrected space-x/space-y CSS
//  - imports.ts       symlink-safe specifier read
//  - symbol-graph.ts  size-capped parse read + INNERMOST enclosing symbol

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePersonas } from "../../src/core/personas.ts";
import { loadConventions } from "../../src/research/conventions.ts";
import { specifiersFromFile } from "../../src/research/imports.ts";
import { enclosingSymbol } from "../../src/research/symbol-graph.ts";
import { analyzeUiFiles, resolveTailwindToken } from "../../src/research/ui-analysis.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("personas — symlink-safe + size-capped + secret-redacted read (F-001)", () => {
  it("a persona file that symlinks OUTSIDE the repo is refused (not the target's content)", () => {
    const repo = tmp("rg-persona-link-");
    const outside = tmp("rg-persona-secret-");
    const secretPath = join(outside, "id_rsa");
    writeFileSync(secretPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETBYTES\n");
    mkdirSync(join(repo, ".reviewgate", "personas"), { recursive: true });
    symlinkSync(secretPath, join(repo, ".reviewgate", "personas", "security.md"));

    const m = resolvePersonas(repo, ["security"]);
    // null from the safe read → falls back to the built-in reaffirmation, never the key.
    expect(m.security).not.toContain("OPENSSH PRIVATE KEY");
    expect(m.security).not.toContain("SECRETBYTES");
  });

  it("an oversize persona file is refused (returns the built-in, not the file)", () => {
    const repo = tmp("rg-persona-big-");
    mkdirSync(join(repo, ".reviewgate", "personas"), { recursive: true });
    const big = `BIGPERSONA ${"x".repeat(9000)}`; // > PERSONA_FILE_CAP (8000)
    writeFileSync(join(repo, ".reviewgate", "personas", "security.md"), big);
    const m = resolvePersonas(repo, ["security"]);
    expect(m.security).not.toContain("BIGPERSONA");
  });

  it("a contained persona file still loads, but high-entropy secrets are redacted", () => {
    const repo = tmp("rg-persona-redact-");
    mkdirSync(join(repo, ".reviewgate", "personas"), { recursive: true });
    const token = "AKIA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // long high-entropy token
    writeFileSync(
      join(repo, ".reviewgate", "personas", "security.md"),
      `Custom security persona. leaked=${token}`,
    );
    const m = resolvePersonas(repo, ["security"]);
    expect(m.security).toContain("Custom security persona");
    expect(m.security).not.toContain(token);
    expect(m.security).toContain("<REDACTED:HIGH_ENTROPY>");
  });
});

describe("conventions — symlink-safe read (F-002)", () => {
  it("a CLAUDE.md symlinked OUTSIDE the repo is not read", () => {
    const repo = tmp("rg-conv-link-");
    const outside = tmp("rg-conv-secret-");
    const secretPath = join(outside, "secret.txt");
    writeFileSync(secretPath, "TOPSECRET_CONVENTIONS_LEAK");
    symlinkSync(secretPath, join(repo, "CLAUDE.md"));

    const { summary } = loadConventions(repo);
    expect(summary).not.toContain("TOPSECRET_CONVENTIONS_LEAK");
  });

  it("a real in-repo CLAUDE.md is still summarised", () => {
    const repo = tmp("rg-conv-ok-");
    writeFileSync(join(repo, "CLAUDE.md"), "Use Bun. Run bun test.");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    const { summary } = loadConventions(repo);
    expect(summary).toContain("Use Bun");
    expect(summary).toContain("scripts: test");
  });
});

describe("ui-analysis — space-x/space-y is margin-based, NOT gap (F-003b)", () => {
  it("space-x-* resolves to margin-based between-siblings spacing, not column-gap", () => {
    const r = resolveTailwindToken("space-x-4");
    expect(r).toContain("margin-left");
    expect(r).not.toContain("column-gap");
    expect(r).toContain("1rem (16px)");
  });

  it("space-y-* resolves to margin-based between-siblings spacing, not row-gap", () => {
    const r = resolveTailwindToken("space-y-2");
    expect(r).toContain("margin-top");
    expect(r).not.toContain("row-gap");
    expect(r).toContain("0.5rem (8px)");
  });

  it("a changed UI file symlinked OUTSIDE the repo is not read (F-003a)", () => {
    const repo = tmp("rg-ui-link-");
    const outside = tmp("rg-ui-secret-");
    const secretPath = join(outside, "leak.css");
    // A resolvable CSS var so we'd SEE it in the facts block if it were read.
    writeFileSync(secretPath, ":root{--leaked-secret: 1px}");
    symlinkSync(secretPath, join(repo, "evil.css"));
    const out = analyzeUiFiles(repo, ["evil.css"]);
    expect(out).not.toContain("leaked-secret");
  });
});

describe("imports — symlink-safe specifier read (F-004a)", () => {
  it("a changed file symlinked OUTSIDE the repo yields no specifiers", async () => {
    const repo = tmp("rg-imp-link-");
    const outside = tmp("rg-imp-secret-");
    const secretPath = join(outside, "evil.ts");
    writeFileSync(secretPath, `import secret from "leaked-package";`);
    symlinkSync(secretPath, join(repo, "evil.ts"));
    const specs = await specifiersFromFile(repo, "evil.ts");
    expect(specs).not.toContain("leaked-package");
    expect(specs).toEqual([]);
  });

  it("a real in-repo file still yields its specifiers", async () => {
    const repo = tmp("rg-imp-ok-");
    writeFileSync(join(repo, "a.ts"), `import { z } from "zod";\nimport "./local";`);
    const specs = await specifiersFromFile(repo, "a.ts");
    expect(specs).toContain("zod");
  });
});

describe("symbol-graph — innermost enclosing symbol (F-005b)", () => {
  it("returns the INNERMOST (smallest-span) symbol for a line inside a nested function", async () => {
    const repo = tmp("rg-symgraph-nested-");
    // outer() spans the whole file; inner() is nested inside it. Line 3 is inside
    // BOTH spans — the innermost (inner) must win.
    const src = [
      "function outer() {", // 1
      "  function inner() {", // 2
      "    return 42;", // 3  <- query this line
      "  }", // 4
      "  return inner();", // 5
      "}", // 6
    ].join("\n");
    writeFileSync(join(repo, "nested.ts"), src);
    const sym = await enclosingSymbol(join(repo, "nested.ts"), 3, repo);
    expect(sym?.name).toBe("inner");
  });

  it("a source file symlinked OUTSIDE the repo is refused before parse (F-005a)", async () => {
    const repo = tmp("rg-symgraph-link-");
    const outside = tmp("rg-symgraph-secret-");
    const secretPath = join(outside, "secret.ts");
    writeFileSync(secretPath, "function leaked() { return 1; }");
    symlinkSync(secretPath, join(repo, "evil.ts"));
    const sym = await enclosingSymbol(join(repo, "evil.ts"), 1, repo);
    expect(sym).toBeNull();
  });
});

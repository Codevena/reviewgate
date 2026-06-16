import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImportedLibs, importBindings, specToPackage } from "../../src/research/imports.ts";

describe("extractImportedLibs", () => {
  it("extracts external libs, drops relative + builtin, resolves version from package.json", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { next: "15.1.8", zod: "^3.25.0" } }),
    );
    writeFileSync(
      join(repo, "a.ts"),
      `import { z } from "zod";\nimport NextApp from "next";\nimport { local } from "./util";\nimport { readFile } from "node:fs";\nconst x = require("zod");`,
    );
    const libs = await extractImportedLibs(repo, ["a.ts"]);
    const names = libs.map((l) => l.name).sort();
    expect(names).toEqual(["next", "zod"]); // ./util + node:fs dropped, zod deduped
    expect(libs.find((l) => l.name === "next")?.version).toBe("15.1.8");
    expect(libs.find((l) => l.name === "zod")?.version).toBe("3.25.0"); // ^ stripped
  });

  it("returns [] for changed files with no external imports", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp2-"));
    writeFileSync(join(repo, "package.json"), "{}");
    writeFileSync(join(repo, "b.ts"), `import { local } from "./local";\nexport const x = 1;`);
    expect(await extractImportedLibs(repo, ["b.ts"])).toEqual([]);
  });

  it("handles import type, namespace, dynamic import, scoped + deep imports", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp3-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        dependencies: { "@scope/pkg": "2.0.0", next: "15.1.8" },
        devDependencies: { typescript: "5.5.0" },
      }),
    );
    writeFileSync(
      join(repo, "c.ts"),
      [
        `import type { T } from "@scope/pkg";`,
        `import * as ns from "next/router";`, // deep import → "next"
        `const m = await import("typescript");`,
        `import "@scope/pkg/styles.css";`, // dup of @scope/pkg
      ].join("\n"),
    );
    const libs = await extractImportedLibs(repo, ["c.ts"]);
    const names = libs.map((l) => l.name).sort();
    expect(names).toEqual(["@scope/pkg", "next", "typescript"]);
    expect(libs.find((l) => l.name === "@scope/pkg")?.version).toBe("2.0.0");
    expect(libs.find((l) => l.name === "next")?.fromFiles).toEqual(["c.ts"]);
  });

  it("returns version null for an imported package not declared anywhere", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp4-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(repo, "d.ts"), `import x from "left-pad";`);
    const libs = await extractImportedLibs(repo, ["d.ts"]);
    expect(libs).toHaveLength(1);
    expect(libs[0]?.name).toBe("left-pad");
    expect(libs[0]?.version).toBeNull();
  });

  it("prefers the exact pinned version from bun.lock over the package.json range", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp5-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { zod: "^3.0.0" } }));
    // bun.lock is JSONC (trailing commas). packages[name][0] = "name@version".
    writeFileSync(
      join(repo, "bun.lock"),
      `{\n  "lockfileVersion": 1,\n  "packages": {\n    "zod": ["zod@3.25.76", "", {}, "sha512-x"],\n  },\n}`,
    );
    writeFileSync(join(repo, "e.ts"), `import { z } from "zod";`);
    const libs = await extractImportedLibs(repo, ["e.ts"]);
    expect(libs[0]?.version).toBe("3.25.76");
  });

  it("excludes '@/'-style tsconfig path aliases but keeps real scoped packages", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp6-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { "@prisma/client": "6.0.0", zod: "4.0.0" } }),
    );
    writeFileSync(
      join(repo, "f.ts"),
      [
        `import { prisma } from "@/lib/prisma";`, // path alias (empty scope) → MUST be dropped
        `import { Button } from "@/components/ui/button";`, // path alias → dropped
        `import { PrismaClient } from "@prisma/client";`, // real scoped pkg → kept
        `import { z } from "zod";`, // real pkg → kept
      ].join("\n"),
    );
    const names = (await extractImportedLibs(repo, ["f.ts"])).map((l) => l.name).sort();
    expect(names).toEqual(["@prisma/client", "zod"]);
  });

  it("excludes ALL tsconfig compilerOptions.paths aliases (e.g. '~/'), keeps real pkgs", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp7-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );
    // tsconfig as JSONC (comments + trailing comma) to prove tolerant parsing.
    writeFileSync(
      join(repo, "tsconfig.json"),
      [
        "{",
        "  // editor: project config",
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "~/*": ["./src/*"],',
        '      "@app/*": ["./app/*"],',
        '      "#config": ["./config.ts"],', // exact (no glob)
        "    },",
        "  } /* end */",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "g.ts"),
      [
        `import { a } from "~/utils";`, // alias → dropped
        `import { b } from "@app/x";`, // alias → dropped (would otherwise look scoped)
        `import c from "#config";`, // exact alias → dropped
        `import React from "react";`, // real pkg → kept
      ].join("\n"),
    );
    const names = (await extractImportedLibs(repo, ["g.ts"])).map((l) => l.name).sort();
    expect(names).toEqual(["react"]);
  });

  it("ignores a catch-all '*' paths key (must NOT exclude every real package)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp8-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "*": ["./src/*"] } } }),
    );
    writeFileSync(join(repo, "h.ts"), `import React from "react";`);
    const names = (await extractImportedLibs(repo, ["h.ts"])).map((l) => l.name);
    expect(names).toEqual(["react"]); // "*" prefix skipped → react still extracted
  });

  it("handles a mid-pattern '*' alias (foo/*/bar), keeps real pkgs", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-imp9-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "foo/*/bar": ["./x/*/bar"] } } }),
    );
    writeFileSync(
      join(repo, "i.ts"),
      [`import { a } from "foo/anything/bar";`, `import React from "react";`].join("\n"),
    );
    const names = (await extractImportedLibs(repo, ["i.ts"])).map((l) => l.name);
    expect(names).toEqual(["react"]); // "foo/anything/bar" matched the prefix+suffix matcher
  });
});

it("specToPackage normalizes bare, subpath, and scoped specifiers", () => {
  expect(specToPackage("zod")).toBe("zod");
  expect(specToPackage("zod/v4")).toBe("zod");
  expect(specToPackage("@scope/x")).toBe("@scope/x");
  expect(specToPackage("@scope/x/sub")).toBe("@scope/x");
  expect(specToPackage("./local")).toBeNull();
});

it("importBindings maps default/namespace/named (+ alias) to package; skips relative/builtin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-ib-"));
  const f = join(dir, "a.ts");
  writeFileSync(
    f,
    [
      'import { z } from "zod";',
      'import * as React from "react";',
      'import def from "lodash";',
      'import { foo as bar } from "@scope/pkg";',
      'import { rel } from "./local";',
      'import { readFile } from "node:fs";',
    ].join("\n"),
  );
  const m = await importBindings(dir, f);
  expect(m.get("z")).toBe("zod");
  expect(m.get("React")).toBe("react");
  expect(m.get("def")).toBe("lodash");
  expect(m.get("bar")).toBe("@scope/pkg");
  expect(m.has("rel")).toBe(false);
  expect(m.has("readFile")).toBe(false);
});

it("importBindings returns an empty map for a non-JS/TS file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-ib2-"));
  const f = join(dir, "a.py");
  writeFileSync(f, "import os\n");
  expect((await importBindings(dir, f)).size).toBe(0);
});

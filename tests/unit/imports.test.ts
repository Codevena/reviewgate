import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImportedLibs } from "../../src/research/imports.ts";

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
});

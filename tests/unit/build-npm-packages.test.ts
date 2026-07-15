// tests/unit/build-npm-packages.test.ts
import { describe, expect, it } from "bun:test";
import {
  TARGETS,
  mainManifest,
  pkgName,
  platformManifest,
} from "../../scripts/build-npm-packages.ts";

describe("npm package manifests", () => {
  it("covers exactly the four supported targets", () => {
    expect(TARGETS.map(pkgName).sort()).toEqual(
      [
        "@codevena/reviewgate-darwin-arm64",
        "@codevena/reviewgate-darwin-x64",
        "@codevena/reviewgate-linux-arm64",
        "@codevena/reviewgate-linux-x64",
      ].sort(),
    );
  });

  it("platformManifest sets os/cpu and (linux only) libc:[glibc]", () => {
    const darwin = platformManifest(
      { bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
      "1.2.3",
    );
    expect(darwin.name).toBe("@codevena/reviewgate-darwin-arm64");
    expect(darwin.version).toBe("1.2.3");
    expect(darwin.os).toEqual(["darwin"]);
    expect(darwin.cpu).toEqual(["arm64"]);
    expect(darwin.libc).toBeUndefined();
    expect(darwin.files).toEqual(["reviewgate", "grammars", "bin-templates"]);

    const linux = platformManifest(
      { bunTarget: "bun-linux-x64", os: "linux", cpu: "x64" },
      "1.2.3",
    );
    expect(linux.libc).toEqual(["glibc"]);
    expect(darwin.homepage).toBe("https://reviewgate.codevena.dev/");
  });

  it("mainManifest pins each platform pkg EXACTLY, declares no runtime deps, no os/cpu", () => {
    const m = mainManifest("1.2.3") as {
      name: string;
      bin: Record<string, string>;
      optionalDependencies: Record<string, string>;
      dependencies?: Record<string, string>;
      os?: unknown;
      cpu?: unknown;
      engines: Record<string, string>;
      description: string;
      homepage: string;
    };
    expect(m.name).toBe("reviewgate");
    expect(m.bin).toEqual({ reviewgate: "bin/reviewgate.cjs" });
    for (const t of TARGETS) {
      expect(m.optionalDependencies[pkgName(t)]).toBe("1.2.3"); // exact, not ^1.2.3
    }
    expect(m.dependencies).toBeUndefined();
    expect(m.os).toBeUndefined();
    expect(m.cpu).toBeUndefined();
    expect(m.engines.node).toBe(">=20");
    expect(m.homepage).toBe("https://reviewgate.codevena.dev/");
    expect(m.description).toContain("Claude Code and Codex");
  });
});

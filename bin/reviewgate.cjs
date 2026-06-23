#!/usr/bin/env node
"use strict";
// Reviewgate npm launcher. Resolves the prebuilt platform package and execs its
// self-contained binary, forwarding argv + stdio. Pure CJS, zero dependencies.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PKG = `@codevena/reviewgate-${process.platform}-${process.arch}`;

let pkgRoot;
try {
  // Resolve the package.json (always present) and take its directory; avoids any
  // dependence on an `exports` map for the binary subpath.
  pkgRoot = path.dirname(require.resolve(`${PKG}/package.json`));
} catch {
  process.stderr.write(
    `reviewgate: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64 (glibc).\n` +
      `If you installed with --no-optional or --ignore-scripts, reinstall without them.\n` +
      `Or install from a GitHub release: https://github.com/Codevena/reviewgate#install\n`,
  );
  process.exit(1);
}

const bin = path.join(pkgRoot, "reviewgate");
const res = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (res.error) {
  process.stderr.write(`reviewgate: failed to run the platform binary (${bin}): ${res.error.message}\n`);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);

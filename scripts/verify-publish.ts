// scripts/verify-publish.ts
//
// prepublishOnly guard: `npm publish` ships the paths in package.json `files`
// ["dist", "bin-templates", "src/personas"], but `dist/` is gitignored and only
// exists after `bun run build`. Without this guard a publish from a clean checkout
// would ship an EMPTY dist + a dangling `bin` — a broken package. This verifies the
// compiled binary, the tree-sitter grammars (else the symbol graph is dead in the
// shipped binary), and the hook templates (else `reviewgate init` throws) are all
// present before the tarball is built. NOTE: this does NOT make the binary
// cross-platform/self-contained — that is a separate, larger follow-up.
import { existsSync } from "node:fs";
import { join } from "node:path";

export function verifyDist(root: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const must = (rel: string) => {
    if (!existsSync(join(root, rel))) missing.push(rel);
  };
  must("dist/reviewgate");
  must("dist/grammars/web-tree-sitter.wasm");
  for (const sh of ["gate.sh", "trigger.sh", "reset.sh"]) must(`dist/bin-templates/${sh}`);
  return { ok: missing.length === 0, missing };
}

if (import.meta.main) {
  const { ok, missing } = verifyDist(process.cwd());
  if (!ok) {
    console.error(
      `prepublishOnly: dist is incomplete — refusing to publish. Missing: ${missing.join(", ")}. Run \`bun run build\` first.`,
    );
    process.exit(1);
  }
  console.error("prepublishOnly: dist verified (binary + grammars + hook templates present).");
}

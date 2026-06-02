// tests/unit/persona-files-footer.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The reaffirmation slot is about reviewer STANCE / what-to-look-for, NOT output
// format — REVIEW_PROMPT_PREAMBLE owns the {verdict, findings, memory_proposals}
// contract. A persona file restating "Output ONLY a JSON object…" conflicts with
// it and can suppress memory_proposals. Guard that the shipped files don't.
describe("shipped persona files", () => {
  for (const id of ["security", "plan"]) {
    it(`${id}.md does not restate the output-format contract`, () => {
      const p = join(process.cwd(), ".reviewgate", "personas", `${id}.md`);
      if (!existsSync(p)) return; // file is optional
      expect(readFileSync(p, "utf8")).not.toContain("Output ONLY a JSON object");
    });
  }
});

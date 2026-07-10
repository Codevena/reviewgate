import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLore, parseLoreFile } from "../../src/core/lore/store.ts";

const VALID = `---
schema: reviewgate.lore.v1
id: payment-invariants
status: canon
anchors:
  - "src/lib/pay.ts"
  - "src/app/api/webhooks/**"
verified_at: 2026-07-09
verified_tree: "abc123"
---
Every subscription write is a CAS against (status, lastStripeEventAt).
Why: Stripe delivers out of order.`;

// Complete, VALID frontmatter (all required fields) followed by a genuinely short
// body (< LORE_MIN_BODY_CHARS chars after trim) — this is the case that must
// exercise the body-length guard in store.ts, not the frontmatter parser.
const VALID_SHORT_BODY = `---
schema: reviewgate.lore.v1
id: payment-invariants
status: canon
anchors:
  - "src/lib/pay.ts"
verified_at: 2026-07-09
verified_tree: "abc123"
---
short.`;

// Same as VALID but with an empty inline-array `tags: []` — this is the exact
// form the spec's Data model example uses (docs/superpowers/specs/2026-07-09-lore-design.md).
const VALID_WITH_EMPTY_TAGS = `---
schema: reviewgate.lore.v1
id: payment-invariants
status: canon
anchors:
  - "src/lib/pay.ts"
verified_at: 2026-07-09
verified_tree: "abc123"
tags: []
---
Every subscription write is a CAS against (status, lastStripeEventAt).
Why: Stripe delivers out of order.`;

// Same as VALID but with a populated inline-array `tags: [...]`.
const VALID_WITH_TAGS = `---
schema: reviewgate.lore.v1
id: payment-invariants
status: canon
anchors:
  - "src/lib/pay.ts"
verified_at: 2026-07-09
verified_tree: "abc123"
tags: ["release", "billing"]
---
Every subscription write is a CAS against (status, lastStripeEventAt).
Why: Stripe delivers out of order.`;

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-lore-store-"));
  mkdirSync(join(repo, ".reviewgate", "lore"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, ".reviewgate", "lore", name), content);
  }
  return repo;
}

describe("parseLoreFile", () => {
  it("parses a valid entry (frontmatter + body)", () => {
    const r = parseLoreFile(VALID, "payment-invariants");
    if ("error" in r) throw new Error(r.error);
    expect(r.entry.id).toBe("payment-invariants");
    expect(r.entry.status).toBe("canon");
    expect(r.entry.anchors).toEqual(["src/lib/pay.ts", "src/app/api/webhooks/**"]);
    expect(r.entry.body).toContain("CAS against");
  });

  it("rejects id/slug mismatch, missing frontmatter, and unknown status", () => {
    expect("error" in parseLoreFile(VALID, "other-slug")).toBe(true);
    expect("error" in parseLoreFile("no frontmatter at all", "x")).toBe(true);
    expect(
      "error" in
        parseLoreFile(VALID.replace("status: canon", "status: gold"), "payment-invariants"),
    ).toBe(true);
  });

  it("rejects a body shorter than LORE_MIN_BODY_CHARS even with complete, valid frontmatter", () => {
    // VALID_SHORT_BODY has a well-formed, complete frontmatter block (closing `---`
    // present, all required fields), so it passes the frontmatter-parse stage and
    // must be rejected specifically by the body-length guard.
    const r = parseLoreFile(VALID_SHORT_BODY, "payment-invariants");
    expect("error" in r).toBe(true);
  });

  it("parses an inline empty array `tags: []` (the spec's Data model example)", () => {
    const r = parseLoreFile(VALID_WITH_EMPTY_TAGS, "payment-invariants");
    if ("error" in r) throw new Error(r.error);
    expect(r.entry.tags).toEqual([]);
  });

  it('parses a populated inline array `tags: ["release", "billing"]`', () => {
    const r = parseLoreFile(VALID_WITH_TAGS, "payment-invariants");
    if ("error" in r) throw new Error(r.error);
    expect(r.entry.tags).toEqual(["release", "billing"]);
  });
});

describe("loadLore", () => {
  it("returns valid entries and collects invalid ones without throwing", () => {
    const repo = repoWith({
      "payment-invariants.md": VALID,
      "broken.md":
        "---\nschema: reviewgate.lore.v1\nid: broken\n---\ntoo few fields but long enough body text here",
    });
    const { entries, invalid } = loadLore(repo);
    expect(entries.map((e) => e.id)).toEqual(["payment-invariants"]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.file).toContain("broken.md");
  });

  it("returns empty on a repo without a lore dir (no throw)", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-none-"));
    expect(loadLore(repo)).toEqual({ entries: [], invalid: [] });
  });
});

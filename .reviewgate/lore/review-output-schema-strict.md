---
schema: reviewgate.lore.v1
id: review-output-schema-strict
status: draft
anchors:
  - "src/providers/review-output.ts"
verified_at: 2026-07-10
verified_tree: "3d6c09350b1a2dcede15eb0917e011310c0c327b409895dc00c469491a1a5068"
tags: []
---
Why REVIEW_OUTPUT_SCHEMA is shaped the way it is: codex's `--output-schema` runs
in OpenAI strict mode, which rejects (HTTP 400) any object node that omits
`additionalProperties:false` or leaves a property out of `required`. So every
field must be listed in `required` and optionality expressed as a nullable type
(`["string","null"]`), never by leaving the key out.

The trap: stub-based tests never call the real codex API, so a schema that
violates strict mode passes every unit test yet makes 100% of live codex reviews
fail with a 400. That is why there is a structural guard test and why schema
edits must be validated against a real `codex exec`, not just the stubs.

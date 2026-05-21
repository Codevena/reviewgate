import { describe, expect, it } from "bun:test";
import { REVIEW_OUTPUT_SCHEMA } from "../../src/providers/review-output.ts";

// OpenAI/codex strict structured-output mode requires that EVERY object node
// (a) sets additionalProperties:false and (b) lists EVERY property key in its
// `required` array. Optional fields must be expressed via a nullable type
// (`["string","null"]`), NOT by omission from `required`. Violating this yields
// an HTTP 400 invalid_json_schema from the real codex/OpenAI endpoint. This walk
// asserts both rules so a future schema edit can never silently reintroduce the
// 400 (which stub-based tests do not catch).
type SchemaNode = {
  type?: string | readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  items?: SchemaNode;
};

function hasType(node: SchemaNode, t: string): boolean {
  return node.type === t || (Array.isArray(node.type) && node.type.includes(t));
}

function walk(node: SchemaNode | undefined, path: string, problems: string[]): void {
  if (!node || typeof node !== "object") return;
  if (hasType(node, "object")) {
    if (node.additionalProperties !== false) {
      problems.push(`${path}: additionalProperties must be false`);
    }
    const props = node.properties ? Object.keys(node.properties) : [];
    const required = Array.isArray(node.required) ? node.required : [];
    for (const k of props) {
      if (!required.includes(k)) problems.push(`${path}: '${k}' missing from required`);
    }
    for (const k of props) walk(node.properties?.[k], `${path}.${k}`, problems);
  }
  if (hasType(node, "array")) {
    walk(node.items, `${path}[]`, problems);
  }
}

describe("REVIEW_OUTPUT_SCHEMA strict compliance", () => {
  it("every object lists all property keys in required and forbids extra props", () => {
    const problems: string[] = [];
    walk(REVIEW_OUTPUT_SCHEMA as unknown as SchemaNode, "$", problems);
    expect(problems).toEqual([]);
  });
});

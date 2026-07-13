import { readFileSync } from "node:fs";

// Reviewgate configuration is DATA, even though the historical filename ends in
// `.ts`. Executing that file with import() made the gate's control plane arbitrary
// code: a config could mutate the repository, read secrets, open the network, or
// synchronously wedge the Stop hook before its Promise timeout could fire. Keep the
// ergonomic `export default { ... }` syntax, but parse only literals.
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CONFIG_DEPTH = 64;

export class ConfigSourceError extends Error {
  constructor(
    message: string,
    readonly sourceName: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${sourceName}:${line}:${column}: ${message}`);
    this.name = "ConfigSourceError";
  }
}

class LiteralParser {
  private offset = 0;

  constructor(
    private readonly source: string,
    private readonly sourceName: string,
  ) {}

  parse(): unknown {
    this.skipTrivia();
    this.expectWord("export");
    this.skipTrivia();
    this.expectWord("default");
    this.skipTrivia();
    const value = this.parseValue(0);
    this.skipTrivia();
    if (this.peek() === ";") {
      this.offset++;
      this.skipTrivia();
    }
    if (!this.eof()) this.fail("unexpected content after the default-export literal");
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_CONFIG_DEPTH) this.fail(`config nesting exceeds ${MAX_CONFIG_DEPTH} levels`);
    this.skipTrivia();
    const ch = this.peek();
    if (ch === "{") return this.parseObject(depth + 1);
    if (ch === "[") return this.parseArray(depth + 1);
    if (ch === '"' || ch === "'") return this.parseString();
    if (ch === "-" || (ch !== undefined && /[0-9]/.test(ch))) return this.parseNumber();
    const ident = this.readIdentifier();
    if (ident === "true") return true;
    if (ident === "false") return false;
    if (ident === "null") return null;
    if (ident) {
      this.fail(
        `executable expression or unsupported value \`${ident}\`; only objects, arrays, strings, finite numbers, booleans and null are allowed`,
      );
    }
    this.fail("expected a data literal");
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.expect("{");
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipTrivia();
    while (this.peek() !== "}") {
      if (this.eof()) this.fail("unterminated object literal");
      const key =
        this.peek() === '"' || this.peek() === "'" ? this.parseString() : this.readIdentifier();
      if (typeof key !== "string" || key.length === 0) this.fail("expected an object key");
      if (seen.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`);
      seen.add(key);
      this.skipTrivia();
      this.expect(":");
      const value = this.parseValue(depth);
      // defineProperty keeps a literal `__proto__` key inert instead of mutating
      // the parser result's prototype before zod validation.
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipTrivia();
      if (this.peek() === ",") {
        this.offset++;
        this.skipTrivia();
        if (this.peek() === "}") break; // trailing comma
        continue;
      }
      if (this.peek() !== "}") this.fail("expected ',' or '}' in object literal");
    }
    this.expect("}");
    return out;
  }

  private parseArray(depth: number): unknown[] {
    this.expect("[");
    const out: unknown[] = [];
    this.skipTrivia();
    while (this.peek() !== "]") {
      if (this.eof()) this.fail("unterminated array literal");
      out.push(this.parseValue(depth));
      this.skipTrivia();
      if (this.peek() === ",") {
        this.offset++;
        this.skipTrivia();
        if (this.peek() === "]") break; // trailing comma
        continue;
      }
      if (this.peek() !== "]") this.fail("expected ',' or ']' in array literal");
    }
    this.expect("]");
    return out;
  }

  private parseString(): string {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") this.fail("expected a quoted string");
    this.offset++;
    let out = "";
    while (!this.eof()) {
      const ch = this.source[this.offset++];
      if (ch === quote) return out;
      if (ch === "\n" || ch === "\r") this.fail("unescaped newline in string literal");
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      if (this.eof()) this.fail("unterminated string escape");
      const esc = this.source[this.offset++];
      const simple: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
        "\\": "\\",
        '"': '"',
        "'": "'",
      };
      if (esc !== undefined && esc in simple) {
        out += simple[esc];
        continue;
      }
      if (esc === "x") {
        out += String.fromCodePoint(Number.parseInt(this.takeHex(2), 16));
        continue;
      }
      if (esc === "u") {
        if (this.peek() === "{") {
          this.offset++;
          const start = this.offset;
          while (!this.eof() && this.peek() !== "}") this.offset++;
          if (this.eof()) this.fail("unterminated unicode escape");
          const hex = this.source.slice(start, this.offset);
          this.offset++;
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) this.fail("invalid unicode escape");
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff) this.fail("unicode code point is out of range");
          out += String.fromCodePoint(cp);
        } else {
          out += String.fromCodePoint(Number.parseInt(this.takeHex(4), 16));
        }
        continue;
      }
      if (esc === "\n") continue; // JavaScript line continuation
      if (esc === "\r") {
        if (this.peek() === "\n") this.offset++;
        continue;
      }
      this.fail(`unsupported string escape \\${esc ?? ""}`);
    }
    this.fail("unterminated string literal");
  }

  private parseNumber(): number {
    const rest = this.source.slice(this.offset);
    const match = rest.match(
      /^-?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:0|[1-9][0-9]*(?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/,
    );
    if (!match?.[0]) this.fail("invalid numeric literal");
    this.offset += match[0].length;
    const value = Number(match[0].replaceAll("_", ""));
    if (!Number.isFinite(value)) this.fail("numbers must be finite");
    return value;
  }

  private takeHex(length: number): string {
    const value = this.source.slice(this.offset, this.offset + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) this.fail("invalid hex escape");
    this.offset += length;
    return value;
  }

  private skipTrivia(): void {
    while (!this.eof()) {
      if (/\s/.test(this.peek() ?? "")) {
        this.offset++;
        continue;
      }
      if (this.source.startsWith("//", this.offset)) {
        this.offset += 2;
        while (!this.eof() && this.peek() !== "\n") this.offset++;
        continue;
      }
      if (this.source.startsWith("/*", this.offset)) {
        const end = this.source.indexOf("*/", this.offset + 2);
        if (end === -1) this.fail("unterminated block comment");
        this.offset = end + 2;
        continue;
      }
      break;
    }
  }

  private readIdentifier(): string {
    this.skipTrivia();
    const start = this.offset;
    const first = this.peek();
    if (first === undefined || !/[A-Za-z_$]/.test(first)) return "";
    this.offset++;
    while (!this.eof() && /[A-Za-z0-9_$]/.test(this.peek() ?? "")) this.offset++;
    return this.source.slice(start, this.offset);
  }

  private expectWord(word: string): void {
    const got = this.readIdentifier();
    if (got !== word) this.fail(`expected \`${word}\``);
  }

  private expect(ch: string): void {
    this.skipTrivia();
    if (this.peek() !== ch) this.fail(`expected '${ch}'`);
    this.offset++;
  }

  private peek(): string | undefined {
    return this.source[this.offset];
  }

  private eof(): boolean {
    return this.offset >= this.source.length;
  }

  private fail(message: string): never {
    const before = this.source.slice(0, this.offset);
    const line = before.split("\n").length;
    const lastNl = before.lastIndexOf("\n");
    const column = this.offset - lastNl;
    throw new ConfigSourceError(message, this.sourceName, line, column);
  }
}

export function parseConfigSource(source: string, sourceName = "reviewgate.config.ts"): unknown {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_CONFIG_BYTES) {
    throw new ConfigSourceError(
      `config exceeds the ${MAX_CONFIG_BYTES}-byte limit`,
      sourceName,
      1,
      1,
    );
  }
  const normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return new LiteralParser(normalized, sourceName).parse();
}

// Historical API name retained for callers. This no longer imports or executes
// the module; it reads and data-parses a bounded literal document.
export async function importConfigDefault(
  absPath: string,
  _opts?: { timeoutMs?: number },
): Promise<unknown> {
  return parseConfigSource(readFileSync(absPath, "utf8"), absPath);
}

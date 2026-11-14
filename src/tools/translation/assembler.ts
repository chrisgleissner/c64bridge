/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { rangeOverlapsIo } from "../../ioRange.js";
import { OPCODE_INVENTORY } from "./opcodeInventory.js";
import type { OpcodeAddressingMode } from "./opcodeInventory.js";

export interface AssembleOptions {
  /**
   * Optional default load address used when no ORG or `* =` directive appears.
   * Defaults to $0801 (the conventional BASIC-adjacent origin for standalone
   * machine code). Code assembled at $0801 without an org directive gets a
   * `10 SYS` BASIC stub to its first instruction; callers find the entry with {@link prgEntryAddress}
   * and run it via a typed `SYS <entry>`, not `RUN`. The stub is added only when an instruction
   * is assembled at the load address before any org; data-only source, or data at $0801 followed
   * by code at an explicit origin, has no entry point there and is emitted without a stub.
   */
  loadAddress?: number;
  /**
   * The logical filename used for diagnostics. Defaults to "(input)".
   */
  fileName?: string;
  /**
   * Resolver invoked when an `include` directive is encountered. The returned
   * string is assembled in-place. Returning an object allows the resolver to
   * provide a new logical filename for diagnostics.
   */
  resolveInclude?: (
    requestedPath: string,
    fromFile: string,
  ) => string | { contents: string; fileName?: string };
}

export class AssemblyError extends Error {
  constructor(message: string, readonly location: SourceLocation) {
    super(`${location.file}:${location.line}: ${message}`);
  }
}

type Token =
  // binaryValue is set when the digits directly follow "%", so the parser can
  // read "%1010" as a binary literal in operand position and as modulo elsewhere.
  | { kind: "number"; value: number; binaryValue?: number }
  | { kind: "string"; value: string }
  | { kind: "symbol"; value: string }
  | { kind: "punct"; value: string };

interface SourceLocation {
  file: string;
  line: number;
  text: string;
}

interface ParsedLine {
  labels: string[];
  statement?: Statement;
  location: SourceLocation;
}

type Statement = InstructionStatement | DirectiveStatement | AssignmentStatement;

interface InstructionStatement {
  kind: "instruction";
  mnemonic: string;
  operand: Operand;
  resolvedMode?: AddressingMode;
}

interface DirectiveStatement {
  kind: "directive";
  name: DirectiveName;
  args: DirectiveArg[];
}

interface AssignmentStatement {
  kind: "assignment";
  target: string;
  expr: Expression;
  isLocationCounter: boolean;
}

type DirectiveName = "org" | "byte" | "word" | "text" | "fill" | "align" | "equ" | "reserve" | "include";

type DirectiveArg =
  | { kind: "expr"; expr: Expression }
  | { kind: "string"; value: string };

type Operand =
  | { kind: "none" }
  | { kind: "immediate"; expr: Expression }
  | { kind: "expression"; expr: Expression; register?: "X" | "Y" | "S" }
  | { kind: "indirect"; expr: Expression; register?: "X" | "Y" }
  | { kind: "accumulator" };

type Expression =
  | { type: "number"; value: number }
  | { type: "symbol"; name: string }
  | { type: "unary"; op: UnaryOperator; operand: Expression }
  | { type: "binary"; op: BinaryOperator; left: Expression; right: Expression };

// "<" and ">" select the low and high byte of their operand.
type UnaryOperator = "-" | "+" | "!" | "~" | "<" | ">";
type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<<"
  | ">>"
  | "&"
  | "|"
  | "^"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">=";

enum AddressingMode {
  Implied = "implied",
  Accumulator = "accumulator",
  Immediate = "immediate",
  ZeroPage = "zeroPage",
  ZeroPageX = "zeroPageX",
  ZeroPageY = "zeroPageY",
  ZeroPageS = "zeroPageS",
  Absolute = "absolute",
  AbsoluteX = "absoluteX",
  AbsoluteY = "absoluteY",
  Indirect = "indirect",
  IndirectX = "indirectX",
  IndirectY = "indirectY",
  Relative = "relative",
}

const DEFAULT_LOAD_ADDRESS = 0x0801;
const BASIC_START = 0x0801;
// "10 SYS0nnnn": link $080C, line 10, SYS token, five digits, end of line, end
// of program. The digits are the first instruction's address; a fixed width
// keeps the stub, and so every address after it, the same in both passes.
function basicSysStub(target: number): number[] {
  const digits = String(target & 0xffff).padStart(5, "0");
  return [0x0c, 0x08, 0x0a, 0x00, 0x9e, ...[...digits].map((digit) => digit.charCodeAt(0)), 0x00, 0x00, 0x00];
}

/**
 * Address to SYS to start a PRG: the target of a leading "SYS <n>" BASIC line
 * when the PRG loads at $0801, otherwise the load address.
 */
export function prgEntryAddress(prg: Uint8Array): number {
  const loadAddress = (prg[0] ?? 0) | ((prg[1] ?? 0) << 8);
  if (loadAddress !== BASIC_START || prg.length < 8) {
    return loadAddress;
  }
  // Skip the link pointer and line number, then expect the SYS token and digits.
  let index = 6;
  while (prg[index] === 0x20) index += 1;
  if (prg[index] !== 0x9e) {
    return loadAddress;
  }
  index += 1;
  while (prg[index] === 0x20 || prg[index] === 0x28) index += 1;
  let digits = "";
  while (index < prg.length && prg[index]! >= 0x30 && prg[index]! <= 0x39) {
    digits += String.fromCharCode(prg[index]!);
    index += 1;
  }
  const target = Number.parseInt(digits, 10);
  return digits.length > 0 && target <= 0xffff ? target : loadAddress;
}
const MAX_ADDRESS = 0xffff;
const INT32_MIN = -0x80000000;
const UINT32_MAX = 0xffffffff;

const SINGLE_CHAR_TOKENS = new Set<string>([",", ":", "#", "(", ")", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "=", "!", "~"]);

const MULTI_CHAR_TOKENS = new Set<string>([
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
]);

const BINARY_OPERATOR_PRECEDENCE: Record<BinaryOperator, number> = {
  "|": 1,
  "^": 2,
  "&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "<<": 6,
  ">>": 6,
  "+": 7,
  "-": 7,
  "*": 8,
  "/": 8,
  "%": 8,
};

const DIRECTIVE_ALIASES: Record<string, DirectiveName> = {
  ".ORG": "org",
  ORG: "org",
  ".BYTE": "byte",
  "BYTE": "byte",
  "DB": "byte",
  ".DB": "byte",
  ".WORD": "word",
  "WORD": "word",
  "DW": "word",
  ".DW": "word",
  ".RES": "reserve",
  "RES": "reserve",
  ".DS": "reserve",
  "DS": "reserve",
  ".EQU": "equ",
  ".FILL": "fill",
  ".ALIGN": "align",
  ".TEXT": "text",
  ".ASCII": "text",
  ".INCLUDE": "include",
  "INCLUDE": "include",
};

const RELATIVE_ONLY = new Set<string>(["BCC", "BCS", "BEQ", "BMI", "BNE", "BPL", "BVC", "BVS"]);


export interface AssemblyResult {
  readonly prg: Buffer;
  /**
   * Address to SYS: the target of a leading BASIC SYS line at $0801 (the
   * automatic stub or the source's own), otherwise the first instruction,
   * otherwise the load address.
   */
  readonly entryAddress: number;
  /** Global label name -> resolved address (after both passes). */
  readonly symbols: ReadonlyMap<string, number>;
}

export function assemblyToPrg(source: string, options?: AssembleOptions): Buffer {
  return assemblyToPrgDetailed(source, options).prg;
}

export function assemblyToPrgDetailed(source: string, options?: AssembleOptions): AssemblyResult {
  const normalized = normalizeSource(source);
  const loadAddress = options?.loadAddress ?? DEFAULT_LOAD_ADDRESS;
  const rootFile = options?.fileName ?? "(input)";
  if (!Number.isInteger(loadAddress) || loadAddress < 0 || loadAddress > MAX_ADDRESS) {
    throw new AssemblyError(`loadAddress ${loadAddress} is outside $0000-$FFFF`, { file: rootFile, line: 0, text: "" });
  }
  const resolver = options?.resolveInclude;

  const parser = new Parser(resolver);
  const statements = parser.parse(normalized, rootFile);

  const assembler = new Assembler(statements, loadAddress);
  assembler.runPass(0);
  assembler.runPass(1);

  const prg = assembler.buildPrg();
  const loadAddressOfPrg = prg.length >= 2 ? prg.readUInt16LE(0) : loadAddress;
  const stubTarget = prg.length >= 2 ? prgEntryAddress(prg) : loadAddressOfPrg;
  const entryAddress = stubTarget !== loadAddressOfPrg
    ? stubTarget
    : assembler.getFirstInstructionAddress() ?? loadAddressOfPrg;
  return { prg, symbols: assembler.getSymbols(), entryAddress };
}

function normalizeSource(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

class Parser {
  constructor(
    private readonly includeResolver?: (requestedPath: string, fromFile: string) => string | { contents: string; fileName?: string },
  ) {}

  parse(source: string, fileName: string): ParsedLine[] {
    const statements: ParsedLine[] = [];
    this.parseInto(statements, source, fileName, []);
    return statements;
  }

  private parseInto(
    statements: ParsedLine[],
    source: string,
    fileName: string,
    includeStack: string[],
  ): void {
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const originalLine = lines[index] ?? "";
      const location: SourceLocation = { file: fileName, line: index + 1, text: originalLine };
      let labels: string[] = [];
      let statement: Statement | undefined;
      try {
        const tokens = tokenize(originalLine);
        if (tokens.length === 0) {
          continue;
        }

        const stream = new TokenStream(tokens);
        labels = [];

        while (stream.peek()?.kind === "symbol" && stream.peek(1)?.kind === "punct" && stream.peek(1)!.value === ":") {
          labels.push(stream.consumeSymbol());
          stream.consumePunct(":");
        }

        statement = this.parseStatement(stream, location, includeStack, statements);
      } catch (error) {
        // Name the source line for syntax errors as well.
        if (error instanceof AssemblyError) {
          throw error;
        }
        throw new AssemblyError(error instanceof Error ? error.message : String(error), location);
      }

      statements.push({
        labels,
        statement,
        location,
      });
    }
  }

  private parseStatement(
    stream: TokenStream,
    location: SourceLocation,
    includeStack: string[],
    statements: ParsedLine[],
  ): Statement | undefined {
    const first = stream.peek();
    if (!first) return undefined;

    if (first.kind === "symbol" && stream.peek(1)?.kind === "punct" && stream.peek(1)!.value === "=") {
      const target = stream.consumeSymbol();
      stream.consumePunct("=");
      const expr = parseExpression(stream, new Set<string>());
      stream.expectEnd();
      return {
        kind: "assignment",
        target,
        expr,
        isLocationCounter: false,
      };
    }

    if (first.kind === "punct" && first.value === "*" && stream.peek(1)?.kind === "punct" && stream.peek(1)!.value === "=") {
      stream.consumePunct("*");
      stream.consumePunct("=");
      const expr = parseExpression(stream, new Set<string>());
      stream.expectEnd();
      return {
        kind: "assignment",
        target: "*",
        expr,
        isLocationCounter: true,
      };
    }

    if (first.kind !== "symbol") {
      throw new AssemblyError("Expected an opcode, directive, or assignment", location);
    }

    // "name .equ expr", the same as "name = expr".
    const second = stream.peek(1);
    if (second?.kind === "symbol" && second.value.toUpperCase() === ".EQU") {
      const target = stream.consumeSymbol();
      stream.consumeSymbol();
      const expr = parseExpression(stream, new Set<string>());
      stream.expectEnd();
      return { kind: "assignment", target, expr, isLocationCounter: false };
    }

    const upper = stream.consumeSymbol().toUpperCase();

    if (upper in DIRECTIVE_ALIASES) {
      const directive = DIRECTIVE_ALIASES[upper];
      switch (directive) {
        case "org": {
          const expr = parseExpression(stream, new Set<string>());
          stream.expectEnd();
          return {
            kind: "directive",
            name: "org",
            args: [{ kind: "expr", expr }],
          };
        }
        case "include": {
          const includePath = stream.consumeString("include expects a string literal path");
          stream.expectEnd();

          if (!this.includeResolver) {
            throw new AssemblyError("include directive requires a resolveInclude option", location);
          }
          if (includeStack.includes(includePath)) {
            throw new AssemblyError(`Recursive include detected for "${includePath}"`, location);
          }
          const resolved = this.includeResolver(includePath, location.file);
          const includeContent =
            typeof resolved === "string" ? resolved : resolved.contents;
          const includeName =
            typeof resolved === "string" ? includePath : resolved.fileName ?? includePath;

          this.parseInto(statements, normalizeSource(includeContent), includeName, [...includeStack, includePath]);
          return undefined;
        }
        case "equ": {
          // ".equ name, expr", the same as "name = expr".
          const target = stream.consumeSymbol(".equ expects a symbol name");
          stream.consumePunct(",", ".equ expects a comma between the name and the value");
          const expr = parseExpression(stream, new Set<string>());
          stream.expectEnd();
          return { kind: "assignment", target, expr, isLocationCounter: false };
        }
        case "fill":
        case "align": {
          const args: DirectiveArg[] = [{ kind: "expr", expr: parseExpression(stream, new Set<string>([","])) }];
          if (stream.peek()?.kind === "punct" && stream.peek()!.value === ",") {
            stream.consumePunct(",");
            args.push({ kind: "expr", expr: parseExpression(stream, new Set<string>()) });
          }
          stream.expectEnd();
          return { kind: "directive", name: directive, args };
        }
        case "byte":
        case "text":
        case "word": {
          const args: DirectiveArg[] = [];
          while (!stream.isAtEnd()) {
            const next = stream.peek();
            if (!next) break;
            if (next.kind === "string") {
              args.push({ kind: "string", value: stream.consumeString() });
            } else {
              args.push({ kind: "expr", expr: parseExpression(stream, new Set<string>()) });
            }
            if (stream.peek()?.kind === "punct" && stream.peek()!.value === ",") {
              stream.consumePunct(",");
            } else {
              break;
            }
          }
          stream.expectEnd();
          return {
            kind: "directive",
            name: directive,
            args,
          };
        }
        case "reserve": {
          const expr = parseExpression(stream, new Set<string>());
          stream.expectEnd();
          return {
            kind: "directive",
            name: "reserve",
            args: [{ kind: "expr", expr }],
          };
        }
        default:
          throw new AssemblyError(`Unhandled directive ${directive}`, location);
      }
    }

    const mnemonic = upper;
    const operand = parseOperand(stream);
    stream.expectEnd();
    return {
      kind: "instruction",
      mnemonic,
      operand,
    };
  }
}

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const length = line.length;
  while (index < length) {
    const char = line[index] ?? "";

    if (char === ";" || char === "\u201b") {
      break;
    }

    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'") {
      const quote = char;
      index += 1;
      let value = "";
      let closed = false;

      while (index < length) {
        const current = line[index] ?? "";
        if (current === "\\" && index + 1 < length) {
          const escape = line[index + 1] ?? "";
          const translated = translateEscape(escape);
          value += translated;
          index += 2;
          continue;
        }

        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }

        value += current;
        index += 1;
      }

      if (!closed) {
        throw new Error("Unterminated string literal");
      }

      tokens.push({ kind: "string", value });
      continue;
    }

    if (isDigit(char) || char === "$") {
      const { value, nextIndex } = parseNumberToken(line, index);
      const digits = line.slice(index, nextIndex);
      const afterPercent = tokens[tokens.length - 1]?.kind === "punct" && tokens[tokens.length - 1]?.value === "%" && line[index - 1] === "%";
      if (afterPercent && /^[01]+$/.test(digits)) {
        tokens.push({ kind: "number", value, binaryValue: parseInt(digits, 2) });
        index = nextIndex;
        continue;
      }
      tokens.push({ kind: "number", value });
      index = nextIndex;
      continue;
    }

    if (isSymbolStart(char)) {
      let symbol = char;
      index += 1;
      while (index < length && isSymbolPart(line[index] ?? "")) {
        symbol += line[index];
        index += 1;
      }
      tokens.push({ kind: "symbol", value: symbol });
      continue;
    }

    const twoChar = line.slice(index, index + 2);
    if (MULTI_CHAR_TOKENS.has(twoChar)) {
      tokens.push({ kind: "punct", value: twoChar });
      index += 2;
      continue;
    }

    if (SINGLE_CHAR_TOKENS.has(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
      continue;
    }

    throw new Error(`Unexpected character '${char}'`);
  }

  return tokens;
}

class TokenStream {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  consume(): Token {
    const token = this.tokens[this.index];
    if (!token) {
      throw new Error("Unexpected end of token stream");
    }
    this.index += 1;
    return token;
  }

  consumeSymbol(errorMessage = "Expected a symbol token"): string {
    const token = this.consume();
    if (token.kind !== "symbol") {
      throw new Error(errorMessage);
    }
    return token.value;
  }

  consumeString(errorMessage = "Expected a string literal"): string {
    const token = this.consume();
    if (token.kind !== "string") {
      throw new Error(errorMessage);
    }
    return token.value;
  }

  consumePunct(expected?: string, errorMessage?: string): string {
    const token = this.consume();
    if (token.kind !== "punct") {
      throw new Error(errorMessage ?? "Expected punctuation token");
    }
    if (expected && token.value !== expected) {
      throw new Error(errorMessage ?? `Expected '${expected}'`);
    }
    return token.value;
  }

  isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  expectEnd(): void {
    if (!this.isAtEnd()) {
      throw new Error("Unexpected tokens at end of line");
    }
  }
}

function translateEscape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "\\":
      return "\\";
    case "\"":
      return "\"";
    case "'":
      return "'";
    default:
      return char;
  }
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isHexDigit(char: string): boolean {
  return isDigit(char) || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

function isBinaryDigit(char: string): boolean {
  return char === "0" || char === "1";
}

function isSymbolStart(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    char === "_" ||
    char === "."
  );
}

function isSymbolPart(char: string): boolean {
  return isSymbolStart(char) || isDigit(char);
}

function parseNumberToken(line: string, startIndex: number): { value: number; nextIndex: number } {
  let index = startIndex;
  let base = 10;

  if (line[index] === "$") {
    base = 16;
    index += 1;
  } else if (line.startsWith("0x", index) || line.startsWith("0X", index)) {
    base = 16;
    index += 2;
  } else if (line.startsWith("0b", index) || line.startsWith("0B", index)) {
    base = 2;
    index += 2;
  }

  let value = 0;
  let consumed = false;

  while (index < line.length) {
    const char = line[index] ?? "";
    let digit = -1;
    if (base === 16 && isHexDigit(char)) {
      digit = parseInt(char, 16);
    } else if (base === 10 && isDigit(char)) {
      digit = parseInt(char, 10);
    } else if (base === 2 && isBinaryDigit(char)) {
      digit = parseInt(char, 2);
    } else {
      break;
    }
    value = value * base + digit;
    consumed = true;
    index += 1;
  }

  if (!consumed) {
    throw new Error("Malformed numeric literal");
  }

  return { value, nextIndex: index };
}

function parseExpression(stream: TokenStream, terminators: Set<string>): Expression {
  return parseBinaryExpression(stream, terminators, 1);
}

function parseBinaryExpression(stream: TokenStream, terminators: Set<string>, minPrecedence: number): Expression {
  let left = parseUnaryExpression(stream, terminators);

  while (true) {
    const next = stream.peek();
    if (!next) break;
    if (next.kind === "punct" && terminators.has(next.value)) {
      break;
    }
    const op = asBinaryOperator(next);
    if (!op) {
      break;
    }
    const precedence = BINARY_OPERATOR_PRECEDENCE[op];
    if (precedence < minPrecedence) {
      break;
    }
    stream.consume();
    const right = parseBinaryExpression(stream, terminators, precedence + 1);
    left = { type: "binary", op, left, right };
  }

  return left;
}

function parseUnaryExpression(stream: TokenStream, terminators: Set<string>): Expression {
  const token = stream.consume();
  if (!token) {
    throw new Error("Unexpected end of expression");
  }
  // In operand position, "<" and ">" are byte selectors and "*" is the current
  // PC; parseBinaryExpression consumes them as binary operators elsewhere.
  // As in ACME, 64tass, DASM and Kick Assembler, "<" and ">" apply to the
  // whole rest of the expression: "#>msg+1" is the high byte of msg+1.
  if (token.kind === "punct" && (token.value === "<" || token.value === ">")) {
    const operand = parseBinaryExpression(stream, terminators, 0);
    return { type: "unary", op: token.value as UnaryOperator, operand };
  }
  if (
    token.kind === "punct" &&
    (token.value === "+" || token.value === "-" || token.value === "!" || token.value === "~")
  ) {
    const operand = parseUnaryExpression(stream, terminators);
    return { type: "unary", op: token.value as UnaryOperator, operand };
  }
  if (token.kind === "punct" && token.value === "*") {
    return { type: "symbol", name: "*" };
  }
  if (token.kind === "punct" && token.value === "%") {
    const digits = stream.peek();
    if (digits?.kind === "number" && digits.binaryValue !== undefined) {
      stream.consume();
      return { type: "number", value: digits.binaryValue };
    }
  }
  if (token.kind === "punct" && token.value === "(") {
    const expr = parseExpression(stream, new Set<string>([")"]));
    const closing = stream.consume();
    if (!closing || closing.kind !== "punct" || closing.value !== ")") {
      throw new Error("Expected closing parenthesis");
    }
    return expr;
  }

  if (token.kind === "number") {
    return { type: "number", value: token.value };
  }
  if (token.kind === "symbol") {
    return { type: "symbol", name: token.value };
  }
  if (token.kind === "string") {
    if (token.value.length !== 1) {
      throw new Error("String constants in expressions must be exactly one character");
    }
    return { type: "number", value: token.value.charCodeAt(0) };
  }

  throw new Error("Unexpected token in expression");
}

function asBinaryOperator(token: Token | undefined): BinaryOperator | undefined {
  if (!token || token.kind !== "punct") return undefined;
  if ((["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^", "==", "!=", "<", "<=", ">", ">="] as const).includes(token.value as BinaryOperator)) {
    return token.value as BinaryOperator;
  }
  return undefined;
}

function parseOperand(stream: TokenStream): Operand {
  if (stream.isAtEnd()) {
    return { kind: "none" };
  }

  const first = stream.peek();
  if (!first) return { kind: "none" };

  if (first.kind === "symbol" && first.value.toUpperCase() === "A") {
    stream.consume();
    if (!stream.isAtEnd()) {
      throw new Error("Unexpected tokens after accumulator operand");
    }
    return { kind: "accumulator" };
  }

  if (first.kind === "punct" && first.value === "#") {
    stream.consumePunct("#");
    const expr = parseExpression(stream, new Set<string>());
    return { kind: "immediate", expr };
  }

  if (first.kind === "punct" && first.value === "(") {
    stream.consumePunct("(");
    const expr = parseExpression(stream, new Set<string>([",", ")"]));
    if (stream.peek()?.kind === "punct" && stream.peek()?.value === ",") {
      stream.consumePunct(",");
      const register = stream.consumeSymbol("Expected X before ')'").toUpperCase();
      if (register !== "X") {
        throw new Error("Only X is allowed inside pre-indexed indirect operands");
      }
      stream.consumePunct(")", "Expected ')' to close indirect operand");
      if (!stream.isAtEnd()) {
        throw new Error("Unexpected tokens after indirect operand");
      }
      return { kind: "indirect", expr, register: "X" };
    }
    stream.consumePunct(")", "Expected ')' to close indirect operand");

    if (stream.isAtEnd()) {
      return { kind: "indirect", expr };
    }

    const next = stream.peek();
    if (next && next.kind === "punct" && next.value === ",") {
      stream.consumePunct(",");
      const register = stream.consumeSymbol("Expected X or Y after comma").toUpperCase();
      if (register === "Y") {
        return { kind: "indirect", expr, register: "Y" };
      }
      throw new Error(`Only ,Y is allowed after a closing parenthesis: use (zp),Y or (zp,X) (got ,${register})`);
    }
    return { kind: "indirect", expr };
  }

  const expr = parseExpression(stream, new Set<string>([","]));

  if (stream.isAtEnd()) {
    return { kind: "expression", expr };
  }

  const next = stream.peek();
  if (next && next.kind === "punct" && next.value === ",") {
    stream.consumePunct(",");
    const register = stream.consumeSymbol("Expected X, Y, or S after comma").toUpperCase();
    if (register !== "X" && register !== "Y" && register !== "S") {
      throw new Error("Only X, Y, or S are allowed after comma");
    }
    return { kind: "expression", expr, register };
  }

  throw new Error("Unexpected tokens after operand");
}

class SymbolTable {
  private globals = new Map<string, number>();
  private locals = new Map<string, Map<string, number>>();
  private currentScope: string | undefined;

  reset(): void {
    this.globals = new Map();
    this.locals = new Map();
    this.definitions.clear();
    this.currentScope = undefined;
  }

  private readonly definitions = new Map<string, { location: SourceLocation; value: number; isLabel: boolean }>();

  /**
   * Records where a name was first defined and rejects a second definition.
   * Redefining a constant with the same value is allowed.
   */
  private recordDefinition(label: string, value: number, isLabel: boolean, location: SourceLocation | undefined): void {
    if (!location) return;
    const key = label.startsWith(".") ? `${this.currentScope ?? ""}\u0000${label}` : label;
    const previous = this.definitions.get(key);
    if (previous && (previous.isLabel || isLabel || previous.value !== value)) {
      const kind = isLabel || previous.isLabel ? "label" : "symbol";
      throw new Error(`Duplicate ${kind} "${label}" (first defined at ${previous.location.file}:${previous.location.line})`);
    }
    this.definitions.set(key, { location, value, isLabel });
  }

  setLabel(label: string, value: number, location?: SourceLocation): void {
    if (label.startsWith(".") && !this.currentScope) {
      throw new Error(`Local label "${label}" defined before any global label`);
    }
    this.recordDefinition(label, value, true, location);
    if (label.startsWith(".")) {
      if (!this.currentScope) {
        throw new Error(`Local label "${label}" defined before any global label`);
      }
      const scoped = this.ensureLocalScope(this.currentScope);
      scoped.set(label, value);
    } else {
      this.globals.set(label, value);
      this.currentScope = label;
    }
  }

  ensureLabel(label: string, expected: number): void {
    this.ensureUnchanged(label, expected);
    if (!label.startsWith(".")) {
      this.currentScope = label;
    }
  }

  // Constant assignments never open a local-label scope (as in ACME and
  // 64tass), matching setAssignment in the first pass.
  ensureAssignment(label: string, expected: number): void {
    this.ensureUnchanged(label, expected);
  }

  setAssignment(label: string, value: number, location?: SourceLocation): void {
    if (label.startsWith(".") && !this.currentScope) {
      throw new Error(`Local constant "${label}" defined before any global label`);
    }
    this.recordDefinition(label, value, false, location);
    if (label.startsWith(".")) {
      if (!this.currentScope) {
        throw new Error(`Local constant "${label}" defined before any global label`);
      }
      const scoped = this.ensureLocalScope(this.currentScope);
      scoped.set(label, value);
    } else {
      this.globals.set(label, value);
    }
  }

  get(label: string): number | undefined {
    if (label === "*") {
      throw new Error("'*' should be resolved externally");
    }
    if (label.startsWith(".")) {
      if (!this.currentScope) return undefined;
      return this.locals.get(this.currentScope)?.get(label);
    }
    return this.globals.get(label);
  }

  allGlobals(): ReadonlyMap<string, number> {
    return this.globals;
  }

  private ensureUnchanged(label: string, expected: number): void {
    const existing = this.get(label);
    if (existing === undefined) {
      throw new Error(`Symbol "${label}" was not defined in the first pass`);
    }
    if (existing !== expected) {
      throw new Error(`Symbol "${label}" changed value between passes (expected ${formatHex(existing)}, got ${formatHex(expected)})`);
    }
  }

  private ensureLocalScope(scope: string): Map<string, number> {
    if (!this.locals.has(scope)) {
      this.locals.set(scope, new Map());
    }
    return this.locals.get(scope)!;
  }
}

class Assembler {
  private readonly symbolTable = new SymbolTable();
  private readonly memory = new Uint8Array(0x10000);
  private readonly written = new Uint8Array(0x10000);
  /** Index into blocks (plus one) of the contiguous run that wrote each address in the current pass. */
  private readonly owner = new Uint32Array(0x10000);
  private blocks: Array<{ start: number; end: number; line: number; file: string }> = [];
  private pc = 0;
  private lowestWritten = MAX_ADDRESS;
  private highestWritten = 0;
  private firstInstructionAddress: number | undefined;
  /** Reserved (.res) ranges from the last pass, as [start, end] inclusive. */
  private reserved: Array<[number, number]> = [];

  constructor(private readonly lines: ParsedLine[], private readonly defaultLoadAddress: number) {
    this.symbolTable.reset();
  }

  runPass(pass: 0 | 1): void {
    // Code before the first org directive is assembled at the load address.
    this.pc = this.defaultLoadAddress;
    if (pass === 0) {
      this.symbolTable.reset();
      this.lowestWritten = MAX_ADDRESS;
      this.highestWritten = 0;
      this.firstInstructionAddress = undefined;
    }
    this.reserved = [];
    this.written.fill(0);
    this.owner.fill(0);
    this.blocks = [];
    // Loading a PRG at $0801 makes BASIC relink the bytes there as program
    // lines, which corrupts raw machine code. Code that starts at $0801
    // without its own org therefore gets a "10 SYS" stub that jumps to the
    // first instruction, even when data comes before it.
    if (this.pc === BASIC_START && this.emitsBeforeFirstOrg()) {
      // Pass 0 does not know the first instruction's address yet; pass 1 uses the address pass 0 recorded.
      for (const byte of basicSysStub(pass === 1 ? this.firstInstructionAddress ?? 0 : 0)) {
        this.writeByte(byte, this.lines[0]!.location);
      }
    }

    for (const line of this.lines) {
      try {
        this.processLine(line, pass);
      } catch (error) {
        if (error instanceof AssemblyError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new AssemblyError(message, line.location);
      }
    }
  }

  /** Bitwise operators work on 32-bit values; anything wider would be silently truncated. */
  private checkBitOperand(value: number, op: string, location: SourceLocation): void {
    if (!Number.isInteger(value) || value < INT32_MIN || value > UINT32_MAX) {
      throw new AssemblyError(`Operand ${value} of ${op} is outside the 32-bit range ${INT32_MIN}..${UINT32_MAX}`, location);
    }
  }

  private checkOrigin(value: number, what: string, location: SourceLocation): number {
    if (!Number.isInteger(value) || value < 0 || value > MAX_ADDRESS) {
      throw new AssemblyError(`${what} value ${value} is outside $0000-$FFFF`, location);
    }
    return value;
  }

  /**
   * True when the source has an instruction that is assembled at the load
   * address, before any org or `* =`. Only then is there an entry point for
   * the BASIC stub to jump to; data-only source stays a plain data image.
   */
  private emitsBeforeFirstOrg(): boolean {
    for (const line of this.lines) {
      const statement = line.statement;
      if (!statement) continue;
      if (statement.kind === "instruction") return true;
      if (statement.kind === "assignment" && statement.isLocationCounter) return false;
      if (statement.kind === "directive" && statement.name === "org") return false;
    }
    return false;
  }

  buildPrg(): Buffer {
    // The PRG spans the bytes actually emitted, so org blocks that only define
    // labels neither move the load address nor add padding.
    if (this.lowestWritten > this.highestWritten) {
      return Buffer.alloc(0);
    }
    let start = this.lowestWritten;
    let end = this.highestWritten;
    // Reserved space that adjoins the emitted bytes (a trailing "counter: .res 1")
    // is part of the image and zero-filled, as in ca65 and DASM; detached blocks
    // such as zero-page variables are not, so they do not stretch the PRG.
    for (let changed = true; changed;) {
      changed = false;
      for (const [resStart, resEnd] of this.reserved) {
        // Adjoining or overlapping blocks extend the image.
        if (resStart <= end + 1 && resEnd > end) { end = resEnd; changed = true; }
        if (resEnd >= start - 1 && resStart < start) { start = resStart; changed = true; }
      }
    }
    // Addresses that are neither emitted nor reserved are zero-filled. Refuse a run of them that
    // touches $D000-$DFFF: the loader would write zeros to the VIC, SID, CIA and colour RAM.
    let gapStart: number | undefined;
    for (let addr = start; addr <= end + 1; addr++) {
      const gap = addr <= end && !this.written[addr] && !this.reserved.some(([s, e]) => addr >= s && addr <= e);
      if (gap && gapStart === undefined) gapStart = addr;
      if (!gap && gapStart !== undefined) {
        if (rangeOverlapsIo(gapStart, addr - gapStart)) {
          const after = this.blocks.filter((b) => b.start > gapStart!).sort((a, b) => a.start - b.start)[0] ?? this.blocks[0]!;
          throw new AssemblyError(
            `The zero-filled gap ${formatHex(gapStart)}-${formatHex(addr - 1)} between output blocks overlaps $D000-$DFFF (I/O registers); assemble the blocks separately instead`,
            { file: after.file, line: after.line, text: "" },
          );
        }
        gapStart = undefined;
      }
    }
    const body = this.memory.subarray(start, end + 1);
    const header = Buffer.alloc(2);
    header.writeUInt16LE(start, 0);
    return Buffer.concat([header, Buffer.from(body)]);
  }

  getFirstInstructionAddress(): number | undefined {
    return this.firstInstructionAddress;
  }

  getSymbols(): ReadonlyMap<string, number> {
    return this.symbolTable.allGlobals();
  }

  private processLine(line: ParsedLine, pass: 0 | 1): void {
    for (const label of line.labels) {
      if (pass === 0) {
        this.symbolTable.setLabel(label, this.pc, line.location);
      } else {
        this.symbolTable.ensureLabel(label, this.pc);
      }
    }

    if (!line.statement) {
      return;
    }

    switch (line.statement.kind) {
      case "assignment":
        this.handleAssignment(line.statement, pass, line.location);
        break;
      case "directive":
        this.handleDirective(line.statement, pass, line.location);
        break;
      case "instruction":
        this.handleInstruction(line.statement, pass, line.location);
        break;
      default:
        throw new Error("Unknown statement kind");
    }
  }

  private handleAssignment(statement: AssignmentStatement, pass: 0 | 1, location: SourceLocation): void {
    const value = this.evaluate(statement.expr, pass, location);
    if (value === undefined) {
      throw this.undefinedError(statement.expr, location, "Assignment depends on an undefined symbol");
    }
    if (statement.isLocationCounter) {
      this.pc = this.checkOrigin(value, "* =", location);
    } else if (pass === 0) {
      this.symbolTable.setAssignment(statement.target, value, location);
    } else {
      this.symbolTable.ensureAssignment(statement.target, value);
    }
  }

  private handleDirective(statement: DirectiveStatement, pass: 0 | 1, location: SourceLocation): void {
    switch (statement.name) {
      case "org": {
        if (statement.args.length !== 1 || statement.args[0]?.kind !== "expr") {
          throw new AssemblyError("org directive expects a single expression", location);
        }
        const value = this.evaluate(statement.args[0]?.expr, pass, location);
        if (value === undefined) {
          throw this.undefinedError(statement.args[0].expr, location, "org directive requires a defined value");
        }
        this.pc = this.checkOrigin(value, "org directive", location);
        break;
      }
      case "byte":
      case "text": {
        const isText = statement.name === "text";
        for (const arg of statement.args) {
          if (arg.kind === "string") {
            if (pass === 1) {
              for (const char of arg.value) {
                const code = isText ? asciiToPetscii(char, location) : char.charCodeAt(0);
                if (code > 0xff) {
                  throw new AssemblyError(`byte directive character '${char}' (code ${code}) does not fit in one byte`, location);
                }
                this.writeByte(code, location);
              }
            } else {
              this.pc += Array.from(arg.value).length;
            }
          } else {
            const value = this.evaluate(arg.expr, pass, location);
            if (pass === 1) {
              if (value === undefined) {
                throw this.undefinedError(arg.expr, location, "byte directive contains undefined expression");
              }
              if (value < -128 || value > 255) {
                throw new AssemblyError(`byte directive value ${value} is outside -128..255 and would be truncated`, location);
              }
              this.writeByte(value, location);
            } else {
              this.pc += 1;
            }
          }
        }
        break;
      }
      case "word": {
        for (const arg of statement.args) {
          if (arg.kind === "string") {
            if (pass === 1) {
              for (const char of arg.value) {
                const code = char.codePointAt(0)!;
                if (code > 0xffff) {
                  throw new AssemblyError(`word directive character '${char}' (code ${code}) does not fit in one word`, location);
                }
                this.writeWord(code, location);
              }
            } else {
              // Count code points, as pass 1 iterates, so both passes agree for characters above $FFFF.
              this.pc += Array.from(arg.value).length * 2;
            }
          } else {
            const value = this.evaluate(arg.expr, pass, location);
            if (value === undefined) {
              if (pass === 1) {
                throw this.undefinedError(arg.expr, location, "word directive contains undefined expression");
              }
              this.pc += 2;
            } else if (pass === 1) {
              if (value < -32768 || value > 65535) {
                throw new AssemblyError(`word directive value ${value} is outside -32768..65535 and would be truncated`, location);
              }
              this.writeWord(value, location);
            } else {
              this.pc += 2;
            }
          }
        }
        break;
      }
      case "fill": {
        const count = this.evaluateDefined(statement.args[0]!, pass, location, "fill directive");
        if (!Number.isInteger(count) || count < 0 || count > 0x10000) {
          throw new AssemblyError(`fill directive requires a count of 0..65536, got ${count}`, location);
        }
        const value = statement.args[1] ? this.evaluateDefined(statement.args[1], pass, location, "fill directive") : 0;
        if (pass === 1) {
          this.checkByteValue(value, "fill directive", location);
          for (let index = 0; index < count; index += 1) this.writeByte(value, location);
        } else {
          this.pc += count;
        }
        break;
      }
      case "align": {
        const boundary = this.evaluateDefined(statement.args[0]!, pass, location, "align directive");
        if (!Number.isInteger(boundary) || boundary < 1 || boundary > 0x10000) {
          throw new AssemblyError(`align directive requires a boundary of 1..65536, got ${boundary}`, location);
        }
        const value = statement.args[1] ? this.evaluateDefined(statement.args[1], pass, location, "align directive") : 0;
        const padding = (boundary - (this.pc % boundary)) % boundary;
        if (pass === 1) {
          this.checkByteValue(value, "align directive", location);
          for (let index = 0; index < padding; index += 1) this.writeByte(value, location);
        } else {
          this.pc += padding;
        }
        break;
      }
      case "equ": {
        // Parsed as an assignment; never reaches the directive handler.
        break;
      }
      case "reserve": {
        if (statement.args.length !== 1 || statement.args[0]?.kind !== "expr") {
          throw new AssemblyError("reserve directive expects a single expression", location);
        }
        const amount = this.evaluate(statement.args[0]?.expr, pass, location);
        if (amount === undefined) {
          throw this.undefinedError(statement.args[0].expr, location, "reserve directive requires a defined value");
        }
        if (amount < 0) {
          throw new AssemblyError("reserve directive requires a non-negative size", location);
        }
        // Reserved space advances the PC without emitting; buildPrg includes it
        // (zero-filled) only where it adjoins emitted bytes.
        if (this.pc + amount > MAX_ADDRESS + 1) {
          throw new AssemblyError(
            `reserve directive of ${amount} bytes at ${formatHex(this.pc)} passes $FFFF`,
            location,
          );
        }
        if (amount > 0) this.reserved.push([this.pc, this.pc + amount - 1]);
        this.pc += amount;
        break;
      }
      case "include": {
        // Include directives are expanded during parsing.
        break;
      }
      default:
        throw new AssemblyError(`Unsupported directive ${statement.name}`, location);
    }
  }

  private handleInstruction(statement: InstructionStatement, pass: 0 | 1, location: SourceLocation): void {
    const info = determineInstruction(statement, pass, this.evaluate.bind(this), this.pc, location);
    statement.resolvedMode = info.mode;

    if (pass === 0) {
      this.firstInstructionAddress ??= this.pc;
      this.pc += info.size;
      return;
    }

    if (modeExpectsValue(info.mode) && info.value === undefined) {
      const operand = statement.operand;
      throw this.undefinedError("expr" in operand ? operand.expr : undefined, location, "Undefined expression");
    }

    const opcode = lookupOpcode(statement.mnemonic, info.mode, location);
    this.writeByte(opcode, location);

    switch (info.mode) {
      case AddressingMode.Immediate:
      case AddressingMode.ZeroPage:
      case AddressingMode.ZeroPageX:
      case AddressingMode.ZeroPageY:
      case AddressingMode.ZeroPageS:
      case AddressingMode.IndirectX:
      case AddressingMode.IndirectY:
        this.writeByte(info.value ?? 0, location);
        break;
      case AddressingMode.Absolute:
      case AddressingMode.AbsoluteX:
      case AddressingMode.AbsoluteY:
      case AddressingMode.Indirect:
        this.writeWord(info.value ?? 0, location);
        break;
      case AddressingMode.Relative: {
        const offset = computeRelativeOffset(this.pc - 1, info.value ?? 0, location);
        this.writeByte(offset, location);
        break;
      }
      case AddressingMode.Accumulator:
      case AddressingMode.Implied:
        break;
      default:
        throw new AssemblyError(`Unhandled addressing mode ${info.mode}`, location);
    }
  }

  private evaluateDefined(arg: DirectiveArg, pass: 0 | 1, location: SourceLocation, context: string): number {
    if (arg.kind !== "expr") {
      throw new AssemblyError(`${context} expects a numeric expression`, location);
    }
    const value = this.evaluate(arg.expr, pass, location);
    if (value === undefined) {
      throw this.undefinedError(arg.expr, location, `${context} requires a defined value`);
    }
    return value;
  }

  private checkByteValue(value: number, context: string, location: SourceLocation): void {
    if (value < -128 || value > 255) {
      throw new AssemblyError(`${context} value ${value} is outside -128..255 and would be truncated`, location);
    }
  }

  private undefinedSymbols(expr: Expression | undefined): string[] {
    if (!expr) return [];
    switch (expr.type) {
      case "number":
        return [];
      case "symbol":
        return expr.name !== "*" && this.symbolTable.get(expr.name) === undefined ? [expr.name] : [];
      case "unary":
        return this.undefinedSymbols(expr.operand);
      case "binary":
        return [...new Set([...this.undefinedSymbols(expr.left), ...this.undefinedSymbols(expr.right)])];
      default:
        return [];
    }
  }

  /** Names the undefined symbols of an expression; falls back to the generic message. */
  private undefinedError(expr: Expression | undefined, location: SourceLocation, fallback: string): AssemblyError {
    const names = this.undefinedSymbols(expr);
    if (names.length === 0) {
      return new AssemblyError(fallback, location);
    }
    const quoted = names.map((name) => `"${name}"`).join(", ");
    return new AssemblyError(`Undefined symbol${names.length > 1 ? "s" : ""} ${quoted}`, location);
  }

  private evaluate(expr: Expression, pass: 0 | 1, location: SourceLocation): number | undefined {
    switch (expr.type) {
      case "number":
        return expr.value;
      case "symbol":
        if (expr.name === "*") {
          return this.pc;
        }
        return this.symbolTable.get(expr.name);
      case "unary": {
        const value = this.evaluate(expr.operand, pass, location);
        if (value === undefined) return undefined;
        switch (expr.op) {
          case "+":
            return value;
          case "-":
            return -value;
          case "!":
            return value ? 0 : 1;
          case "~":
            this.checkBitOperand(value, "~", location);
            return ~value;
          case "<":
            return value & 0xff;
          case ">":
            return (value >> 8) & 0xff;
          default:
            throw new AssemblyError("Unknown unary operator", location);
        }
      }
      case "binary": {
        const left = this.evaluate(expr.left, pass, location);
        const right = this.evaluate(expr.right, pass, location);
        if (left === undefined || right === undefined) {
          return undefined;
        }
        switch (expr.op) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            if (right === 0) throw new AssemblyError("Division by zero", location);
            return Math.trunc(left / right);
          case "%":
            if (right === 0) throw new AssemblyError("Modulo by zero", location);
            return left % right;
          case "<<":
          case ">>": {
            this.checkBitOperand(left, expr.op, location);
            if (!Number.isInteger(right) || right < 0 || right > 31) {
              throw new AssemblyError(`Shift count ${right} for ${expr.op} is outside 0..31`, location);
            }
            return expr.op === "<<" ? left << right : left >> right;
          }
          case "&":
          case "|":
          case "^": {
            this.checkBitOperand(left, expr.op, location);
            this.checkBitOperand(right, expr.op, location);
            return expr.op === "&" ? left & right : expr.op === "|" ? left | right : left ^ right;
          }
          case "==":
            return left === right ? 1 : 0;
          case "!=":
            return left !== right ? 1 : 0;
          case "<":
            return left < right ? 1 : 0;
          case "<=":
            return left <= right ? 1 : 0;
          case ">":
            return left > right ? 1 : 0;
          case ">=":
            return left >= right ? 1 : 0;
          default:
            throw new AssemblyError("Unknown binary operator", location);
        }
      }
      default:
        throw new AssemblyError("Invalid expression node", location);
    }
  }

  private writeByte(value: number, location: SourceLocation): void {
    if (this.pc > MAX_ADDRESS) {
      throw new AssemblyError(
        `Output passes $FFFF: a byte would be written at ${formatHex(this.pc)}, outside the 64 KB address space`,
        location,
      );
    }
    const masked = value & 0xff;
    let block = this.blocks[this.blocks.length - 1];
    if (!block || block.end + 1 !== this.pc) {
      block = { start: this.pc, end: this.pc, line: location.line, file: location.file };
      this.blocks.push(block);
    }
    if (this.written[this.pc]) {
      const earlier = this.blocks[this.owner[this.pc]! - 1]!;
      throw new AssemblyError(
        `Overlapping output: the block starting at ${formatHex(block.start)} (line ${block.line}) writes ${formatHex(this.pc)}, which the block ${formatHex(earlier.start)}-${formatHex(earlier.end)} (line ${earlier.line}) already wrote`,
        location,
      );
    }
    block.end = this.pc;
    this.owner[this.pc] = this.blocks.length;
    this.memory[this.pc] = masked;
    this.written[this.pc] = 1;
    this.lowestWritten = Math.min(this.lowestWritten, this.pc);
    this.highestWritten = Math.max(this.highestWritten, this.pc);
    // The counter may reach $10000 so that a following write is detected; a
    // wrapped counter would silently overwrite the start of the image.
    this.pc += 1;
  }

  private writeWord(value: number, location: SourceLocation): void {
    const masked = value & 0xffff;
    this.writeByte(masked & 0xff, location);
    this.writeByte((masked >> 8) & 0xff, location);
  }
}

/**
 * ASCII to PETSCII for .text/.ascii in the default upper-case/graphics
 * character set: a-z and A-Z both become the PETSCII upper-case codes
 * $41-$5A, newline becomes RETURN ($0D), every other ASCII character is
 * unchanged. Characters above $7F have no mapping.
 */
function asciiToPetscii(char: string, location: SourceLocation): number {
  const code = char.charCodeAt(0);
  if (code > 0x7f) {
    throw new AssemblyError(`text directive character '${char}' (code ${code}) is not ASCII and has no PETSCII mapping`, location);
  }
  if (code >= 0x61 && code <= 0x7a) return code - 0x20;
  if (code === 0x0a) return 0x0d;
  return code;
}

interface ResolvedInstruction {
  mode: AddressingMode;
  size: number;
  value?: number;
}

function determineInstruction(
  statement: InstructionStatement,
  pass: 0 | 1,
  evaluator: (expr: Expression, pass: 0 | 1, location: SourceLocation) => number | undefined,
  locationCounter: number,
  location: SourceLocation,
): ResolvedInstruction {
  if (statement.resolvedMode && pass === 1) {
    const value = statement.operand.kind === "none" ? undefined : resolveOperandValue(statement.operand, evaluator, pass, location);
    assertZeroPageOperand(statement.mnemonic, statement.resolvedMode, value, location);
    assertOperandRange(statement.mnemonic, statement.resolvedMode, value, location);
    const size = instructionSize(statement.resolvedMode);
    return {
      mode: statement.resolvedMode,
      size,
      value: normalizeOperandValue(statement.resolvedMode, value, location),
    };
  }

  const value = resolveOperandValue(statement.operand, evaluator, pass, location);
  const mode = chooseAddressingMode(statement.mnemonic, statement.operand, value, pass, location);
  const size = instructionSize(mode);

  statement.resolvedMode = statement.resolvedMode ?? mode;

  return {
    mode,
    size,
    value: normalizeOperandValue(mode, value, locationCounter, location),
  };
}

function resolveOperandValue(
  operand: Operand,
  evaluator: (expr: Expression, pass: 0 | 1, location: SourceLocation) => number | undefined,
  pass: 0 | 1,
  location: SourceLocation,
): number | undefined {
  switch (operand.kind) {
    case "none":
    case "accumulator":
      return undefined;
    case "immediate":
    case "expression":
    case "indirect":
      return evaluator(operand.expr, pass, location);
    default:
      return undefined;
  }
}

function chooseAddressingMode(
  mnemonic: string,
  operand: Operand,
  value: number | undefined,
  pass: 0 | 1,
  location: SourceLocation,
): AddressingMode {
  const available = INSTRUCTION_TABLE.get(mnemonic);
  if (!available) {
    throw new AssemblyError(`Unknown instruction "${mnemonic}"`, location);
  }

  switch (operand.kind) {
    case "none":
      if (available.has(AddressingMode.Implied)) return AddressingMode.Implied;
      if (available.has(AddressingMode.Accumulator)) return AddressingMode.Accumulator;
      throw new AssemblyError(`Instruction ${mnemonic} requires an operand`, location);
    case "accumulator":
      if (!available.has(AddressingMode.Accumulator)) {
        throw new AssemblyError(`Instruction ${mnemonic} does not support accumulator addressing`, location);
      }
      return AddressingMode.Accumulator;
    case "immediate":
      if (!available.has(AddressingMode.Immediate)) {
        throw new AssemblyError(`Instruction ${mnemonic} does not support immediate addressing`, location);
      }
      return AddressingMode.Immediate;
    case "indirect": {
      if (operand.register === "X") {
        if (!available.has(AddressingMode.IndirectX)) {
          throw new AssemblyError(`Instruction ${mnemonic} does not support (expr,X) addressing`, location);
        }
        return AddressingMode.IndirectX;
      }
      if (operand.register === "Y") {
        if (!available.has(AddressingMode.IndirectY)) {
          throw new AssemblyError(`Instruction ${mnemonic} does not support (expr),Y addressing`, location);
        }
        return AddressingMode.IndirectY;
      }
      if (!available.has(AddressingMode.Indirect)) {
        throw new AssemblyError(`Instruction ${mnemonic} does not support (expr) addressing`, location);
      }
      return AddressingMode.Indirect;
    }
    case "expression": {
      const register = operand.register;
      if (RELATIVE_ONLY.has(mnemonic)) {
        if (!available.has(AddressingMode.Relative)) {
          throw new AssemblyError(`Instruction ${mnemonic} does not support relative addressing`, location);
        }
        return AddressingMode.Relative;
      }

      if (register === "X") {
        return chooseZeroPageOrAbsolute(mnemonic, available, AddressingMode.ZeroPageX, AddressingMode.AbsoluteX, value, location);
      }
      if (register === "Y") {
        return chooseZeroPageOrAbsolute(mnemonic, available, AddressingMode.ZeroPageY, AddressingMode.AbsoluteY, value, location);
      }
      if (register === "S") {
        if (!available.has(AddressingMode.ZeroPageS)) {
          throw new AssemblyError(`Instruction ${mnemonic} does not support expr,S addressing`, location);
        }
        return AddressingMode.ZeroPageS;
      }
      return chooseZeroPageOrAbsolute(mnemonic, available, AddressingMode.ZeroPage, AddressingMode.Absolute, value, location);
    }
    default:
      throw new AssemblyError("Unsupported operand kind", location);
  }
}

function chooseZeroPageOrAbsolute(
  mnemonic: string,
  available: Map<AddressingMode, number>,
  zeroPageMode: AddressingMode,
  absoluteMode: AddressingMode,
  value: number | undefined,
  location: SourceLocation,
): AddressingMode {
  const hasZeroPage = available.has(zeroPageMode);
  const hasAbsolute = available.has(absoluteMode);
  if (hasZeroPage && value !== undefined && fitsByte(value)) {
    return zeroPageMode;
  }
  if (hasAbsolute) {
    return absoluteMode;
  }
  // Without an absolute form (e.g. STX zp,Y), a forward reference must be
  // sized as zero page; the second pass rejects values outside zero page.
  if (hasZeroPage && value === undefined) {
    return zeroPageMode;
  }
  throw new AssemblyError(`Instruction ${mnemonic} does not support ${absoluteMode} addressing`, location);
}

function assertZeroPageOperand(mnemonic: string, mode: AddressingMode, value: number | undefined, location: SourceLocation): void {
  const absoluteMode = ZERO_PAGE_TO_ABSOLUTE_MODE.get(mode);
  if (absoluteMode === undefined || value === undefined || fitsByte(value)) {
    return;
  }
  throw new AssemblyError(
    `Instruction ${mnemonic} does not support ${absoluteMode} addressing (operand ${formatHex(value)} is outside zero page)`,
    location,
  );
}

/**
 * Rejects operands that the encoding would truncate. Runs in the final pass
 * only, where every symbol has a value; in the first pass a forward reference
 * is still undefined and is sized as absolute.
 */
function assertOperandRange(mnemonic: string, mode: AddressingMode, value: number | undefined, location: SourceLocation): void {
  if (value === undefined) return;
  switch (mode) {
    case AddressingMode.Immediate:
      if (value < -128 || value > 255) {
        throw new AssemblyError(
          `Immediate operand ${value} of ${mnemonic} is outside -128..255 and would be truncated to one byte`,
          location,
        );
      }
      return;
    case AddressingMode.IndirectX:
    case AddressingMode.IndirectY:
      if (value < 0 || value > 0xff) {
        const form = mode === AddressingMode.IndirectX ? "(zp,X)" : "(zp),Y";
        throw new AssemblyError(
          `Instruction ${mnemonic} ${form} requires a zero-page operand ($00-$FF), got ${value < 0 ? value : formatHex(value)}`,
          location,
        );
      }
      return;
    case AddressingMode.ZeroPageS:
      if (value < 0 || value > 0xff) {
        throw new AssemblyError(`Stack-relative operand ${value} of ${mnemonic} is outside 0..255`, location);
      }
      return;
    case AddressingMode.Absolute:
    case AddressingMode.AbsoluteX:
    case AddressingMode.AbsoluteY:
    case AddressingMode.Indirect:
      if (value < 0 || value > 0xffff) {
        throw new AssemblyError(`Address operand ${value} of ${mnemonic} is outside $0000-$FFFF`, location);
      }
      return;
    default:
      return;
  }
}

const ZERO_PAGE_TO_ABSOLUTE_MODE = new Map<AddressingMode, AddressingMode>([
  [AddressingMode.ZeroPage, AddressingMode.Absolute],
  [AddressingMode.ZeroPageX, AddressingMode.AbsoluteX],
  [AddressingMode.ZeroPageY, AddressingMode.AbsoluteY],
]);

function instructionSize(mode: AddressingMode): number {
  switch (mode) {
    case AddressingMode.Implied:
    case AddressingMode.Accumulator:
      return 1;
    case AddressingMode.Immediate:
    case AddressingMode.ZeroPage:
    case AddressingMode.ZeroPageX:
    case AddressingMode.ZeroPageY:
    case AddressingMode.ZeroPageS:
    case AddressingMode.IndirectX:
    case AddressingMode.IndirectY:
    case AddressingMode.Relative:
      return 2;
    case AddressingMode.Absolute:
    case AddressingMode.AbsoluteX:
    case AddressingMode.AbsoluteY:
    case AddressingMode.Indirect:
      return 3;
    default:
      return 0;
  }
}

function modeExpectsValue(mode: AddressingMode): boolean {
  switch (mode) {
    case AddressingMode.Implied:
    case AddressingMode.Accumulator:
      return false;
    default:
      return true;
  }
}

function normalizeOperandValue(
  mode: AddressingMode,
  value: number | undefined,
  locationCounterOrLocation: number | SourceLocation,
  locationMaybe?: SourceLocation,
): number | undefined {
  const location = locationMaybe ?? (locationCounterOrLocation as SourceLocation);
  switch (mode) {
    case AddressingMode.Immediate:
    case AddressingMode.ZeroPage:
    case AddressingMode.ZeroPageX:
    case AddressingMode.ZeroPageY:
    case AddressingMode.ZeroPageS:
    case AddressingMode.IndirectX:
    case AddressingMode.IndirectY:
      if (value === undefined) return undefined;
      return value & 0xff;
    case AddressingMode.Relative:
      return value;
    case AddressingMode.Absolute:
    case AddressingMode.AbsoluteX:
    case AddressingMode.AbsoluteY:
    case AddressingMode.Indirect:
      if (value === undefined) return undefined;
      return value & 0xffff;
    case AddressingMode.Implied:
    case AddressingMode.Accumulator:
      return undefined;
    default:
      throw new AssemblyError(`Unsupported addressing mode ${mode}`, location);
  }
}

function computeRelativeOffset(currentPc: number, target: number, location: SourceLocation): number {
  const from = (currentPc + 2) & 0xffff;
  const delta = target - from;
  if (delta < -128 || delta > 127) {
    throw new AssemblyError(`Branch target out of range (offset ${delta})`, location);
  }
  return delta & 0xff;
}

function lookupOpcode(mnemonic: string, mode: AddressingMode, location: SourceLocation): number {
  const info = INSTRUCTION_TABLE.get(mnemonic);
  if (!info) {
    throw new AssemblyError(`Unknown instruction "${mnemonic}"`, location);
  }
  const opcode = info.get(mode);
  if (opcode === undefined) {
    throw new AssemblyError(`Instruction ${mnemonic} does not support ${mode} addressing`, location);
  }
  return opcode;
}

function fitsByte(value: number): boolean {
  return value >= 0 && value <= 0xff;
}

function formatHex(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

const OPCODE_MODE_TO_ADDRESSING_MODE: Record<OpcodeAddressingMode, AddressingMode> = {
  implied: AddressingMode.Implied,
  accumulator: AddressingMode.Accumulator,
  immediate: AddressingMode.Immediate,
  zeroPage: AddressingMode.ZeroPage,
  zeroPageX: AddressingMode.ZeroPageX,
  zeroPageY: AddressingMode.ZeroPageY,
  zeroPageS: AddressingMode.ZeroPageS,
  absolute: AddressingMode.Absolute,
  absoluteX: AddressingMode.AbsoluteX,
  absoluteY: AddressingMode.AbsoluteY,
  indirect: AddressingMode.Indirect,
  indirectX: AddressingMode.IndirectX,
  indirectY: AddressingMode.IndirectY,
  relative: AddressingMode.Relative,
};

function buildInstructionTable(): Map<string, Map<AddressingMode, number>> {
  const table = new Map<string, Map<AddressingMode, number>>();
  const entryByMnemonicAndMode = new Map<string, { opcode: number; illegal: boolean }>();

  for (const entry of OPCODE_INVENTORY) {
    const mode = OPCODE_MODE_TO_ADDRESSING_MODE[entry.mode];
    const key = `${entry.mnemonic}\u0000${mode}`;
    const existing = entryByMnemonicAndMode.get(key);

    // The inventory is sorted by opcode, but assembly should prefer official
    // encodings over undocumented aliases for duplicate mnemonic/mode pairs.
    if (existing && (!existing.illegal || entry.illegal)) {
      continue;
    }

    entryByMnemonicAndMode.set(key, { opcode: entry.opcode, illegal: entry.illegal });
    if (!table.has(entry.mnemonic)) {
      table.set(entry.mnemonic, new Map());
    }
    table.get(entry.mnemonic)!.set(mode, entry.opcode);
  }

  return table;
}

const INSTRUCTION_TABLE: Map<string, Map<AddressingMode, number>> = buildInstructionTable();

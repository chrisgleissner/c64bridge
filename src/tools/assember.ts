/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";

export interface AssembleOptions {
  /**
   * Optional default load address used when no ORG or `* =` directive appears.
   * Defaults to $0801 so that the output PRG can be run with SYS 2061.
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
  | { kind: "number"; value: number }
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

type DirectiveName = "org" | "byte" | "word" | "reserve" | "include";

type DirectiveArg =
  | { kind: "expr"; expr: Expression }
  | { kind: "string"; value: string };

type Operand =
  | { kind: "none" }
  | { kind: "immediate"; expr: Expression }
  | { kind: "expression"; expr: Expression; register?: "X" | "Y" }
  | { kind: "indirect"; expr: Expression; register?: "X" | "Y" }
  | { kind: "accumulator" };

type Expression =
  | { type: "number"; value: number }
  | { type: "symbol"; name: string }
  | { type: "unary"; op: UnaryOperator; operand: Expression }
  | { type: "binary"; op: BinaryOperator; left: Expression; right: Expression };

type UnaryOperator = "-" | "+" | "!" | "~";
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
  Absolute = "absolute",
  AbsoluteX = "absoluteX",
  AbsoluteY = "absoluteY",
  Indirect = "indirect",
  IndirectX = "indirectX",
  IndirectY = "indirectY",
  Relative = "relative",
}

interface InstructionInfo {
  mnemonic: string;
  mode: AddressingMode;
  opcode: number;
}

const DEFAULT_LOAD_ADDRESS = 0x0801;
const MAX_ADDRESS = 0xffff;

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
  ".INCLUDE": "include",
  "INCLUDE": "include",
};

const RELATIVE_ONLY = new Set<string>(["BCC", "BCS", "BEQ", "BMI", "BNE", "BPL", "BVC", "BVS"]);


export interface AssemblyResult {
  readonly prg: Buffer;
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
  const resolver = options?.resolveInclude;

  const parser = new Parser(resolver);
  const statements = parser.parse(normalized, rootFile);

  const assembler = new Assembler(statements, loadAddress);
  assembler.runPass(0);
  assembler.runPass(1);

  return { prg: assembler.buildPrg(), symbols: assembler.getSymbols() };
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
      const tokens = tokenize(originalLine);
      if (tokens.length === 0) {
        continue;
      }

      const stream = new TokenStream(tokens);
      const labels: string[] = [];

      while (stream.peek()?.kind === "symbol" && stream.peek(1)?.kind === "punct" && stream.peek(1)!.value === ":") {
        labels.push(stream.consumeSymbol());
        stream.consumePunct(":");
      }

      const statement = this.parseStatement(stream, location, includeStack, statements);

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
        case "byte":
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
  if (token.kind === "punct" && (token.value === "+" || token.value === "-" || token.value === "!" || token.value === "~")) {
    const operand = parseUnaryExpression(stream, terminators);
    return { type: "unary", op: token.value as UnaryOperator, operand };
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
    const expr = parseExpression(stream, new Set<string>([")"]));
    stream.consumePunct(")", "Expected ')' to close indirect operand");

    if (stream.isAtEnd()) {
      return { kind: "indirect", expr };
    }

    const next = stream.peek();
    if (next && next.kind === "punct" && next.value === ",") {
      stream.consumePunct(",");
      const register = stream.consumeSymbol("Expected X or Y after comma").toUpperCase();
      if (register === "X") {
        return { kind: "indirect", expr, register: "X" };
      }
      if (register === "Y") {
        return { kind: "indirect", expr, register: "Y" };
      }
      throw new Error("Only X or Y are allowed after indirect operand");
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
    const register = stream.consumeSymbol("Expected X or Y after comma").toUpperCase();
    if (register !== "X" && register !== "Y") {
      throw new Error("Only X or Y are allowed after comma");
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
    this.currentScope = undefined;
  }

  setLabel(label: string, value: number): void {
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
    const existing = this.get(label);
    if (existing === undefined) {
      throw new Error(`Symbol "${label}" was not defined in the first pass`);
    }
    if (existing !== expected) {
      throw new Error(`Symbol "${label}" changed value between passes (expected ${formatHex(existing)}, got ${formatHex(expected)})`);
    }
    if (!label.startsWith(".")) {
      this.currentScope = label;
    }
  }

  setAssignment(label: string, value: number): void {
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
  private pc = 0;
  private loadAddress: number;
  private lowestWritten = MAX_ADDRESS;
  private highestWritten = 0;

  constructor(private readonly lines: ParsedLine[], defaultLoadAddress: number) {
    this.loadAddress = defaultLoadAddress;
    this.symbolTable.reset();
  }

  runPass(pass: 0 | 1): void {
    this.pc = 0;
    if (pass === 0) {
      this.symbolTable.reset();
      this.lowestWritten = MAX_ADDRESS;
      this.highestWritten = 0;
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

  buildPrg(): Buffer {
    if (this.lowestWritten === MAX_ADDRESS || this.highestWritten < this.loadAddress) {
      return Buffer.alloc(0);
    }
    const start = Math.min(this.lowestWritten, this.loadAddress);
    const end = this.highestWritten;
    const body = this.memory.subarray(start, end + 1);
    const header = Buffer.alloc(2);
    header.writeUInt16LE(start, 0);
    return Buffer.concat([header, Buffer.from(body)]);
  }

  getSymbols(): ReadonlyMap<string, number> {
    return this.symbolTable.allGlobals();
  }

  private processLine(line: ParsedLine, pass: 0 | 1): void {
    for (const label of line.labels) {
      if (pass === 0) {
        this.symbolTable.setLabel(label, this.pc);
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
      throw new AssemblyError("Assignment depends on an undefined symbol", location);
    }
    if (statement.isLocationCounter) {
      this.pc = value & 0xffff;
      if (pass === 0) {
        this.loadAddress = this.pc;
      }
    } else if (pass === 0) {
      this.symbolTable.setAssignment(statement.target, value);
    } else {
      this.symbolTable.ensureLabel(statement.target, value);
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
          throw new AssemblyError("org directive requires a defined value", location);
        }
        this.pc = value & 0xffff;
        if (pass === 0) {
          this.loadAddress = this.pc;
        }
        break;
      }
      case "byte": {
        for (const arg of statement.args) {
          if (arg.kind === "string") {
            if (pass === 1) {
              for (const char of arg.value) {
                this.writeByte(char.charCodeAt(0), location);
              }
            } else {
              this.pc += arg.value.length;
            }
          } else {
            const value = this.evaluate(arg.expr, pass, location);
            if (pass === 1) {
              if (value === undefined) {
                throw new AssemblyError("byte directive contains undefined expression", location);
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
                this.writeWord(char.charCodeAt(0), location);
              }
            } else {
              this.pc += arg.value.length * 2;
            }
          } else {
            const value = this.evaluate(arg.expr, pass, location);
            if (value === undefined) {
              if (pass === 1) {
                throw new AssemblyError("word directive contains undefined expression", location);
              }
              this.pc += 2;
            } else if (pass === 1) {
              this.writeWord(value, location);
            } else {
              this.pc += 2;
            }
          }
        }
        break;
      }
      case "reserve": {
        if (statement.args.length !== 1 || statement.args[0]?.kind !== "expr") {
          throw new AssemblyError("reserve directive expects a single expression", location);
        }
        const amount = this.evaluate(statement.args[0]?.expr, pass, location);
        if (amount === undefined) {
          throw new AssemblyError("reserve directive requires a defined value", location);
        }
        if (amount < 0) {
          throw new AssemblyError("reserve directive requires a non-negative size", location);
        }
        if (pass === 1) {
          for (let i = 0; i < amount; i += 1) {
            this.writeByte(0, location);
          }
        } else {
          this.pc += amount;
        }
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
      this.pc += info.size;
      return;
    }

    if (modeExpectsValue(info.mode) && info.value === undefined) {
      throw new AssemblyError("Undefined expression", location);
    }

    const opcode = lookupOpcode(statement.mnemonic, info.mode, location);
    this.writeByte(opcode, location);

    switch (info.mode) {
      case AddressingMode.Immediate:
      case AddressingMode.ZeroPage:
      case AddressingMode.ZeroPageX:
      case AddressingMode.ZeroPageY:
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
            return ~value;
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
            return left << right;
          case ">>":
            return left >> right;
          case "&":
            return left & right;
          case "|":
            return left | right;
          case "^":
            return left ^ right;
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
    const masked = value & 0xff;
    this.memory[this.pc] = masked;
    this.written[this.pc] = 1;
    this.lowestWritten = Math.min(this.lowestWritten, this.pc);
    this.highestWritten = Math.max(this.highestWritten, this.pc);
    this.pc = (this.pc + 1) & 0xffff;
  }

  private writeWord(value: number, location: SourceLocation): void {
    const masked = value & 0xffff;
    this.writeByte(masked & 0xff, location);
    this.writeByte((masked >> 8) & 0xff, location);
  }
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
        if (available.has(AddressingMode.ZeroPageX) && value !== undefined && fitsByte(value)) {
          return AddressingMode.ZeroPageX;
        }
        if (available.has(AddressingMode.AbsoluteX)) {
          return AddressingMode.AbsoluteX;
        }
      } else if (register === "Y") {
        if (available.has(AddressingMode.ZeroPageY) && value !== undefined && fitsByte(value)) {
          return AddressingMode.ZeroPageY;
        }
        if (available.has(AddressingMode.AbsoluteY)) {
          return AddressingMode.AbsoluteY;
        }
      } else {
        if (available.has(AddressingMode.ZeroPage) && value !== undefined && fitsByte(value)) {
          return AddressingMode.ZeroPage;
        }
        if (available.has(AddressingMode.Absolute)) {
          return AddressingMode.Absolute;
        }
      }

      if (available.has(AddressingMode.Absolute)) {
        return AddressingMode.Absolute;
      }
      throw new AssemblyError(`Instruction ${mnemonic} cannot resolve addressing mode`, location);
    }
    default:
      throw new AssemblyError("Unsupported operand kind", location);
  }
}

function instructionSize(mode: AddressingMode): number {
  switch (mode) {
    case AddressingMode.Implied:
    case AddressingMode.Accumulator:
      return 1;
    case AddressingMode.Immediate:
    case AddressingMode.ZeroPage:
    case AddressingMode.ZeroPageX:
    case AddressingMode.ZeroPageY:
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

function buildInstructionTable(): Map<string, Map<AddressingMode, number>> {
  const table = new Map<string, Map<AddressingMode, number>>();
  for (const entry of INSTRUCTION_DATA) {
    const mnemonic = entry.mnemonic;
    if (!table.has(mnemonic)) {
      table.set(mnemonic, new Map());
    }
    table.get(mnemonic)!.set(entry.mode, entry.opcode);
  }
  return table;
}

const INSTRUCTION_DATA: InstructionInfo[] = [
  { mnemonic: "ADC", mode: AddressingMode.Immediate, opcode: 0x69 },
  { mnemonic: "ADC", mode: AddressingMode.ZeroPage, opcode: 0x65 },
  { mnemonic: "ADC", mode: AddressingMode.ZeroPageX, opcode: 0x75 },
  { mnemonic: "ADC", mode: AddressingMode.Absolute, opcode: 0x6d },
  { mnemonic: "ADC", mode: AddressingMode.AbsoluteX, opcode: 0x7d },
  { mnemonic: "ADC", mode: AddressingMode.AbsoluteY, opcode: 0x79 },
  { mnemonic: "ADC", mode: AddressingMode.IndirectX, opcode: 0x61 },
  { mnemonic: "ADC", mode: AddressingMode.IndirectY, opcode: 0x71 },
  { mnemonic: "AND", mode: AddressingMode.Immediate, opcode: 0x29 },
  { mnemonic: "AND", mode: AddressingMode.ZeroPage, opcode: 0x25 },
  { mnemonic: "AND", mode: AddressingMode.ZeroPageX, opcode: 0x35 },
  { mnemonic: "AND", mode: AddressingMode.Absolute, opcode: 0x2d },
  { mnemonic: "AND", mode: AddressingMode.AbsoluteX, opcode: 0x3d },
  { mnemonic: "AND", mode: AddressingMode.AbsoluteY, opcode: 0x39 },
  { mnemonic: "AND", mode: AddressingMode.IndirectX, opcode: 0x21 },
  { mnemonic: "AND", mode: AddressingMode.IndirectY, opcode: 0x31 },
  { mnemonic: "ASL", mode: AddressingMode.Accumulator, opcode: 0x0a },
  { mnemonic: "ASL", mode: AddressingMode.ZeroPage, opcode: 0x06 },
  { mnemonic: "ASL", mode: AddressingMode.ZeroPageX, opcode: 0x16 },
  { mnemonic: "ASL", mode: AddressingMode.Absolute, opcode: 0x0e },
  { mnemonic: "ASL", mode: AddressingMode.AbsoluteX, opcode: 0x1e },
  { mnemonic: "BIT", mode: AddressingMode.ZeroPage, opcode: 0x24 },
  { mnemonic: "BIT", mode: AddressingMode.Absolute, opcode: 0x2c },
  { mnemonic: "BPL", mode: AddressingMode.Relative, opcode: 0x10 },
  { mnemonic: "BMI", mode: AddressingMode.Relative, opcode: 0x30 },
  { mnemonic: "BVC", mode: AddressingMode.Relative, opcode: 0x50 },
  { mnemonic: "BVS", mode: AddressingMode.Relative, opcode: 0x70 },
  { mnemonic: "BCC", mode: AddressingMode.Relative, opcode: 0x90 },
  { mnemonic: "BCS", mode: AddressingMode.Relative, opcode: 0xb0 },
  { mnemonic: "BNE", mode: AddressingMode.Relative, opcode: 0xd0 },
  { mnemonic: "BEQ", mode: AddressingMode.Relative, opcode: 0xf0 },
  { mnemonic: "BRK", mode: AddressingMode.Implied, opcode: 0x00 },
  { mnemonic: "CLC", mode: AddressingMode.Implied, opcode: 0x18 },
  { mnemonic: "CLD", mode: AddressingMode.Implied, opcode: 0xd8 },
  { mnemonic: "CLI", mode: AddressingMode.Implied, opcode: 0x58 },
  { mnemonic: "CLV", mode: AddressingMode.Implied, opcode: 0xb8 },
  { mnemonic: "CMP", mode: AddressingMode.Immediate, opcode: 0xc9 },
  { mnemonic: "CMP", mode: AddressingMode.ZeroPage, opcode: 0xc5 },
  { mnemonic: "CMP", mode: AddressingMode.ZeroPageX, opcode: 0xd5 },
  { mnemonic: "CMP", mode: AddressingMode.Absolute, opcode: 0xcd },
  { mnemonic: "CMP", mode: AddressingMode.AbsoluteX, opcode: 0xdd },
  { mnemonic: "CMP", mode: AddressingMode.AbsoluteY, opcode: 0xd9 },
  { mnemonic: "CMP", mode: AddressingMode.IndirectX, opcode: 0xc1 },
  { mnemonic: "CMP", mode: AddressingMode.IndirectY, opcode: 0xd1 },
  { mnemonic: "CPX", mode: AddressingMode.Immediate, opcode: 0xe0 },
  { mnemonic: "CPX", mode: AddressingMode.ZeroPage, opcode: 0xe4 },
  { mnemonic: "CPX", mode: AddressingMode.Absolute, opcode: 0xec },
  { mnemonic: "CPY", mode: AddressingMode.Immediate, opcode: 0xc0 },
  { mnemonic: "CPY", mode: AddressingMode.ZeroPage, opcode: 0xc4 },
  { mnemonic: "CPY", mode: AddressingMode.Absolute, opcode: 0xcc },
  { mnemonic: "DEC", mode: AddressingMode.ZeroPage, opcode: 0xc6 },
  { mnemonic: "DEC", mode: AddressingMode.ZeroPageX, opcode: 0xd6 },
  { mnemonic: "DEC", mode: AddressingMode.Absolute, opcode: 0xce },
  { mnemonic: "DEC", mode: AddressingMode.AbsoluteX, opcode: 0xde },
  { mnemonic: "DEX", mode: AddressingMode.Implied, opcode: 0xca },
  { mnemonic: "DEY", mode: AddressingMode.Implied, opcode: 0x88 },
  { mnemonic: "EOR", mode: AddressingMode.Immediate, opcode: 0x49 },
  { mnemonic: "EOR", mode: AddressingMode.ZeroPage, opcode: 0x45 },
  { mnemonic: "EOR", mode: AddressingMode.ZeroPageX, opcode: 0x55 },
  { mnemonic: "EOR", mode: AddressingMode.Absolute, opcode: 0x4d },
  { mnemonic: "EOR", mode: AddressingMode.AbsoluteX, opcode: 0x5d },
  { mnemonic: "EOR", mode: AddressingMode.AbsoluteY, opcode: 0x59 },
  { mnemonic: "EOR", mode: AddressingMode.IndirectX, opcode: 0x41 },
  { mnemonic: "EOR", mode: AddressingMode.IndirectY, opcode: 0x51 },
  { mnemonic: "INC", mode: AddressingMode.ZeroPage, opcode: 0xe6 },
  { mnemonic: "INC", mode: AddressingMode.ZeroPageX, opcode: 0xf6 },
  { mnemonic: "INC", mode: AddressingMode.Absolute, opcode: 0xee },
  { mnemonic: "INC", mode: AddressingMode.AbsoluteX, opcode: 0xfe },
  { mnemonic: "INX", mode: AddressingMode.Implied, opcode: 0xe8 },
  { mnemonic: "INY", mode: AddressingMode.Implied, opcode: 0xc8 },
  { mnemonic: "JMP", mode: AddressingMode.Absolute, opcode: 0x4c },
  { mnemonic: "JMP", mode: AddressingMode.Indirect, opcode: 0x6c },
  { mnemonic: "JSR", mode: AddressingMode.Absolute, opcode: 0x20 },
  { mnemonic: "LDA", mode: AddressingMode.Immediate, opcode: 0xa9 },
  { mnemonic: "LDA", mode: AddressingMode.ZeroPage, opcode: 0xa5 },
  { mnemonic: "LDA", mode: AddressingMode.ZeroPageX, opcode: 0xb5 },
  { mnemonic: "LDA", mode: AddressingMode.Absolute, opcode: 0xad },
  { mnemonic: "LDA", mode: AddressingMode.AbsoluteX, opcode: 0xbd },
  { mnemonic: "LDA", mode: AddressingMode.AbsoluteY, opcode: 0xb9 },
  { mnemonic: "LDA", mode: AddressingMode.IndirectX, opcode: 0xa1 },
  { mnemonic: "LDA", mode: AddressingMode.IndirectY, opcode: 0xb1 },
  { mnemonic: "LDX", mode: AddressingMode.Immediate, opcode: 0xa2 },
  { mnemonic: "LDX", mode: AddressingMode.ZeroPage, opcode: 0xa6 },
  { mnemonic: "LDX", mode: AddressingMode.ZeroPageY, opcode: 0xb6 },
  { mnemonic: "LDX", mode: AddressingMode.Absolute, opcode: 0xae },
  { mnemonic: "LDX", mode: AddressingMode.AbsoluteY, opcode: 0xbe },
  { mnemonic: "LDY", mode: AddressingMode.Immediate, opcode: 0xa0 },
  { mnemonic: "LDY", mode: AddressingMode.ZeroPage, opcode: 0xa4 },
  { mnemonic: "LDY", mode: AddressingMode.ZeroPageX, opcode: 0xb4 },
  { mnemonic: "LDY", mode: AddressingMode.Absolute, opcode: 0xac },
  { mnemonic: "LDY", mode: AddressingMode.AbsoluteX, opcode: 0xbc },
  { mnemonic: "LSR", mode: AddressingMode.Accumulator, opcode: 0x4a },
  { mnemonic: "LSR", mode: AddressingMode.ZeroPage, opcode: 0x46 },
  { mnemonic: "LSR", mode: AddressingMode.ZeroPageX, opcode: 0x56 },
  { mnemonic: "LSR", mode: AddressingMode.Absolute, opcode: 0x4e },
  { mnemonic: "LSR", mode: AddressingMode.AbsoluteX, opcode: 0x5e },
  { mnemonic: "NOP", mode: AddressingMode.Implied, opcode: 0xea },
  { mnemonic: "ORA", mode: AddressingMode.Immediate, opcode: 0x09 },
  { mnemonic: "ORA", mode: AddressingMode.ZeroPage, opcode: 0x05 },
  { mnemonic: "ORA", mode: AddressingMode.ZeroPageX, opcode: 0x15 },
  { mnemonic: "ORA", mode: AddressingMode.Absolute, opcode: 0x0d },
  { mnemonic: "ORA", mode: AddressingMode.AbsoluteX, opcode: 0x1d },
  { mnemonic: "ORA", mode: AddressingMode.AbsoluteY, opcode: 0x19 },
  { mnemonic: "ORA", mode: AddressingMode.IndirectX, opcode: 0x01 },
  { mnemonic: "ORA", mode: AddressingMode.IndirectY, opcode: 0x11 },
  { mnemonic: "PHA", mode: AddressingMode.Implied, opcode: 0x48 },
  { mnemonic: "PHP", mode: AddressingMode.Implied, opcode: 0x08 },
  { mnemonic: "PLA", mode: AddressingMode.Implied, opcode: 0x68 },
  { mnemonic: "PLP", mode: AddressingMode.Implied, opcode: 0x28 },
  { mnemonic: "ROL", mode: AddressingMode.Accumulator, opcode: 0x2a },
  { mnemonic: "ROL", mode: AddressingMode.ZeroPage, opcode: 0x26 },
  { mnemonic: "ROL", mode: AddressingMode.ZeroPageX, opcode: 0x36 },
  { mnemonic: "ROL", mode: AddressingMode.Absolute, opcode: 0x2e },
  { mnemonic: "ROL", mode: AddressingMode.AbsoluteX, opcode: 0x3e },
  { mnemonic: "ROR", mode: AddressingMode.Accumulator, opcode: 0x6a },
  { mnemonic: "ROR", mode: AddressingMode.ZeroPage, opcode: 0x66 },
  { mnemonic: "ROR", mode: AddressingMode.ZeroPageX, opcode: 0x76 },
  { mnemonic: "ROR", mode: AddressingMode.Absolute, opcode: 0x6e },
  { mnemonic: "ROR", mode: AddressingMode.AbsoluteX, opcode: 0x7e },
  { mnemonic: "RTI", mode: AddressingMode.Implied, opcode: 0x40 },
  { mnemonic: "RTS", mode: AddressingMode.Implied, opcode: 0x60 },
  { mnemonic: "SBC", mode: AddressingMode.Immediate, opcode: 0xe9 },
  { mnemonic: "SBC", mode: AddressingMode.ZeroPage, opcode: 0xe5 },
  { mnemonic: "SBC", mode: AddressingMode.ZeroPageX, opcode: 0xf5 },
  { mnemonic: "SBC", mode: AddressingMode.Absolute, opcode: 0xed },
  { mnemonic: "SBC", mode: AddressingMode.AbsoluteX, opcode: 0xfd },
  { mnemonic: "SBC", mode: AddressingMode.AbsoluteY, opcode: 0xf9 },
  { mnemonic: "SBC", mode: AddressingMode.IndirectX, opcode: 0xe1 },
  { mnemonic: "SBC", mode: AddressingMode.IndirectY, opcode: 0xf1 },
  { mnemonic: "SEC", mode: AddressingMode.Implied, opcode: 0x38 },
  { mnemonic: "SED", mode: AddressingMode.Implied, opcode: 0xf8 },
  { mnemonic: "SEI", mode: AddressingMode.Implied, opcode: 0x78 },
  { mnemonic: "STA", mode: AddressingMode.ZeroPage, opcode: 0x85 },
  { mnemonic: "STA", mode: AddressingMode.ZeroPageX, opcode: 0x95 },
  { mnemonic: "STA", mode: AddressingMode.Absolute, opcode: 0x8d },
  { mnemonic: "STA", mode: AddressingMode.AbsoluteX, opcode: 0x9d },
  { mnemonic: "STA", mode: AddressingMode.AbsoluteY, opcode: 0x99 },
  { mnemonic: "STA", mode: AddressingMode.IndirectX, opcode: 0x81 },
  { mnemonic: "STA", mode: AddressingMode.IndirectY, opcode: 0x91 },
  { mnemonic: "STX", mode: AddressingMode.ZeroPage, opcode: 0x86 },
  { mnemonic: "STX", mode: AddressingMode.ZeroPageY, opcode: 0x96 },
  { mnemonic: "STX", mode: AddressingMode.Absolute, opcode: 0x8e },
  { mnemonic: "STY", mode: AddressingMode.ZeroPage, opcode: 0x84 },
  { mnemonic: "STY", mode: AddressingMode.ZeroPageX, opcode: 0x94 },
  { mnemonic: "STY", mode: AddressingMode.Absolute, opcode: 0x8c },
  { mnemonic: "TAX", mode: AddressingMode.Implied, opcode: 0xaa },
  { mnemonic: "TAY", mode: AddressingMode.Implied, opcode: 0xa8 },
  { mnemonic: "TSX", mode: AddressingMode.Implied, opcode: 0xba },
  { mnemonic: "TXA", mode: AddressingMode.Implied, opcode: 0x8a },
  { mnemonic: "TXS", mode: AddressingMode.Implied, opcode: 0x9a },
  { mnemonic: "TYA", mode: AddressingMode.Implied, opcode: 0x98 },
];

const INSTRUCTION_TABLE: Map<string, Map<AddressingMode, number>> = buildInstructionTable();

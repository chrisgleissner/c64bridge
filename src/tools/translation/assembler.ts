/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { rangeOverlapsIo } from "../../ioRange.js";
import { parseBraceToken } from "../../petscii.js";
import { OPCODE_INVENTORY } from "./opcodeInventory.js";
import type { OpcodeAddressingMode } from "./opcodeInventory.js";

/*
 * Dialect summary (what an LLM can rely on). Every directive spelling follows the documented
 * meaning in one named assembler; test/hard06AssemblerDifferential.test.mjs holds the bytes of
 * those assemblers for each spelling.
 *  - Labels: "name:" or, in column 0, "name" followed by an instruction, directive or nothing
 *    (ACME, 64tass); a colon-less name alone on a line must be referenced somewhere, otherwise it
 *    is reported as an unknown instruction. ".local:" labels belong to the last global label.
 *    Names are case-sensitive, mnemonics are not.
 *  - Numbers: $hex, 0xhex, %binary, 0bbinary, decimal; "<x" and ">x" take the low and high byte
 *    of the whole rest of the expression (ACME, 64tass, Kick Assembler). Comments: ";" and "//".
 *  - ca65 (cc65 "ca65 Users Guide"): .byte/.byt (strings as written, which is ca65 without a
 *    target character map), .word, .res n[, value] (zero when value is left out), .align n[, fill]
 *    (fill 0), .incbin "file"[, offset[, size]], .include, .if/.else/.endif, .macro/.mac name
 *    params ... .endmacro/.endmac (parameters replaced by their bare names), .repeat n ...
 *    .endrep/.endrepeat (no counter name).
 *  - 64tass (manual at tass64.sourceforge.net): .fill n[, value] (zero when value is left out;
 *    64tass leaves the bytes uninitialised and outputs them as zeros), .rept n ... .endrept, .fi,
 *    .binary "file"[, offset[, length]], "name .macro params" ... .endm/.endmacro called as #name
 *    or .name, with \1-\9, \name, \{name} and \@ (the whole parameter list).
 *  - ACME 0.97 (docs/AllPOs.txt): !byte/!by/!8/!08, !word/!wo/!16, !text/!tx/!txt/!raw (raw, as
 *    without !convtab), !pet, !scr, !fill/!fi (fill 0), !align and, equal[, fill] (fill $EA),
 *    !source/!src, !binary/!bin "file"[, [size][, [skip]]]. See ACME_ENCODERS.
 *  - Kick Assembler 5.25 manual: .by, .wo; .fill n, value with a constant value (the loop
 *    variable i is not supported).
 *  - This assembler's own spellings, documented in data/assembly/assembly-spec.md ("Minimal
 *    Directives"): .text/.ascii fold a-z to the PETSCII letters $41-$5A, turn "\n" into RETURN
 *    ($0D) and accept {name}/{$xx} control codes, so .text "a" is $41 while 'a' is $61. 64tass
 *    emits ASCII and Kick Assembler screen codes for .text, so lowercase letters in .text add a
 *    warning. Also .org/org, .db/db, .dw/dw (a 16-bit word; in Kick Assembler .dw is a 32-bit
 *    .dword), .ds/ds/res, .equ, byte, word, include.
 *  - Strings take the escapes \0 \t \n \r \xNN \\ \" \' (the set of ACME 0.97).
 *  - Unsupported spellings fail with SUPPORTED_DIRECTIVES; .scr, .screen, .petscii and .endr are
 *    not documented by these assemblers and fail with the spelling to use instead.
 */
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
  /**
   * Resolver invoked for `.incbin "path"[, offset[, length]]` (also `!binary`). It returns the
   * file bytes; without it `.incbin` is an error. The tools do not provide one.
   */
  resolveIncbin?: (requestedPath: string, fromFile: string) => Uint8Array;
}

export class AssemblyError extends Error {
  constructor(message: string, readonly location: SourceLocation) {
    const where = `${location.file}:${location.line}${location.context ? ` (in ${location.context})` : ""}`;
    const shown = location.text.trim();
    super(`${where}: ${message}${shown ? `\n    ${shown.length > 160 ? `${shown.slice(0, 157)}...` : shown}` : ""}`);
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
  /** Set for lines produced by a macro or repeat expansion, for example "macro wait". */
  context?: string;
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

type DirectiveName =
  | "org" | "byte" | "word" | "text" | "fill" | "align" | "alignmask" | "equ" | "reserve" | "include" | "incbin"
  | "acmeText" | "acmePet" | "acmeScr" | "acmeBinary"
  | "if" | "else" | "endif";

type DirectiveArg =
  | { kind: "expr"; expr: Expression }
  | { kind: "string"; value: string }
  /** An argument left out between commas, as in ACME's !binary "file",, 9. */
  | { kind: "none" };

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
/** A zero-filled gap or trailing .res at least this long is reported in AssemblyResult.warnings. */
const LARGE_FILL_WARNING_BYTES = 1024;
const INT32_MIN = -0x80000000;
const UINT32_MAX = 0xffffffff;

// "{" and "}" are tokens only so that block syntax such as ACME's "!macro m {" reaches the
// unsupported-directive message; no statement accepts them.
const SINGLE_CHAR_TOKENS = new Set<string>([",", ":", "#", "(", ")", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "=", "!", "~", "{", "}"]);

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
  ".BYT": "byte",
  ".BY": "byte",
  "BYTE": "byte",
  "DB": "byte",
  ".DB": "byte",
  "!BYTE": "byte",
  "!BY": "byte",
  "!8": "byte",
  ".WORD": "word",
  ".WO": "word",
  "WORD": "word",
  "DW": "word",
  ".DW": "word",
  "!WORD": "word",
  "!WO": "word",
  "!16": "word",
  ".RES": "reserve",
  "RES": "reserve",
  ".DS": "reserve",
  "DS": "reserve",
  ".EQU": "equ",
  ".FILL": "fill",
  "!FILL": "fill",
  "!FI": "fill",
  ".ALIGN": "align",
  "!ALIGN": "alignmask",
  ".TEXT": "text",
  ".ASCII": "text",
  // ACME, docs/AllPOs.txt of ACME 0.97: !text uses the current conversion table, which is "raw"
  // because !convtab is not supported; !pet and !scr use the fixed PETSCII and screen-code tables.
  "!TEXT": "acmeText",
  "!TX": "acmeText",
  "!TXT": "acmeText",
  "!RAW": "acmeText",
  "!PET": "acmePet",
  "!SCR": "acmeScr",
  ".INCLUDE": "include",
  "INCLUDE": "include",
  "!SOURCE": "include",
  "!SRC": "include",
  ".INCBIN": "incbin",
  ".BINARY": "incbin",
  "!BINARY": "acmeBinary",
  "!BIN": "acmeBinary",
  ".IF": "if",
  ".ELSE": "else",
  ".ENDIF": "endif",
  ".FI": "endif",
};

/** Spellings that no supported assembler documents with this meaning, and what to write instead. */
const REMOVED_DIRECTIVES: Record<string, string> = {
  ".SCR": "use !scr (ACME screen codes)",
  ".SCREEN": "use !scr (ACME screen codes)",
  ".PETSCII": "use !pet (ACME PETSCII) or .text",
  ".ENDR": "use .endrept (64tass) or .endrep (ca65)",
};

/** Shown with "unsupported directive": every spelling the assembler accepts, grouped by meaning. */
const SUPPORTED_DIRECTIVES =
  ".org/org/* = ; .byte/.byt/.by/.db/!byte/!by/!8/!08 ; .word/.wo/.dw/!word/!wo/!16 ; .text/.ascii ; !text/!tx/!txt/!raw ; !pet ; !scr ; " +
  ".fill/!fill/!fi ; .align ; !align ; .res/.ds ; .equ/name = value ; .include/!source/!src ; .incbin/.binary ; !binary/!bin ; " +
  ".if/.else/.endif/.fi ; .macro/.mac name params ... .endmacro/.endmac/.endm ; name .macro params ... .endm ; " +
  ".repeat n ... .endrep/.endrepeat ; .rept n ... .endrept";

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
  /**
   * Things that are legal but probably not intended, for the caller to show: a large zero-filled
   * gap between output blocks, a trailing `.res` that enlarges the PRG, or an empty image.
   */
  readonly warnings: readonly string[];
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

  const labelWarnings = checkBareLabels(parser.bareLabels, statements);

  const assembler = new Assembler(statements, loadAddress, options?.resolveIncbin);
  assembler.runPass(0);
  assembler.resolveDeferredAssignments();
  assembler.runPass(1);

  const prg = assembler.buildPrg();
  const loadAddressOfPrg = prg.length >= 2 ? prg.readUInt16LE(0) : loadAddress;
  const stubTarget = prg.length >= 2 ? prgEntryAddress(prg) : loadAddressOfPrg;
  const entryAddress = stubTarget !== loadAddressOfPrg
    ? stubTarget
    : assembler.getFirstInstructionAddress() ?? loadAddressOfPrg;
  return { prg, symbols: assembler.getSymbols(), entryAddress, warnings: [...labelWarnings, ...assembler.getWarnings()] };
}

/** Every symbol name an expression of the program refers to. */
function referencedSymbols(statements: readonly ParsedLine[]): Set<string> {
  const names = new Set<string>();
  const visit = (expr: Expression): void => {
    if (expr.type === "symbol") names.add(expr.name);
    else if (expr.type === "unary") visit(expr.operand);
    else if (expr.type === "binary") {
      visit(expr.left);
      visit(expr.right);
    }
  };
  for (const { statement } of statements) {
    if (!statement) continue;
    if (statement.kind === "assignment") visit(statement.expr);
    else if (statement.kind === "instruction") {
      if ("expr" in statement.operand) visit(statement.operand.expr);
    } else {
      for (const arg of statement.args) if (arg.kind === "expr") visit(arg.expr);
    }
  }
  return names;
}

/**
 * A name in column 0 without a colon is a label, as in ACME and 64tass, but a misspelt mnemonic
 * looks the same ("rts2"). A name that nothing refers to is an error when it stands alone, so no
 * instruction is lost silently, and a warning when a statement follows it.
 */
function checkBareLabels(bareLabels: Parser["bareLabels"], statements: readonly ParsedLine[]): string[] {
  if (bareLabels.length === 0) return [];
  const used = referencedSymbols(statements);
  const warnings: string[] = [];
  for (const { name, location, alone } of bareLabels) {
    if (used.has(name)) continue;
    if (alone) {
      throw new AssemblyError(
        `Unknown instruction "${name}": a name alone in column 0 that nothing refers to is not taken as a label; write "${name}:" if it is one`,
        location,
      );
    }
    warnings.push(
      `${location.file}:${location.line}: "${name}" in column 0 is taken as a label without a colon and nothing refers to it; if it is a misspelt instruction, that instruction is missing (write "${name}:" to silence this)`,
    );
  }
  return warnings;
}

function normalizeSource(input: string): string {
  return input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

interface SourceLine {
  text: string;
  line: number;
  context?: string;
}

interface MacroDefinition {
  name: string;
  params: string[];
  /**
   * "ca65": ".macro name a, b", parameters are replaced where their bare names appear.
   * "64tass": "name .macro a, b", parameters are referenced only as \name or \{name}.
   */
  style: "ca65" | "64tass";
  body: SourceLine[];
  location: SourceLocation;
}

const MAX_EXPANDED_LINES = 100_000;
const MAX_NESTING_DEPTH = 16;
const MAX_REPEAT_COUNT = 65_536;

const BLOCK_CLOSERS: Record<string, { opens: string[]; closes: string[] }> = {
  // ca65: .macro/.mac ... .endmacro/.endmac; 64tass: .macro ... .endm/.endmacro.
  macro: { opens: [".MACRO", ".MAC"], closes: [".ENDMACRO", ".ENDMAC", ".ENDM"] },
  // ca65: .repeat ... .endrep/.endrepeat; 64tass: .rept ... .endrept.
  repeat: { opens: [".REPEAT", ".REPT"], closes: [".ENDREPEAT", ".ENDREP", ".ENDREPT"] },
};

/** Upper-cased first directive of a line (after any "label:" prefixes), or undefined. */
function leadingDirective(text: string): string | undefined {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return undefined;
  }
  let index = 0;
  while (tokens[index]?.kind === "symbol" && tokens[index + 1]?.kind === "punct" && tokens[index + 1]!.value === ":") {
    index += 2;
  }
  // 64tass names a macro in column 0 before the directive: "name .macro".
  if (index === 0 && /^[A-Za-z_]/.test(text) && tokens[1]?.kind === "symbol" && tokens[1].value.toUpperCase() === ".MACRO") {
    index = 1;
  }
  const head = tokens[index];
  return head?.kind === "symbol" && head.value.startsWith(".") ? head.value.toUpperCase() : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text before a ";" or "//" comment that is outside quotes. */
function withoutComment(text: string): string {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ";" || (char === "/" && text[index + 1] === "/")) return text.slice(0, index);
  }
  return text;
}

/** Splits macro call arguments at top-level commas; a trailing comment is dropped. */
function splitMacroArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      current += char;
      if (char === "\\" && index + 1 < text.length) {
        current += text[index + 1];
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ";" || (char === "/" && text[index + 1] === "/")) {
      break;
    } else if (char === "(") {
      depth += 1;
      current += char;
    } else if (char === ")") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "" || args.length > 0) args.push(current.trim());
  return args;
}

/**
 * Replaces macro parameter references in one body line: `\1`..`\9` (positional), `\name` and
 * `\{name}` (64tass), `\@` (64tass: the whole parameter list as written) and, for ca65-style
 * macros, the bare parameter names outside strings and comments. `\` followed by anything else is
 * left alone, so string escapes such as `\n` keep working. `allArgs` is undefined in a repeat body.
 */
function substituteMacroText(
  text: string,
  params: readonly string[],
  args: readonly string[],
  allArgs: string | undefined,
  bareNames: boolean,
): string {
  let out = "";
  let quote: string | undefined;
  let comment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length && !comment) {
      const next = text[index + 1]!;
      if (next === "@") {
        if (allArgs === undefined) throw new Error("\\@ (the macro parameter list) is only valid inside a macro");
        out += allArgs;
        index += 1;
        continue;
      }
      if (next >= "1" && next <= "9") {
        out += args[Number(next) - 1] ?? "";
        index += 1;
        continue;
      }
      const braced = next === "{";
      const nameStart = index + (braced ? 2 : 1);
      let nameEnd = nameStart;
      while (nameEnd < text.length && isSymbolPart(text[nameEnd]!) && text[nameEnd] !== ".") nameEnd += 1;
      const name = text.slice(nameStart, nameEnd);
      const position = name !== "" && isSymbolStart(name[0]!) ? params.indexOf(name) : -1;
      if (position >= 0 && (!braced || text[nameEnd] === "}")) {
        out += args[position] ?? "";
        index = braced ? nameEnd : nameEnd - 1;
        continue;
      }
      out += char + next;
      index += 1;
      continue;
    }
    if (comment) {
      out += char;
      continue;
    }
    if (quote) {
      out += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === ";" || (char === "/" && text[index + 1] === "/")) {
      comment = true;
      out += char;
      continue;
    }
    if (isSymbolStart(char)) {
      let end = index + 1;
      while (end < text.length && isSymbolPart(text[end]!)) end += 1;
      const word = text.slice(index, end);
      const position = bareNames ? params.indexOf(word) : -1;
      out += position >= 0 ? args[position] ?? "" : word;
      index = end - 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Evaluates an expression that needs no symbols other than the constants seen so far. */
function evaluateConstantExpression(expr: Expression, constants: ReadonlyMap<string, number>): number | undefined {
  switch (expr.type) {
    case "number":
      return expr.value;
    case "symbol":
      return expr.name === "*" ? undefined : constants.get(expr.name);
    case "unary": {
      const value = evaluateConstantExpression(expr.operand, constants);
      if (value === undefined) return undefined;
      switch (expr.op) {
        case "+": return value;
        case "-": return -value;
        case "!": return value ? 0 : 1;
        case "~": return ~value;
        case "<": return value & 0xff;
        case ">": return (value >> 8) & 0xff;
        default: return undefined;
      }
    }
    case "binary": {
      const left = evaluateConstantExpression(expr.left, constants);
      const right = evaluateConstantExpression(expr.right, constants);
      if (left === undefined || right === undefined) return undefined;
      switch (expr.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return right === 0 ? undefined : Math.trunc(left / right);
        case "%": return right === 0 ? undefined : left % right;
        case "<<": return right >= 0 && right <= 31 ? left << right : undefined;
        case ">>": return right >= 0 && right <= 31 ? left >> right : undefined;
        case "&": return left & right;
        case "|": return left | right;
        case "^": return left ^ right;
        case "==": return left === right ? 1 : 0;
        case "!=": return left !== right ? 1 : 0;
        case "<": return left < right ? 1 : 0;
        case "<=": return left <= right ? 1 : 0;
        case ">": return left > right ? 1 : 0;
        case ">=": return left >= right ? 1 : 0;
        default: return undefined;
      }
    }
    default:
      return undefined;
  }
}

class Parser {
  private readonly macros = new Map<string, MacroDefinition>();
  /** Constants defined so far by `name = expr`, for `.repeat` counts. */
  private readonly constants = new Map<string, number>();
  private expandedLines = 0;
  /** Names taken as labels because they stand in column 0 without a colon. */
  readonly bareLabels: Array<{ name: string; location: SourceLocation; alone: boolean }> = [];

  constructor(
    private readonly includeResolver?: (requestedPath: string, fromFile: string) => string | { contents: string; fileName?: string },
  ) {}

  parse(source: string, fileName: string): ParsedLine[] {
    const statements: ParsedLine[] = [];
    this.parseLines(statements, toSourceLines(source), fileName, [], 0);
    return statements;
  }

  private parseSource(statements: ParsedLine[], source: string, fileName: string, includeStack: string[], depth: number): void {
    this.parseLines(statements, toSourceLines(source), fileName, includeStack, depth);
  }

  /** The index of the line that closes the block opened at `lines[openIndex]`. */
  private findBlockEnd(lines: SourceLine[], openIndex: number, kind: "macro" | "repeat", location: SourceLocation): number {
    const { opens, closes } = BLOCK_CLOSERS[kind]!;
    let depth = 1;
    for (let index = openIndex + 1; index < lines.length; index += 1) {
      const directive = leadingDirective(lines[index]!.text);
      if (directive && opens.includes(directive)) depth += 1;
      else if (directive && closes.includes(directive)) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    throw new AssemblyError(`${kind === "macro" ? ".macro" : ".repeat"} has no matching ${closes[0]!.toLowerCase()}`, location);
  }

  private countExpansion(count: number, location: SourceLocation): void {
    this.expandedLines += count;
    if (this.expandedLines > MAX_EXPANDED_LINES) {
      throw new AssemblyError(`Macro and repeat expansion exceeds ${MAX_EXPANDED_LINES} lines`, location);
    }
  }

  private parseLines(
    statements: ParsedLine[],
    lines: SourceLine[],
    fileName: string,
    includeStack: string[],
    depth: number,
  ): void {
    if (depth > MAX_NESTING_DEPTH) {
      const first = lines[0];
      throw new AssemblyError(`Macro, repeat and include nesting is deeper than ${MAX_NESTING_DEPTH}`, {
        file: fileName,
        line: first?.line ?? 0,
        text: first?.text ?? "",
      });
    }
    for (let index = 0; index < lines.length; index += 1) {
      const source = lines[index]!;
      const originalLine = source.text;
      const location: SourceLocation = { file: fileName, line: source.line, text: originalLine, ...(source.context ? { context: source.context } : {}) };
      let labels: string[] = [];
      let statement: Statement | undefined;
      let expansion: SourceLine[] | undefined;
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

        // 64tass: "name .macro [params]" defines a macro called name.
        const named = stream.peek();
        const afterName = stream.peek(1);
        if (
          labels.length === 0 && named?.kind === "symbol" && /^[A-Za-z_]/.test(originalLine) &&
          afterName?.kind === "symbol" && afterName.value.toUpperCase() === ".MACRO"
        ) {
          stream.consume();
          stream.consume();
          const end = this.findBlockEnd(lines, index, "macro", location);
          this.defineMacro(named.value, "64tass", stream, lines.slice(index + 1, end), location);
          statements.push({ labels, statement: undefined, location });
          index = end;
          continue;
        }

        // A name in column 0 that is neither a mnemonic, a directive, a macro nor an assignment is a
        // label without a colon, as ACME, 64tass and DASM accept.
        const head = stream.peek();
        if (head?.kind === "symbol" && /^[A-Za-z_]/.test(originalLine) && !head.value.startsWith(".")) {
          const upper = head.value.toUpperCase();
          const next = stream.peek(1);
          const isAssignment = (next?.kind === "punct" && next.value === "=") || (next?.kind === "symbol" && next.value.toUpperCase() === ".EQU");
          if (!isAssignment && !INSTRUCTION_TABLE.has(upper) && !(upper in DIRECTIVE_ALIASES) && !this.macros.has(upper)) {
            const nextUpper = next?.kind === "symbol" ? next.value.toUpperCase() : undefined;
            const statementFollows =
              next === undefined ||
              (nextUpper !== undefined &&
                (INSTRUCTION_TABLE.has(nextUpper) || nextUpper in DIRECTIVE_ALIASES || nextUpper.startsWith(".") || this.macros.has(nextUpper))) ||
              (next.kind === "punct" && next.value === "!" && stream.peek(2) !== undefined);
            if (!statementFollows) {
              throw new AssemblyError(
                `Unknown instruction "${head.value}" (a name in column 0 is a label only when an instruction, directive or macro follows it or nothing does; labels may also end with ':')`,
                location,
              );
            }
            this.bareLabels.push({ name: head.value, location, alone: next === undefined });
            labels.push(stream.consumeSymbol());
          }
        }

        const directive = leadingDirectiveOf(stream);
        if (directive === ".MACRO" || directive === ".MAC") {
          stream.consume();
          const nameToken = stream.peek();
          if (nameToken?.kind !== "symbol" || nameToken.value.startsWith(".")) {
            throw new AssemblyError(".macro needs a name: .macro name param1, param2 (ca65) or name .macro param1, param2 (64tass)", location);
          }
          stream.consume();
          const end = this.findBlockEnd(lines, index, "macro", location);
          this.defineMacro(nameToken.value, "ca65", stream, lines.slice(index + 1, end), location);
          statements.push({ labels, statement: undefined, location });
          index = end;
          continue;
        }
        if (directive === ".REPEAT" || directive === ".REPT") {
          stream.consume();
          const expr = parseExpression(stream, new Set<string>([","]));
          if (stream.peek()?.kind === "punct" && stream.peek()!.value === ",") {
            throw new AssemblyError(`${directive.toLowerCase()} with a counter name (ca65 ".repeat count, name") is not supported; use a macro or write the values out`, location);
          }
          stream.expectEnd();
          const count = evaluateConstantExpression(expr, this.constants);
          if (count === undefined || !Number.isInteger(count) || count < 0 || count > MAX_REPEAT_COUNT) {
            throw new AssemblyError(
              `${directive.toLowerCase()} needs a count of 0..${MAX_REPEAT_COUNT} made of numbers and constants defined earlier with "name = value"`,
              location,
            );
          }
          const end = this.findBlockEnd(lines, index, "repeat", location);
          const body = lines.slice(index + 1, end);
          this.countExpansion(count * body.length, location);
          statements.push({ labels, statement: undefined, location });
          for (let iteration = 0; iteration < count; iteration += 1) {
            const expanded = body.map((line) => ({
              text: substituteMacroText(line.text, [], [], undefined, false),
              line: source.line,
              context: source.context ?? "repeat",
            }));
            this.parseLines(statements, expanded, fileName, includeStack, depth + 1);
          }
          index = end;
          continue;
        }
        if (directive !== undefined && BLOCK_CLOSERS.macro!.closes.includes(directive)) {
          throw new AssemblyError(`${directive.toLowerCase()} without a matching .macro`, location);
        }
        if (directive !== undefined && BLOCK_CLOSERS.repeat!.closes.includes(directive)) {
          throw new AssemblyError(`${directive.toLowerCase()} without a matching .repeat or .rept`, location);
        }

        // A macro is called by its name (ca65), or as #name or .name (64tass).
        const macroHead = stream.peek();
        let macroName: string | undefined;
        if (macroHead?.kind === "symbol") {
          macroName = macroHead.value.toUpperCase();
          if (!this.macros.has(macroName) && macroName.startsWith(".")) macroName = macroName.slice(1);
        } else if (macroHead?.kind === "punct" && macroHead.value === "#" && stream.peek(1)?.kind === "symbol") {
          macroName = (stream.peek(1) as { value: string }).value.toUpperCase();
          if (!this.macros.has(macroName)) {
            throw new AssemblyError(`#${(stream.peek(1) as { value: string }).value} calls a macro that is not defined (macros must be defined before use)`, location);
          }
        }
        const macro = macroName !== undefined ? this.macros.get(macroName) : undefined;
        if (macro) {
          expansion = this.expandMacro(macro, originalLine, source, location);
        } else {
          statement = this.parseStatement(stream, location, includeStack, statements, depth);
        }
      } catch (error) {
        // Name the source line for syntax errors as well.
        if (error instanceof AssemblyError) {
          throw error;
        }
        throw new AssemblyError(error instanceof Error ? error.message : String(error), location);
      }

      if (statement?.kind === "assignment" && !statement.isLocationCounter && !statement.target.startsWith(".")) {
        const value = evaluateConstantExpression(statement.expr, this.constants);
        if (value !== undefined) this.constants.set(statement.target, value);
      }
      statements.push({
        labels,
        statement,
        location,
      });
      if (expansion) {
        this.parseLines(statements, expansion, fileName, includeStack, depth + 1);
      }
    }
  }

  private defineMacro(name: string, style: MacroDefinition["style"], stream: TokenStream, body: SourceLine[], location: SourceLocation): void {
    const upper = name.toUpperCase();
    if (INSTRUCTION_TABLE.has(upper) || upper in DIRECTIVE_ALIASES) {
      throw new AssemblyError(`Macro name "${name}" is a mnemonic or directive`, location);
    }
    if (this.macros.has(upper)) {
      throw new AssemblyError(`Macro "${name}" is already defined (line ${this.macros.get(upper)!.location.line})`, location);
    }
    const params: string[] = [];
    if (stream.peek()?.kind === "punct" && stream.peek()!.value === "(") stream.consume();
    while (!stream.isAtEnd()) {
      const token = stream.peek()!;
      if (token.kind === "punct" && (token.value === "," || token.value === ")")) {
        stream.consume();
        continue;
      }
      if (token.kind !== "symbol") {
        throw new AssemblyError(".macro parameters are names separated by commas", location);
      }
      params.push(stream.consumeSymbol());
    }
    this.macros.set(upper, { name, params, style, body, location });
  }

  private expandMacro(macro: MacroDefinition, text: string, source: SourceLine, location: SourceLocation): SourceLine[] {
    // Skip label prefixes and the macro name itself (with the # or . of a 64tass call); the rest is the argument list.
    const afterName = new RegExp(`^\\s*(?:[A-Za-z_.][\\w.]*\\s*:\\s*)*[#.]?${escapeRegExp(macro.name)}(?![\\w.])`, "i").exec(text);
    const rest = afterName ? text.slice(afterName[0].length) : "";
    const args = splitMacroArguments(rest);
    const allArgs = withoutComment(rest).trim();
    // A macro without named parameters takes its arguments as \\1 .. \\9.
    if (macro.params.length > 0 && args.length !== macro.params.length) {
      throw new AssemblyError(
        `Macro ${macro.name} takes ${macro.params.length} argument${macro.params.length === 1 ? "" : "s"} (${macro.params.join(", ") || "none"}), got ${args.length}`,
        location,
      );
    }
    this.countExpansion(macro.body.length, location);
    return macro.body.map((line) => ({
      text: substituteMacroText(line.text, macro.params, args, allArgs, macro.style === "ca65"),
      line: source.line,
      context: `macro ${macro.name}`,
    }));
  }

  private parseStatement(
    stream: TokenStream,
    location: SourceLocation,
    includeStack: string[],
    statements: ParsedLine[],
    depth: number,
  ): Statement | undefined {
    const first = stream.peek();
    if (!first) return undefined;

    if (first.kind === "symbol" && stream.peek(1)?.kind === "punct" && stream.peek(1)!.value === "=") {
      if (first.value.toUpperCase() === ".PC") {
        throw new AssemblyError('unsupported directive .pc (Kick Assembler); use "* = address"', location);
      }
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

    let upper: string;
    if (first.kind === "punct" && first.value === "!" && (stream.peek(1)?.kind === "symbol" || stream.peek(1)?.kind === "number")) {
      // ACME spelling: !byte, !08, !16 ...
      stream.consume();
      const word = stream.consume();
      upper = `!${word.kind === "number" ? String(word.value) : String(word.value).toUpperCase()}`;
    } else {
      if (first.kind !== "symbol") {
        if (first.kind === "punct" && (first.value === "+" || first.value === "-")) {
          throw new AssemblyError("Anonymous labels (+ and -, as in 64tass and ACME) are not supported; use a named label such as \"loop:\"", location);
        }
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

      upper = stream.consumeSymbol().toUpperCase();
    }

    if ((upper.startsWith(".") || upper.startsWith("!")) && !(upper in DIRECTIVE_ALIASES)) {
      const instead = REMOVED_DIRECTIVES[upper] ?? (upper === ".PC" ? 'use "* = address" (Kick Assembler .pc is not supported)' : undefined);
      throw new AssemblyError(
        `unsupported directive ${upper.toLowerCase()}${instead ? ` (${instead})` : ""}; supported: ${SUPPORTED_DIRECTIVES}${upper.startsWith(".") && !instead ? ' (a local label needs a trailing ":")' : ""}`,
        location,
      );
    }

    if (upper in DIRECTIVE_ALIASES) {
      const directive = DIRECTIVE_ALIASES[upper]!;
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
        case "acmeBinary": {
          // ACME: !binary "file" [, [SIZE] [, [SKIP]]]; either value may be left out.
          const path = stream.consumeString("!binary expects a string literal path");
          const args: DirectiveArg[] = [{ kind: "string", value: path }];
          while (stream.peek()?.kind === "punct" && stream.peek()!.value === "," && args.length < 3) {
            stream.consumePunct(",");
            const next = stream.peek();
            args.push(next === undefined || (next.kind === "punct" && next.value === ",")
              ? { kind: "none" }
              : { kind: "expr", expr: parseExpression(stream, new Set<string>([","])) });
          }
          stream.expectEnd();
          return { kind: "directive", name: "acmeBinary", args };
        }
        case "include":
        case "incbin": {
          const path = stream.consumeString(`${directive} expects a string literal path`);
          const args: DirectiveArg[] = [{ kind: "string", value: path }];
          if (directive === "incbin") {
            while (stream.peek()?.kind === "punct" && stream.peek()!.value === "," && args.length < 3) {
              stream.consumePunct(",");
              args.push({ kind: "expr", expr: parseExpression(stream, new Set<string>([","])) });
            }
          }
          stream.expectEnd();
          if (directive === "incbin") {
            return { kind: "directive", name: "incbin", args };
          }

          if (!this.includeResolver) {
            throw new AssemblyError(
              "include needs a resolveInclude option; the MCP tools provide none, so paste the included source into the program",
              location,
            );
          }
          if (includeStack.includes(path)) {
            throw new AssemblyError(`Recursive include detected for "${path}"`, location);
          }
          const resolved = this.includeResolver(path, location.file);
          const includeContent =
            typeof resolved === "string" ? resolved : resolved.contents;
          const includeName =
            typeof resolved === "string" ? path : resolved.fileName ?? path;

          this.parseSource(statements, normalizeSource(includeContent), includeName, [...includeStack, path], depth + 1);
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
        case "if": {
          const expr = parseExpression(stream, new Set<string>());
          stream.expectEnd();
          return { kind: "directive", name: "if", args: [{ kind: "expr", expr }] };
        }
        case "else":
        case "endif":
          stream.expectEnd();
          return { kind: "directive", name: directive, args: [] };
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
        case "alignmask": {
          // ACME: !align ANDVALUE, EQUALVALUE [, FILLVALUE]
          const args: DirectiveArg[] = [];
          for (;;) {
            args.push({ kind: "expr", expr: parseExpression(stream, new Set<string>([","])) });
            if (stream.peek()?.kind === "punct" && stream.peek()!.value === "," && args.length < 3) {
              stream.consumePunct(",");
              continue;
            }
            break;
          }
          stream.expectEnd();
          if (args.length < 2) {
            throw new AssemblyError("!align needs ANDVALUE, EQUALVALUE [, FILLVALUE] (use .align N to align to a multiple of N)", location);
          }
          return { kind: "directive", name: "alignmask", args };
        }
        case "byte":
        case "text":
        case "acmeText":
        case "acmePet":
        case "acmeScr":
        case "word": {
          const args: DirectiveArg[] = [];
          // ACME converts single characters inside a formula with the directive's table: !pet 'a'+1 is $42.
          const charCode = ACME_ENCODERS[directive as AcmeTextDirective];
          while (!stream.isAtEnd()) {
            const next = stream.peek();
            if (!next) break;
            // A one-character string followed by an operator starts an expression: 'A'-64.
            const startsExpression = next.kind === "string" && [...next.value].length === 1 && asBinaryOperator(stream.peek(1)) !== undefined;
            if (next.kind === "string" && !startsExpression) {
              const value = stream.consumeString();
              // ACME's !byte and !word take a string only as one character ("There's more than one character").
              if (upper.startsWith("!") && (directive === "byte" || directive === "word") && [...value].length !== 1) {
                throw new AssemblyError(`${upper.toLowerCase()} takes a string only as a single character, as in ACME; use !text for longer strings`, location);
              }
              args.push({ kind: "string", value });
            } else {
              args.push({ kind: "expr", expr: parseExpression(stream, new Set<string>(), charCode) });
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
          const args: DirectiveArg[] = [{ kind: "expr", expr: parseExpression(stream, new Set<string>([","])) }];
          // ".res n, value" fills n bytes with value, as in ca65.
          if (stream.peek()?.kind === "punct" && stream.peek()!.value === ",") {
            stream.consumePunct(",");
            args.push({ kind: "expr", expr: parseExpression(stream, new Set<string>()) });
          }
          stream.expectEnd();
          return {
            kind: "directive",
            name: "reserve",
            args,
          };
        }
        default:
          throw new AssemblyError(`Unhandled directive ${directive}`, location);
      }
    }

    const mnemonic = upper;
    const operand = parseOperand(stream, mnemonic);
    stream.expectEnd();
    return {
      kind: "instruction",
      mnemonic,
      operand,
    };
  }
}

function toSourceLines(source: string): SourceLine[] {
  return source.split("\n").map((text, index) => ({ text, line: index + 1 }));
}

/** The upper-cased directive at the head of the stream, without consuming it. */
function leadingDirectiveOf(stream: TokenStream): string | undefined {
  const head = stream.peek();
  return head?.kind === "symbol" && head.value.startsWith(".") ? head.value.toUpperCase() : undefined;
}

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const length = line.length;
  while (index < length) {
    const char = line[index] ?? "";

    if (char === ";" || char === "\u201b" || (char === "/" && line[index + 1] === "/")) {
      break;
    }

    if (char === " " || char === "\t" || char === "\u00a0") {
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
          if (escape === "x") {
            const digits = /^[0-9a-fA-F]{2}/.exec(line.slice(index + 2, index + 4));
            if (!digits) {
              throw new Error('Escape \\x needs two hex digits, for example "\\x41"');
            }
            value += String.fromCharCode(parseInt(digits[0], 16));
            index += 4;
            continue;
          }
          value += translateEscape(escape);
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
        throw new Error('Unterminated string literal (a backslash escapes the next character: write \\\\ for one backslash and \\" for a quote)');
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

    const codePoint = line.codePointAt(index) ?? 0;
    throw new Error(`Unexpected character '${codePoint < 0x20 || codePoint === 0x7f ? "" : String.fromCodePoint(codePoint)}' (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`);
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

  mark(): number {
    return this.index;
  }

  reset(mark: number): void {
    this.index = mark;
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
    case "0":
      return "\0";
    default:
      throw new Error(`Unknown escape "\\${char}" in a string; use \\0, \\xNN, \\n, \\r, \\t, \\\\, \\" or \\'`);
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

/** Maps the code of a one-character string in an expression, for ACME's !pet and !scr. */
type CharCodeMapper = (code: number) => number;

function parseExpression(stream: TokenStream, terminators: Set<string>, charCode?: CharCodeMapper): Expression {
  return parseBinaryExpression(stream, terminators, 1, charCode);
}

function parseBinaryExpression(stream: TokenStream, terminators: Set<string>, minPrecedence: number, charCode?: CharCodeMapper): Expression {
  let left = parseUnaryExpression(stream, terminators, charCode);

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
    const right = parseBinaryExpression(stream, terminators, precedence + 1, charCode);
    left = { type: "binary", op, left, right };
  }

  return left;
}

function parseUnaryExpression(stream: TokenStream, terminators: Set<string>, charCode?: CharCodeMapper): Expression {
  const token = stream.consume();
  if (!token) {
    throw new Error("Unexpected end of expression");
  }
  // In operand position, "<" and ">" are byte selectors and "*" is the current
  // PC; parseBinaryExpression consumes them as binary operators elsewhere.
  // As in ACME, 64tass, DASM and Kick Assembler, "<" and ">" apply to the
  // whole rest of the expression: "#>msg+1" is the high byte of msg+1.
  if (token.kind === "punct" && (token.value === "<" || token.value === ">")) {
    const operand = parseBinaryExpression(stream, terminators, 0, charCode);
    return { type: "unary", op: token.value as UnaryOperator, operand };
  }
  if (
    token.kind === "punct" &&
    (token.value === "+" || token.value === "-" || token.value === "!" || token.value === "~")
  ) {
    const operand = parseUnaryExpression(stream, terminators, charCode);
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
    const expr = parseExpression(stream, new Set<string>([")"]), charCode);
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
    const code = token.value.charCodeAt(0);
    return { type: "number", value: charCode && code <= 0xff ? charCode(code) : code };
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

function parseOperand(stream: TokenStream, mnemonic: string): Operand {
  if (stream.isAtEnd()) {
    return { kind: "none" };
  }

  const first = stream.peek();
  if (!first) return { kind: "none" };

  // "bne -" or "bcc ++": a reference to an anonymous label.
  if (first.kind === "punct" && (first.value === "+" || first.value === "-")) {
    let index = 0;
    while (stream.peek(index)?.kind === "punct" && stream.peek(index)!.value === first.value) index += 1;
    if (stream.peek(index) === undefined) {
      throw new Error("Anonymous labels (+ and -, as in 64tass and ACME) are not supported; use a named label");
    }
  }

  // "A" alone is the accumulator for ASL, LSR, ROL and ROR; for every other instruction it is a
  // symbol, so a label named "a" works in "lda a" and "lda a+1".
  if (first.kind === "symbol" && first.value.toUpperCase() === "A" && stream.peek(1) === undefined && INSTRUCTION_TABLE.get(mnemonic)?.has(AddressingMode.Accumulator)) {
    stream.consume();
    return { kind: "accumulator" };
  }

  if (first.kind === "punct" && first.value === "#") {
    stream.consumePunct("#");
    const expr = parseExpression(stream, new Set<string>());
    return { kind: "immediate", expr };
  }

  const parenthesisMark = stream.mark();
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
    if (next && next.kind === "punct" && next.value !== "," && asBinaryOperator(next) !== undefined) {
      // "(1+2)*3" and "(label)+1" are expressions that start with a parenthesis, not an indirect operand.
      stream.reset(parenthesisMark);
    } else if (next && next.kind === "punct" && next.value === ",") {
      stream.consumePunct(",");
      const register = stream.consumeSymbol("Expected X or Y after comma").toUpperCase();
      if (register === "Y") {
        return { kind: "indirect", expr, register: "Y" };
      }
      throw new Error(`Only ,Y is allowed after a closing parenthesis: use (zp),Y or (zp,X) (got ,${register})`);
    } else {
      return { kind: "indirect", expr };
    }
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

  getScope(): string | undefined {
    return this.currentScope;
  }

  setScope(scope: string | undefined): void {
    this.currentScope = scope;
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
  private readonly warnings: string[] = [];
  /** Set once the .text letter-folding warning was given. */
  private textFoldWarned = false;
  private readonly incbinCache = new Map<string, Uint8Array>();
  /** Open `.if` blocks of the current pass. */
  private ifStack: Array<{ active: boolean; parentActive: boolean; taken: boolean; seenElse: boolean; location: SourceLocation }> = [];
  /** Assignments whose value needed a symbol that was not defined yet in the first pass. */
  private deferred: Array<{ statement: AssignmentStatement; location: SourceLocation; pc: number; scope: string | undefined }> = [];

  constructor(
    private readonly lines: ParsedLine[],
    private readonly defaultLoadAddress: number,
    private readonly resolveIncbin?: (requestedPath: string, fromFile: string) => Uint8Array,
  ) {
    this.symbolTable.reset();
  }

  getWarnings(): readonly string[] {
    return this.warnings;
  }

  /**
   * "size = end - start" before the labels it uses: the first pass cannot evaluate it, so it is
   * resolved here, after every label has an address and before the second pass reads it.
   */
  resolveDeferredAssignments(): void {
    let pending = this.deferred;
    this.deferred = [];
    const savedPc = this.pc;
    const savedScope = this.symbolTable.getScope();
    try {
      while (pending.length > 0) {
        const unresolved: typeof pending = [];
        for (const item of pending) {
          this.pc = item.pc;
          this.symbolTable.setScope(item.scope);
          let value: number | undefined;
          try {
            value = this.evaluate(item.statement.expr, 0, item.location);
          } catch (error) {
            if (error instanceof AssemblyError) throw error;
            throw new AssemblyError(error instanceof Error ? error.message : String(error), item.location);
          }
          if (value === undefined) {
            unresolved.push(item);
            continue;
          }
          try {
            this.symbolTable.setAssignment(item.statement.target, value, item.location);
          } catch (error) {
            throw new AssemblyError(error instanceof Error ? error.message : String(error), item.location);
          }
        }
        if (unresolved.length === pending.length) {
          const first = unresolved[0]!;
          this.pc = first.pc;
          this.symbolTable.setScope(first.scope);
          throw this.undefinedError(first.statement.expr, first.location, "Assignment depends on an undefined symbol");
        }
        pending = unresolved;
      }
    } finally {
      this.pc = savedPc;
      this.symbolTable.setScope(savedScope);
    }
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
    this.ifStack = [];
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
    const open = this.ifStack[this.ifStack.length - 1];
    if (open) {
      throw new AssemblyError(".if has no matching .endif", open.location);
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
      this.warnings.push("The source emits no bytes (only labels, equates or .res); the PRG is empty");
      return Buffer.alloc(0);
    }
    let start = this.lowestWritten;
    let end = this.highestWritten;
    // Reserved space that adjoins the emitted bytes (a trailing "counter: .res 1")
    // is part of the image and zero-filled, as in ca65 and DASM; detached blocks
    // such as zero-page variables are not, so they do not stretch the PRG.
    // Merge the ranges once, then extend the image to the right and to the left in one pass each.
    const merged: Array<[number, number]> = [];
    for (const [resStart, resEnd] of [...this.reserved].sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && resStart <= last[1] + 1) last[1] = Math.max(last[1], resEnd);
      else merged.push([resStart, resEnd]);
    }
    const emittedBytes = end - start + 1;
    for (const [resStart, resEnd] of merged) {
      if (resStart <= end + 1 && resEnd > end) end = resEnd;
    }
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const [resStart, resEnd] = merged[index]!;
      if (resEnd >= start - 1 && resStart < start) start = resStart;
    }
    if (end - start + 1 - emittedBytes >= LARGE_FILL_WARNING_BYTES) {
      this.warnings.push(
        `.res space next to the emitted bytes adds ${end - start + 1 - emittedBytes} zero bytes to the PRG (${formatHex(start)}-${formatHex(end)}); put big buffers in a separate .org block or define them with name = address instead`,
      );
    }
    // Addresses that are neither emitted nor reserved are zero-filled. Refuse a run of them that
    // touches $D000-$DFFF: the loader would write zeros to the VIC, SID, CIA and colour RAM.
    // Count reservation boundaries once so adjacent or overlapping reservations do not require
    // searching the entire reservation list for every byte in the image.
    const reservationBoundaries = new Int32Array(0x10001);
    for (const [resStart, resEnd] of this.reserved) {
      reservationBoundaries[resStart]! += 1;
      reservationBoundaries[resEnd + 1]! -= 1;
    }
    let reservedDepth = 0;
    let gapStart: number | undefined;
    for (let addr = 0; addr <= end + 1; addr++) {
      reservedDepth += reservationBoundaries[addr]!;
      const gap = addr >= start && addr <= end && !this.written[addr] && reservedDepth === 0;
      if (gap && gapStart === undefined) gapStart = addr;
      if (!gap && gapStart !== undefined) {
        if (addr - gapStart >= LARGE_FILL_WARNING_BYTES) {
          this.warnings.push(
            `${addr - gapStart} zero bytes ${formatHex(gapStart)}-${formatHex(addr - 1)} between output blocks are part of the PRG; assemble the blocks separately or move them closer`,
          );
        }
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
    const active = this.ifStack.length === 0 || this.ifStack[this.ifStack.length - 1]!.active;
    if (active) {
      for (const label of line.labels) {
        if (pass === 0) {
          this.symbolTable.setLabel(label, this.pc, line.location);
        } else {
          this.symbolTable.ensureLabel(label, this.pc);
        }
      }
    }

    if (!line.statement) {
      return;
    }

    if (line.statement.kind === "directive" && (line.statement.name === "if" || line.statement.name === "else" || line.statement.name === "endif")) {
      this.handleConditional(line.statement, pass, line.location, active);
      return;
    }
    if (!active) {
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

  private handleConditional(statement: DirectiveStatement, pass: 0 | 1, location: SourceLocation, active: boolean): void {
    if (statement.name === "if") {
      if (!active) {
        this.ifStack.push({ active: false, parentActive: false, taken: true, seenElse: false, location });
        return;
      }
      const expr = (statement.args[0] as { kind: "expr"; expr: Expression }).expr;
      const value = this.evaluate(expr, pass, location);
      if (value === undefined) {
        throw this.undefinedError(expr, location, ".if needs a value that is known at this point (labels defined later in the file are not)");
      }
      const taken = value !== 0;
      this.ifStack.push({ active: taken, parentActive: true, taken, seenElse: false, location });
      return;
    }
    const top = this.ifStack[this.ifStack.length - 1];
    if (!top) {
      throw new AssemblyError(`.${statement.name} without a matching .if`, location);
    }
    if (statement.name === "endif") {
      this.ifStack.pop();
      return;
    }
    if (top.seenElse) {
      throw new AssemblyError(".else after .else in the same .if", location);
    }
    top.seenElse = true;
    if (top.parentActive) {
      top.active = !top.taken;
      top.taken = true;
    }
  }

  private handleAssignment(statement: AssignmentStatement, pass: 0 | 1, location: SourceLocation): void {
    const value = this.evaluate(statement.expr, pass, location);
    if (value === undefined) {
      if (pass === 0 && !statement.isLocationCounter) {
        // Resolved after the first pass, see resolveDeferredAssignments().
        this.deferred.push({ statement, location, pc: this.pc, scope: this.symbolTable.getScope() });
        return;
      }
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
      case "text":
      case "acmeText":
      case "acmePet":
      case "acmeScr": {
        for (const arg of statement.args) {
          if (arg.kind === "string") {
            // Both passes encode, so the size is the same and a bad character is reported at once.
            const codes = encodeStringArgument(statement.name, arg.value, location);
            if (pass === 1) {
              if (statement.name === "text" && !this.textFoldWarned && /[a-z]/.test(arg.value.replace(/\{[^}]*\}/g, ""))) {
                this.textFoldWarned = true;
                this.warnings.push(
                  `${location.file}:${location.line}: .text turns a-z into the PETSCII letters $41-$5A (this assembler's rule); 64tass would emit the ASCII codes and Kick Assembler screen codes. Use !text for raw bytes, !pet for ACME's PETSCII or !scr for screen codes`,
                );
              }
              for (const code of codes) this.writeByte(code, location);
            } else {
              this.pc += codes.length;
            }
          } else if (arg.kind === "expr") {
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
          } else if (arg.kind === "expr") {
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
        this.emitFill(statement.args[0]!, statement.args[1], pass, location, "fill directive");
        break;
      }
      case "alignmask": {
        // ACME: pad until (pc AND andValue) == equalValue; the default fill is NOP ($EA).
        const mask = this.evaluateDefined(statement.args[0]!, pass, location, "!align");
        const wanted = this.evaluateDefined(statement.args[1]!, pass, location, "!align");
        const value = statement.args[2] ? this.evaluateDefined(statement.args[2], pass, location, "!align") : 0xea;
        if (!Number.isInteger(mask) || !Number.isInteger(wanted) || mask < 0 || mask > 0xffff || wanted < 0 || wanted > 0xffff) {
          throw new AssemblyError(`!align needs ANDVALUE and EQUALVALUE in 0..65535, got ${mask}, ${wanted}`, location);
        }
        let padding = 0;
        while (((this.pc + padding) & mask) !== wanted) {
          padding += 1;
          if (padding > 0x10000) {
            throw new AssemblyError(`!align ${mask}, ${wanted} can never be satisfied`, location);
          }
        }
        if (pass === 1) {
          this.checkByteValue(value, "!align", location);
          for (let index = 0; index < padding; index += 1) this.writeByte(value, location);
        } else {
          this.pc += padding;
        }
        break;
      }
      case "acmeBinary": {
        // ACME: SIZE bytes from file offset SKIP; without SIZE up to the end of the file; a file
        // shorter than SIZE is padded with zeros, with a warning (ACME 0.97 pseudoopcodes.c).
        const path = (statement.args[0] as { kind: "string"; value: string }).value;
        const data = this.loadBinary(path, location, "!binary");
        const sizeArg = statement.args[1];
        const skipArg = statement.args[2];
        const skip = skipArg && skipArg.kind !== "none" ? this.evaluateDefined(skipArg, pass, location, "!binary SKIP") : 0;
        if (!Number.isInteger(skip) || skip < 0 || skip > data.length) {
          throw new AssemblyError(`!binary "${path}": SKIP ${skip} is outside the ${data.length} bytes of the file`, location);
        }
        const size = sizeArg && sizeArg.kind !== "none" ? this.evaluateDefined(sizeArg, pass, location, "!binary SIZE") : data.length - skip;
        if (!Number.isInteger(size) || size < 0 || size > 0x10000) {
          throw new AssemblyError(`!binary "${path}": SIZE ${size} is outside 0..65536`, location);
        }
        if (pass === 1) {
          const available = Math.min(size, data.length - skip);
          for (let index = 0; index < size; index += 1) this.writeByte(index < available ? data[skip + index]! : 0, location);
          if (available < size) {
            this.warnings.push(`${location.file}:${location.line}: !binary "${path}" has ${available} bytes after offset ${skip}; padded with ${size - available} zero bytes to SIZE ${size}`);
          }
        } else {
          this.pc += size;
        }
        break;
      }
      case "incbin": {
        const path = (statement.args[0] as { kind: "string"; value: string }).value;
        const data = this.loadBinary(path, location, ".incbin");
        const offset = statement.args[1] ? this.evaluateDefined(statement.args[1], pass, location, ".incbin offset") : 0;
        const length = statement.args[2] ? this.evaluateDefined(statement.args[2], pass, location, ".incbin length") : data.length - offset;
        if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > data.length) {
          throw new AssemblyError(`.incbin "${path}": offset ${offset} and length ${length} do not fit the ${data.length} bytes of the file`, location);
        }
        if (pass === 1) {
          for (let index = 0; index < length; index += 1) this.writeByte(data[offset + index]!, location);
        } else {
          this.pc += length;
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
        if (statement.args.length === 2) {
          // ".res n, value" emits n copies of value.
          this.emitFill(statement.args[0]!, statement.args[1], pass, location, "reserve directive");
          break;
        }
        if (statement.args.length !== 1 || statement.args[0]?.kind !== "expr") {
          throw new AssemblyError("reserve directive expects a size and an optional fill value", location);
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

  private loadBinary(path: string, location: SourceLocation, directive: string): Uint8Array {
    if (!this.resolveIncbin) {
      throw new AssemblyError(`${directive} needs a resolveIncbin option; the MCP tools provide none, so write the bytes with .byte`, location);
    }
    let data = this.incbinCache.get(path);
    if (!data) {
      data = this.resolveIncbin(path, location.file);
      if (!(data instanceof Uint8Array) || data.length > 0x10000) {
        throw new AssemblyError(`${directive} "${path}" must give at most 65536 bytes`, location);
      }
      this.incbinCache.set(path, data);
    }
    return data;
  }

  private emitFill(countArg: DirectiveArg, valueArg: DirectiveArg | undefined, pass: 0 | 1, location: SourceLocation, context: string): void {
    const count = this.evaluateDefined(countArg, pass, location, context);
    if (!Number.isInteger(count) || count < 0 || count > 0x10000) {
      throw new AssemblyError(`${context} requires a count of 0..65536, got ${count}`, location);
    }
    const value = valueArg ? this.evaluateDefined(valueArg, pass, location, context) : 0;
    if (pass === 1) {
      this.checkByteValue(value, context, location);
      for (let index = 0; index < count; index += 1) this.writeByte(value, location);
    } else {
      this.pc += count;
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
    // Symbols are case-sensitive; point at a name that differs only in case.
    const hints = names.flatMap((name) => {
      const lower = name.toLowerCase();
      const match = [...this.symbolTable.allGlobals().keys()].find((candidate) => candidate.toLowerCase() === lower);
      return match ? [`"${match}"`] : [];
    });
    const hint = hints.length > 0 ? ` (symbols are case-sensitive; did you mean ${hints.join(", ")}?)` : "";
    return new AssemblyError(`Undefined symbol${names.length > 1 ? "s" : ""} ${quoted}${hint}`, location);
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
    throw new AssemblyError(`text directive character '${char}' (code ${code}) is not ASCII and has no PETSCII mapping; use .byte $xx for it`, location);
  }
  if (code >= 0x61 && code <= 0x7a) return code - 0x20;
  if (code === 0x0a) return 0x0d;
  return code;
}

/**
 * Bytes of a string argument. `.byte` is raw character codes; `.text` and `.ascii` are PETSCII as
 * above, plus {name}, {$xx} and {nn} control codes as in BASIC strings; the ACME directives use
 * ACME_ENCODERS.
 */
function encodeStringArgument(kind: "byte" | "text" | AcmeTextDirective, value: string, location: SourceLocation): number[] {
  const codes: number[] = [];
  if (kind === "acmeText" || kind === "acmePet" || kind === "acmeScr") {
    const encode = ACME_ENCODERS[kind];
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (code > 0xff) {
        throw new AssemblyError(`text character '${char}' (code ${code}) does not fit in one byte; use \\xNN for a byte value`, location);
      }
      codes.push(encode(code));
    }
    return codes;
  }
  if (kind === "byte") {
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (code > 0xff) {
        throw new AssemblyError(`byte directive character '${char}' (code ${code}) does not fit in one byte`, location);
      }
      codes.push(code);
    }
    return codes;
  }
  let index = 0;
  while (index < value.length) {
    if (kind === "text" && value[index] === "{") {
      const token = parseBraceToken(value, index);
      if (token) {
        if (!token.ok) {
          throw new AssemblyError(`${token.token} is not a known control code (${token.reason}); write \\x7b for a literal brace`, location);
        }
        codes.push(token.value);
        index = token.endIndex;
        continue;
      }
    }
    const char = String.fromCodePoint(value.codePointAt(index)!);
    index += char.length;
    codes.push(asciiToPetscii(char, location));
  }
  return codes;
}

type AcmeTextDirective = "acmeText" | "acmePet" | "acmeScr";

/**
 * ACME's built-in conversion tables, from encoderfn_raw, encoderfn_pet and encoderfn_scr in
 * src/encoding.c of ACME 0.97 (svn trunk, acme-crossass on SourceForge), checked byte for byte
 * against the acme binary in test/hard06AssemblerDifferential.test.mjs. Braces are ordinary
 * characters in ACME strings, so {name} codes are not read here.
 */
const ACME_ENCODERS: Record<AcmeTextDirective, CharCodeMapper> = {
  acmeText: (code) => code,
  acmePet: (code) => (code >= 0x41 && code <= 0x5a ? code | 0x80 : code >= 0x61 && code <= 0x7a ? code - 0x20 : code),
  acmeScr: (code) =>
    code >= 0x61 && code <= 0x7a ? code - 0x60 : code >= 0x5b && code <= 0x5f ? code - 0x40 : code === 0x60 ? 0x40 : code === 0x40 ? 0 : code,
};

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
        if (register) {
          throw new AssemblyError(`Instruction ${mnemonic} is a relative branch and takes no ,${register} index`, location);
        }
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

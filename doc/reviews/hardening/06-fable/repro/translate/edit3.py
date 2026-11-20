p='src/tools/translation/assembler.ts'
s=open(p).read()
def rep(old,newt,cnt=1):
    global s
    assert s.count(old)==cnt,(s.count(old),old[:90])
    s=s.replace(old,newt)

rep('''function normalizeSource(input: string): string {
  return input.replace(/\\r\\n?/g, "\\n");
}''','''function normalizeSource(input: string): string {
  return input.replace(/^\\uFEFF/, "").replace(/\\r\\n?/g, "\\n");
}''')
# tokenizer: comments, whitespace
rep('''    if (char === ";" || char === "\\u201b") {
      break;
    }

    if (char === " " || char === "\\t") {''','''    if (char === ";" || char === "\\u201b" || (char === "/" && line[index + 1] === "/")) {
      break;
    }

    if (char === " " || char === "\\t" || char === "\\u00a0") {''')
rep('''        const current = line[index] ?? "";
        if (current === "\\\\" && index + 1 < length) {
          const escape = line[index + 1] ?? "";
          const translated = translateEscape(escape);
          value += translated;
          index += 2;
          continue;
        }
''','''        const current = line[index] ?? "";
        if (current === "\\\\" && index + 1 < length) {
          const escape = line[index + 1] ?? "";
          if (escape === "x") {
            const digits = /^[0-9a-fA-F]{2}/.exec(line.slice(index + 2, index + 4));
            if (!digits) {
              throw new Error('Escape \\\\x needs two hex digits, for example "\\\\x41"');
            }
            value += String.fromCharCode(parseInt(digits[0], 16));
            index += 4;
            continue;
          }
          value += translateEscape(escape);
          index += 2;
          continue;
        }
''')
rep('''      if (!closed) {
        throw new Error("Unterminated string literal");
      }''','''      if (!closed) {
        throw new Error('Unterminated string literal (a backslash escapes the next character: write \\\\\\\\ for one backslash and \\\\" for a quote)');
      }''')
rep('''    throw new Error(`Unexpected character '${char}'`);''','''    const codePoint = line.codePointAt(index) ?? 0;
    throw new Error(`Unexpected character '${codePoint < 0x20 || codePoint === 0x7f ? "" : String.fromCodePoint(codePoint)}' (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`);''')
rep('''    case "\\"":
      return "\\"";
    case "'":
      return "'";
    default:
      return char;
  }''','''    case "\\"":
      return "\\"";
    case "'":
      return "'";
    case "0":
      return "\\0";
    default:
      throw new Error(`Unknown escape "\\\\${char}" in a string; use \\\\0, \\\\xNN, \\\\n, \\\\r, \\\\t, \\\\\\\\, \\\\" or \\\\'`);
  }''')
# TokenStream mark/reset
rep('''  isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }''','''  isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  mark(): number {
    return this.index;
  }

  reset(mark: number): void {
    this.index = mark;
  }''')
# parseOperand
rep('function parseOperand(stream: TokenStream): Operand {','function parseOperand(stream: TokenStream, mnemonic: string): Operand {')
rep('''  if (first.kind === "symbol" && first.value.toUpperCase() === "A") {
    stream.consume();
    if (!stream.isAtEnd()) {
      throw new Error("Unexpected tokens after accumulator operand");
    }
    return { kind: "accumulator" };
  }''','''  // "A" alone is the accumulator for ASL, LSR, ROL and ROR; for every other instruction it is a
  // symbol, so a label named "a" works in "lda a" and "lda a+1".
  if (first.kind === "symbol" && first.value.toUpperCase() === "A" && stream.peek(1) === undefined && INSTRUCTION_TABLE.get(mnemonic)?.has(AddressingMode.Accumulator)) {
    stream.consume();
    return { kind: "accumulator" };
  }''')
rep('''  if (first.kind === "punct" && first.value === "(") {
    stream.consumePunct("(");''','''  const parenthesisMark = stream.mark();
  if (first.kind === "punct" && first.value === "(") {
    stream.consumePunct("(");''')
rep('''    stream.consumePunct(")", "Expected ')' to close indirect operand");

    if (stream.isAtEnd()) {
      return { kind: "indirect", expr };
    }

    const next = stream.peek();
    if (next && next.kind === "punct" && next.value === ",") {''','''    stream.consumePunct(")", "Expected ')' to close indirect operand");

    if (stream.isAtEnd()) {
      return { kind: "indirect", expr };
    }

    const next = stream.peek();
    if (next && next.kind === "punct" && next.value !== "," && asBinaryOperator(next) !== undefined) {
      // "(1+2)*3" and "(label)+1" are expressions that start with a parenthesis, not an indirect operand.
      stream.reset(parenthesisMark);
    } else if (next && next.kind === "punct" && next.value === ",") {''')
open(p,'w').write(s)

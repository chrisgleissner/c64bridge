p='src/tools/translation/assembler.ts'
s=open(p).read()
def rep(old,newt,cnt=1):
    global s
    assert s.count(old)==cnt,(s.count(old),old[:90])
    s=s.replace(old,newt)

rep('''      case "byte":
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
          } else {''','''      case "byte":
      case "text":
      case "screen": {
        for (const arg of statement.args) {
          if (arg.kind === "string") {
            // Both passes encode, so the size is the same and a bad character is reported at once.
            const codes = encodeStringArgument(statement.name, arg.value, location);
            if (pass === 1) {
              for (const code of codes) this.writeByte(code, location);
            } else {
              this.pc += codes.length;
            }
          } else {''')

rep('''      case "fill": {
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
      }''','''      case "fill": {
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
      case "incbin": {
        const path = (statement.args[0] as { kind: "string"; value: string }).value;
        if (!this.resolveIncbin) {
          throw new AssemblyError(".incbin needs a resolveIncbin option; the MCP tools provide none, so write the bytes with .byte", location);
        }
        let data = this.incbinCache.get(path);
        if (!data) {
          data = this.resolveIncbin(path, location.file);
          if (!(data instanceof Uint8Array) || data.length > 0x10000) {
            throw new AssemblyError(`.incbin "${path}" must give at most 65536 bytes`, location);
          }
          this.incbinCache.set(path, data);
        }
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
      }''')

rep('''      case "reserve": {
        if (statement.args.length !== 1 || statement.args[0]?.kind !== "expr") {
          throw new AssemblyError("reserve directive expects a single expression", location);
        }''','''      case "reserve": {
        if (statement.args.length === 2) {
          // ".res n, value" emits n copies of value.
          this.emitFill(statement.args[0]!, statement.args[1], pass, location, "reserve directive");
          break;
        }
        if (statement.args.length !== 1 || statement.args[0]?.kind !== "expr") {
          throw new AssemblyError("reserve directive expects a size and an optional fill value", location);
        }''')

rep('''  private evaluateDefined(arg: DirectiveArg,''','''  private emitFill(countArg: DirectiveArg, valueArg: DirectiveArg | undefined, pass: 0 | 1, location: SourceLocation, context: string): void {
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

  private evaluateDefined(arg: DirectiveArg,''')

# asciiToPetscii error text and string encoder
rep('''function asciiToPetscii(char: string, location: SourceLocation): number {
  const code = char.charCodeAt(0);
  if (code > 0x7f) {
    throw new AssemblyError(`text directive character '${char}' (code ${code}) is not ASCII and has no PETSCII mapping`, location);
  }''','''function asciiToPetscii(char: string, location: SourceLocation): number {
  const code = char.charCodeAt(0);
  if (code > 0x7f) {
    throw new AssemblyError(`text directive character '${char}' (code ${code}) is not ASCII and has no PETSCII mapping; use .byte $xx for it`, location);
  }''')
rep('''interface ResolvedInstruction {''','''/**
 * Bytes of a string argument. `.byte` is raw character codes; `.text` (also `.ascii`, `.petscii`,
 * `!text`, `!pet`) is PETSCII as above, plus {name}, {$xx} and {nn} control codes as in BASIC
 * strings; `.scr` (`.screen`, `!scr`) is screen codes: the PETSCII of the text converted by the
 * KERNAL rule (petsciiToScreenCode), so letters of either case are screen codes 1-26.
 */
function encodeStringArgument(kind: "byte" | "text" | "screen", value: string, location: SourceLocation): number[] {
  const codes: number[] = [];
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
          throw new AssemblyError(`${token.token} is not a known control code (${token.reason}); write \\\\x7b for a literal brace`, location);
        }
        codes.push(token.value);
        index = token.endIndex;
        continue;
      }
    }
    const char = String.fromCodePoint(value.codePointAt(index)!);
    index += char.length;
    const petscii = asciiToPetscii(char, location);
    if (kind === "text") {
      codes.push(petscii);
      continue;
    }
    const screen = petsciiToScreenCode(petscii);
    if (screen === undefined) {
      throw new AssemblyError(`screen text character ${JSON.stringify(char)} has no screen code (it is a control code)`, location);
    }
    codes.push(screen);
  }
  return codes;
}

interface ResolvedInstruction {''')

# relative with register
rep('''      if (RELATIVE_ONLY.has(mnemonic)) {
        if (!available.has(AddressingMode.Relative)) {''','''      if (RELATIVE_ONLY.has(mnemonic)) {
        if (register) {
          throw new AssemblyError(`Instruction ${mnemonic} is a relative branch and takes no ,${register} index`, location);
        }
        if (!available.has(AddressingMode.Relative)) {''')

# undefined hint
rep('''    const quoted = names.map((name) => `"${name}"`).join(", ");
    return new AssemblyError(`Undefined symbol${names.length > 1 ? "s" : ""} ${quoted}`, location);''','''    const quoted = names.map((name) => `"${name}"`).join(", ");
    // Symbols are case-sensitive; point at a name that differs only in case.
    const hints = names.flatMap((name) => {
      const lower = name.toLowerCase();
      const match = [...this.symbolTable.allGlobals().keys()].find((candidate) => candidate.toLowerCase() === lower);
      return match ? [`"${match}"`] : [];
    });
    const hint = hints.length > 0 ? ` (symbols are case-sensitive; did you mean ${hints.join(", ")}?)` : "";
    return new AssemblyError(`Undefined symbol${names.length > 1 ? "s" : ""} ${quoted}${hint}`, location);''')

# buildPrg: linear merge + warnings
old_start=s.index('    // Reserved space that adjoins the emitted bytes')
old_end=s.index('    // Addresses that are neither emitted nor reserved')
s=s[:old_start]+'''    // Reserved space that adjoins the emitted bytes (a trailing "counter: .res 1")
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
'''+s[old_end:]
rep('''        if (rangeOverlapsIo(gapStart, addr - gapStart)) {''','''        if (addr - gapStart >= LARGE_FILL_WARNING_BYTES) {
          this.warnings.push(
            `${addr - gapStart} zero bytes ${formatHex(gapStart)}-${formatHex(addr - 1)} between output blocks are part of the PRG; assemble the blocks separately or move them closer`,
          );
        }
        if (rangeOverlapsIo(gapStart, addr - gapStart)) {''')
rep('''    if (this.lowestWritten > this.highestWritten) {
      return Buffer.alloc(0);
    }''','''    if (this.lowestWritten > this.highestWritten) {
      this.warnings.push("The source emits no bytes (only labels, equates or .res); the PRG is empty");
      return Buffer.alloc(0);
    }''')
rep('const MAX_ADDRESS = 0xffff;','const MAX_ADDRESS = 0xffff;\n/** A zero-filled gap or trailing .res at least this long is reported in AssemblyResult.warnings. */\nconst LARGE_FILL_WARNING_BYTES = 1024;')
open(p,'w').write(s)

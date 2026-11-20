p='src/tools/translation/assembler.ts'
s=open(p).read()
def rep(old,newt,cnt=1):
    global s
    assert s.count(old)==cnt,(s.count(old),old[:90])
    s=s.replace(old,newt)

# result + driver
rep('''  /** Global label name -> resolved address (after both passes). */
  readonly symbols: ReadonlyMap<string, number>;
}''','''  /** Global label name -> resolved address (after both passes). */
  readonly symbols: ReadonlyMap<string, number>;
  /**
   * Things that are legal but probably not intended, for the caller to show: a large zero-filled
   * gap between output blocks, a trailing `.res` that enlarges the PRG, or an empty image.
   */
  readonly warnings: readonly string[];
}''')
rep('''  const assembler = new Assembler(statements, loadAddress);
  assembler.runPass(0);
  assembler.runPass(1);
''','''  const assembler = new Assembler(statements, loadAddress, options?.resolveIncbin);
  assembler.runPass(0);
  assembler.resolveDeferredAssignments();
  assembler.runPass(1);
''')
rep('return { prg, symbols: assembler.getSymbols(), entryAddress };','return { prg, symbols: assembler.getSymbols(), entryAddress, warnings: assembler.getWarnings() };')

# SymbolTable scope accessors
rep('''  get(label: string): number | undefined {
    if (label === "*") {''','''  getScope(): string | undefined {
    return this.currentScope;
  }

  setScope(scope: string | undefined): void {
    this.currentScope = scope;
  }

  get(label: string): number | undefined {
    if (label === "*") {''')

# Assembler fields/constructor
rep('''  /** Reserved (.res) ranges from the last pass, as [start, end] inclusive. */
  private reserved: Array<[number, number]> = [];

  constructor(private readonly lines: ParsedLine[], private readonly defaultLoadAddress: number) {
    this.symbolTable.reset();
  }
''','''  /** Reserved (.res) ranges from the last pass, as [start, end] inclusive. */
  private reserved: Array<[number, number]> = [];
  private readonly warnings: string[] = [];
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
''')

# runPass: reset ifStack, end check
rep('''    this.reserved = [];
    this.written.fill(0);''','''    this.reserved = [];
    this.ifStack = [];
    this.written.fill(0);''')
rep('''        throw new AssemblyError(message, line.location);
      }
    }
  }
''','''        throw new AssemblyError(message, line.location);
      }
    }
    const open = this.ifStack[this.ifStack.length - 1];
    if (open) {
      throw new AssemblyError(".if has no matching .endif", open.location);
    }
  }
''')

# processLine
rep('''  private processLine(line: ParsedLine, pass: 0 | 1): void {
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
''','''  private processLine(line: ParsedLine, pass: 0 | 1): void {
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
''')
rep('''  private handleAssignment(statement: AssignmentStatement, pass: 0 | 1, location: SourceLocation): void {
    const value = this.evaluate(statement.expr, pass, location);
    if (value === undefined) {
      throw this.undefinedError(statement.expr, location, "Assignment depends on an undefined symbol");
    }''','''  private handleConditional(statement: DirectiveStatement, pass: 0 | 1, location: SourceLocation, active: boolean): void {
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
    }''')
open(p,'w').write(s)

import re,sys
p='src/tools/translation/assembler.ts'
s=open(p).read()
def rep(old,new,cnt=1):
    global s
    assert s.count(old)==cnt,(s.count(old),old[:80])
    s=s.replace(old,new)

# imports
rep('import { rangeOverlapsIo } from "../../ioRange.js";','import { rangeOverlapsIo } from "../../ioRange.js";\nimport { parseBraceToken, petsciiToScreenCode } from "../../petscii.js";')

# options
rep('''  resolveInclude?: (
    requestedPath: string,
    fromFile: string,
  ) => string | { contents: string; fileName?: string };
}''','''  resolveInclude?: (
    requestedPath: string,
    fromFile: string,
  ) => string | { contents: string; fileName?: string };
  /**
   * Resolver invoked for `.incbin "path"[, offset[, length]]` (also `!binary`). It returns the
   * file bytes; without it `.incbin` is an error. The tools do not provide one.
   */
  resolveIncbin?: (requestedPath: string, fromFile: string) => Uint8Array;
}''')

# AssemblyError
rep('''export class AssemblyError extends Error {
  constructor(message: string, readonly location: SourceLocation) {
    super(`${location.file}:${location.line}: ${message}`);
  }
}''','''export class AssemblyError extends Error {
  constructor(message: string, readonly location: SourceLocation) {
    const where = `${location.file}:${location.line}${location.context ? ` (in ${location.context})` : ""}`;
    const shown = location.text.trim();
    super(`${where}: ${message}${shown ? `\\n    ${shown.length > 160 ? `${shown.slice(0, 157)}...` : shown}` : ""}`);
  }
}''')
rep('''interface SourceLocation {
  file: string;
  line: number;
  text: string;
}''','''interface SourceLocation {
  file: string;
  line: number;
  text: string;
  /** Set for lines produced by a macro or repeat expansion, for example "macro wait". */
  context?: string;
}''')
open(p,'w').write(s)

p='src/tools/translation/assembler.ts'
s=open(p).read()
new=open('/tmp/h6/translate/parser_new.ts').read()
new=new.replace('''    const head = new RegExp(`^\\\\s*(?:[A-Za-z_.][\\\\w.]*\\\\s*:\\\\s*)*[A-Za-z_][\\\\w.]*\\\\s*:?\\\\s*`).exec(text);
    // Skip label prefixes and the macro name itself; the rest is the argument list.
''','''    // Skip label prefixes and the macro name itself; the rest is the argument list.
''')
new=new.replace(' : head ? text.slice(head[0].length) : "";',' : "";')
new=new.replace('upper = `!${word.kind === "number" ? String(word.value) : (word as { value: string }).value.toUpperCase()}`;','upper = `!${word.kind === "number" ? String(word.value) : String(word.value).toUpperCase()}`;')
a=s.index('class Parser {')
b=s.index('function tokenize(line: string)')
s=s[:a]+new+s[b:]
def rep(old,newt,cnt=1):
    global s
    assert s.count(old)==cnt,(s.count(old),old[:80])
    s=s.replace(old,newt)
rep('type DirectiveName = "org" | "byte" | "word" | "text" | "fill" | "align" | "equ" | "reserve" | "include";',
 'type DirectiveName =\n  | "org" | "byte" | "word" | "text" | "screen" | "fill" | "align" | "alignmask" | "equ" | "reserve" | "include" | "incbin"\n  | "if" | "else" | "endif";')
a=s.index('const DIRECTIVE_ALIASES')
b=s.index('const RELATIVE_ONLY')
s=s[:a]+'''const DIRECTIVE_ALIASES: Record<string, DirectiveName> = {
  ".ORG": "org",
  ORG: "org",
  ".BYTE": "byte",
  "BYTE": "byte",
  "DB": "byte",
  ".DB": "byte",
  "!BYTE": "byte",
  "!BY": "byte",
  "!8": "byte",
  ".WORD": "word",
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
  "!TEXT": "text",
  "!TX": "text",
  ".PETSCII": "text",
  "!PET": "text",
  ".SCR": "screen",
  ".SCREEN": "screen",
  "!SCR": "screen",
  ".INCLUDE": "include",
  "INCLUDE": "include",
  "!SOURCE": "include",
  ".INCBIN": "incbin",
  "!BINARY": "incbin",
  "!BIN": "incbin",
  ".IF": "if",
  ".ELSE": "else",
  ".ENDIF": "endif",
};

/** Directives handled while parsing, before statements exist. */
const BLOCK_DIRECTIVE_NAMES = ".macro name params / .endmacro (.endm), .repeat n / .endrepeat (.rept / .endr)";
const SUPPORTED_DIRECTIVES = `${[...new Set(Object.keys(DIRECTIVE_ALIASES).map((name) => name.toLowerCase()))].join(" ")} ${BLOCK_DIRECTIVE_NAMES}; "name = value" and "* = address"`;

'''+s[b:]
open(p,'w').write(s)

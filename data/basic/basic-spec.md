# Commodore 64 BASIC V2 Specification

## 1. Overview

C64 BASIC V2 is a line-numbered, interpreted, tokenised language stored in ROM.  
Each program consists of linked line records beginning at `$0801`, and executes sequentially unless redirected by explicit control flow. The interpreter manages variables, arrays, and strings in RAM regions immediately following the program text.

---

## 2. Memory and Program Layout

### 2.1 System Pointers (Zero Page)

| Name | Address | Meaning |
|------|----------|----------|
| **TXTTAB** | `$002B–002C` | Start of BASIC text (default `$0801`) |
| **VARTAB** | `$002D–002E` | Start of variable table |
| **ARYTAB** | `$002F–0030` | Start of array storage |
| **STREND** | `$0031–0032` | End of arrays (+1) |
| **FRETOP** | `$0033–0034` | Bottom of string storage |
| **MEMSIZ** | `$0037–0038` | Highest BASIC RAM address |

Variables grow upward from `TXTTAB`; strings grow downward from `MEMSIZ`.  
`ARYTAB` always follows `VARTAB`; defining new scalars after arrays shifts array memory upward by 7 bytes per variable.

---

### 2.2 BASIC Program Storage (PRG Format)

Each BASIC program in memory (and on disk/tape) is a contiguous block:

| Field | Size | Description |
|--------|------|-------------|
| Load address | 2 bytes | `$0801` little-endian |
| Next line pointer | 2 bytes | Absolute address of next line |
| Line number | 2 bytes | 0–65535 |
| Tokenised PETSCII text | variable | Zero-terminated statement list |
| Terminator | 2 bytes | Final `$0000` sentinel |

Pointers increase monotonically. The final record’s pointer references the terminator.  
Tokenisation replaces keywords by single-byte codes (`$80–$CB`, including the operator tokens `$AA–$AE` for `+ - * / ↑` and `$B1–$B3` for `> = <`; π is `$FF`), ignoring quoted strings and `REM` comments. Empty lines are stored as a single `$20` (space).

---

## 3. Variables and Data Model

### 3.1 Variable Types

All variables occupy **7 bytes** in the variable table.  
The first two bytes encode the name and type; the remaining bytes store the data or descriptor.

| Type | Suffix | Range | Storage | Notes |
|------|---------|--------|----------|-------|
| **Real (Float)** | none | ±2.94×10⁻³⁹ … ±1.70×10³⁸ | 1-byte exponent + 4-byte mantissa | Default numeric type, ≈9.6-digit precision. |
| **Integer** | `%` | −32768 … 32767 | 2 bytes (hi-lo) | High bit set on both name bytes; slower than float due to conversion. |
| **String** | `$` | 0–255 chars | 1-byte length + 2-byte pointer | High bit set on second name byte; pointer references PETSCII data. |
| **Boolean** | — | `0` (FALSE), `−1` or any non-zero (TRUE) | Numeric representation | Implemented via integers. |

#### Name Encoding

- Only first two letters significant (`CO`, `COCOS` → same variable).  
- Letters A–Z, digits 0–9; must start with a letter.  
- Case-insensitive; stored uppercase.  
- Type suffix distinguishes variants (`A`, `A%`, `A$`).  
- Reserved names: `ST`, `TI`, `TI$`, `FN`, and all keywords.  
- Max name length ≈ 80 characters (logical line length).

**Example collision:**

```
10 A$="1":AA$="2":AAA$="3":PRINT A$,AA$,AAA$
→ 1 3 3
```

---

### 3.2 Internal Representation

| Offset | Field | Description |
|--------:|--------|-------------|
| 0–1 | Name (2 chars) with high bits as type markers | Identifier |
| 2–6 | Data payload | Depends on type |

**Encoding rules:**

- *Real*: ASCII name, 2nd byte zero if single char.  
- *Integer*: both name bytes have high-bit set.  
- *String*: only 2nd byte has high-bit set.

**Payload:**

- Real: exponent + mantissa (5 bytes).  
- Integer: 2-byte value, 3 bytes padding 0.  
- String: length (1 byte), pointer (2 bytes LE), padding 0s.

---

### 3.3 Arrays

Declared via `DIM`, e.g. `DIM A(7)` (indices 0–7).  
If a program uses an array without prior `DIM`, BASIC auto-DIMs it to 11 elements per dimension (0–10).  
Re-DIMing → `?REDIM'D ARRAY ERROR`.  
Index < 0 or > 32767 → `?ILLEGAL QUANTITY ERROR`.

#### Internal Layout

```
name(2) , offset_to_next(2) , dimensions(1) ,
length1(2) [, length2(2)...] , data...
```

- Offset is relative to next array (for relocation).  
- `dimensions` = number of axes (1–255 theoretical).  
- Each element stored in ascending index order; leftmost index varies fastest.  
- Element sizes: Real 5 B, Integer 2 B, String 3 B descriptor.

**Examples:**

```
DIM C%(2,3)  → 3×4 = 12 integers
DIM S$(1,2,3) → 2×3×4 = 24 string descriptors
```

---

### 3.4 Strings

Strings hold PETSCII text of up to 255 chars.  
The descriptor’s pointer targets either:

- an in-place literal within BASIC text (for quoted constants), or  
- an allocated region in the **string heap** (descending from `FRETOP`).

New strings are created whenever:

- concatenation (`+`),
- substring (`LEFT$`, `MID$`, `RIGHT$`),
- or runtime expression evaluation occurs.

Garbage collection exists (`$B526`): it runs when string space is exhausted and on every `FRE()` call, and can pause the program noticeably. `CLR` or `NEW` frees all strings.

**Efficiency notes**

- Prefer `PRINT A$;B$` instead of `PRINT A$+B$` (no new allocation).  
- Define and reuse variables to prevent heap growth.  
- Direct-mode string operations always allocate temporary strings.

**Advanced manipulation:**  
By modifying the descriptor at `VARTAB` (length and pointer), one can create scrolling or “windowed” text effects without copying data.

---

### 3.5 Variable Optimisation Guidelines

- Declare scalar variables before arrays (avoids array shifting).  
- Use short two-character names for speed.  
- Avoid redundant `LET`.  
- Keep string operations minimal in loops.  
- Use `FRE(0)` to inspect available memory (16-bit signed).  
- To locate start of variable table:

  ```
  VT = PEEK(46)*256 + PEEK(45)
  ```

---

## 4. Operators

| Rank | Operators | Description |
|------|------------|-------------|
| 1 | `^` | Exponentiation |
| 2 | unary `+ −` | Sign prefix |
| 3 | `* /` | Multiplication / Division |
| 4 | `+ −` | Addition, Subtraction, String concatenation |
| 5 | `< <= = >= > <>` | Comparison |
| 6 | `NOT` | Logical NOT / bitwise invert |
| 7 | `AND` | Logical AND / bitwise AND |
| 8 | `OR` | Logical OR / bitwise OR |

Parentheses nest ≤ 10 levels.  
Division by 0 → `?DIVISION BY ZERO`.  
Logical ops on integers act bitwise on 16-bit values.

---

## 5. Syntax Definition (EBNF)

*(Complete grammar retained for program analysis)*

```
program      = { line }, endmarker ;
line         = nextptr word , lineno word , stmtlist , 0x00 ;
stmtlist     = statement , { ":" , statement } ;

statement =
  "REM" , { <any PETSCII except CR> } |
  "FOR" , var , "=" , expr , "TO" , expr , [ "STEP" , expr ] |
  "NEXT" , [ var ] |
  "IF" , expr , "THEN" , ( stmtlist | lineno ) |
  ( "GOTO" | "GO" , "TO" ) , lineno |
  "GOSUB" , lineno | "RETURN" |
  "ON" , expr , ( "GOTO" | "GOSUB" ) , lineno , { "," , lineno } |
  "DEF" , "FN" , fnname , "(" , var , ")" , "=" , expr |
  "INPUT" , [ prompt ] , varlist | "GET" , var | "PRINT" , [ printlist ] |
  "OPEN" , expr , "," , expr , [ "," , expr , [ "," , fnameMode ] ] |
  "CLOSE" , expr | "CMD" , expr , [ "," , exprlist ] |
  "LOAD" , fname [ "," , dev [ "," , secdev ] ] |
  "SAVE" , fname [ "," , dev [ "," , secdev ] ] |
  "VERIFY" , fname [ "," , dev [ "," , secdev ] ] |
  "READ" , varlist | "RESTORE" | "DATA" , datalist |
  "POKE" , expr , "," , expr | "PEEK" , "(" , expr , ")" |
  "WAIT" , expr , "," , expr , [ "," , expr ] |
  "SYS" , expr , { "," , expr } | var , "=" , expr |
  "USR" , "(" , expr , ")" |
  "RUN" , [ lineno ] | "STOP" | "END" | "CONT" |
  "LIST" , [ listRange ] | "NEW" | "CLR" |
  "FRE" , "(" , expr , ")" ;

expr  = term , { "OR" , term } ;
term  = factor , { "AND" , factor } ;
factor= [ "NOT" ] , relation ;
relation = sum , { ( "=" | "<" | ">" | "<=" | ">=" | "<>" ) , sum } ;
sum   = product , { ( "+" | "-" ) , product } ;
product = power , { ( "*" | "/" ) , power } ;
power = unary , { "^" , unary } ;
unary = [ "+" | "-" ] , primary ;
primary = number | string | var | fncall | "(" , expr , ")" ;

fncall = ( "SGN" | "INT" | "ABS" | "USR" | "FRE" | "POS" | "SQR" | "RND" |
           "LOG" | "EXP" | "COS" | "SIN" | "TAN" | "ATN" | "PEEK" | "LEN" |
           "STR$" | "VAL" | "ASC" | "CHR$" | "LEFT$" | "RIGHT$" | "MID$" |
           "TAB" | "SPC" ), "(" , [ expr , { "," , expr } ] , ")" ;
```

---

## 6. Commands and Functions

**Flow Control**  
`FOR–TO–STEP–NEXT`, `IF–THEN`, `GOTO`, `GOSUB`, `RETURN`, `ON–GOTO/GOSUB`, `DEF FN`.

**Input/Output**  
`INPUT`, `INPUT#`, `GET`, `PRINT`, `PRINT#`, `SPC(n)`, `TAB(n)`, `POS()`.

**File Operations**  
`LOAD`, `SAVE`, `VERIFY`, `OPEN`, `CLOSE`, `CMD`, `ST`.

**Data Access**  
`DATA`, `READ`, `RESTORE`.

**Math / Logic**  
`ABS`, `ATN`, `COS`, `EXP`, `INT`, `LOG`, `RND`, `SGN`, `SIN`, `SQR`, `TAN`;  
Operators `+ − * / ^ AND OR NOT`.

**String Processing**  
`LEN`, `LEFT$`, `RIGHT$`, `MID$`, `STR$`, `VAL`, `ASC`, `CHR$`, `+` (concat).

**Memory / System**  
`PEEK`, `POKE`, `WAIT`, `SYS`, `USR`.

**Program Control**  
`RUN`, `STOP`, `END`, `CONT`, `NEW`, `CLR`, `LIST`, `FRE(0)`.

Constants: `π`, `TI`, `TI$`.

---

## 7. Keywords and Abbreviations (BASIC V2)

| Hex | Keyword | Abbrev. | Keystroke | Description |
|------|----------|----------|------------|-------------|
| 80 | END | eN | E + Shift-N | End program |
| 81 | FOR | fO | F + Shift-O | Loop start |
| 82 | NEXT | nE | N + Shift-E | Loop end |
| 83 | DATA | dA | D + Shift-A | Literal data |
| 84 | INPUT# | iN | I + Shift-N | File input |
| 85 | INPUT | — | — | Keyboard input |
| 86 | DIM | dI | D + Shift-I | Array declaration |
| 87 | READ | rE | R + Shift-E | Read DATA |
| 88 | LET | lE | L + Shift-E | Assignment |
| 89 | GOTO | gO | G + Shift-O | Branch |
| 8A | RUN | rU | R + Shift-U | Execute program |
| 8B | IF | — | — | Conditional |
| 8C | RESTORE | reS | R,E + Shift-S | Reset DATA pointer |
| 8D | GOSUB | goS | G,O + Shift-S | Subroutine |
| 8E | RETURN | reT | R,E + Shift-T | Return |
| 8F | REM | — | — | Comment |
| 90 | STOP | sT | S + Shift-T | Halt |
| 91 | ON | — | — | Indexed branch |
| 92 | WAIT | wA | W + Shift-A | Wait for mask |
| 93 | LOAD | lO | L + Shift-O | Load file |
| 94 | SAVE | sA | S + Shift-A | Save file |
| 95 | VERIFY | vE | V + Shift-E | Verify file |
| 96 | DEF | dE | D + Shift-E | Define FN |
| 97 | POKE | pO | P + Shift-O | Write memory |
| 98 | PRINT# | pR | P + Shift-R | Output to file |
| 99 | PRINT | ? | ? key | Output to screen |
| 9A | CONT | cO | C + Shift-O | Continue |
| 9B | LIST | lI | L + Shift-I | List program |
| 9C | CLR | cL | C + Shift-L | Clear vars |
| 9D | CMD | cM | C + Shift-M | Redirect output |
| 9E | SYS | sY | S + Shift-Y | Call machine code |
| 9F | OPEN | oP | O + Shift-P | Open device |
| A0 | CLOSE | clO | C,L + Shift-O | Close device |
| A1 | GET | gE | G + Shift-E | Read char |
| A2 | NEW | — | — | Clear program |
| A3 | TAB( | tA | T + Shift-A | Tab cursor |
| A4 | TO | — | — | Range keyword |
| A5 | FN | — | — | Function prefix |
| A6 | SPC( | sP | S + Shift-P | Space in print |
| A7 | THEN | tH | T + Shift-H | IF branch |
| A8 | NOT | nO | N + Shift-O | Logical NOT |
| A9 | STEP | stE | S,T + Shift-E | Loop increment |
| AF | AND | aN | A + Shift-N | Logical AND |
| B0 | OR | — | — | Logical OR |
| B4 | SGN | sG | S + Shift-G | Sign |
| B5 | INT | — | — | Integer truncation |
| B6 | ABS | aB | A + Shift-B | Absolute |
| B7 | USR | uS | U + Shift-S | User routine |
| B8 | FRE | fR | F + Shift-R | Free memory |
| B9 | POS | — | — | Cursor position |
| BA | SQR | sQ | S + Shift-Q | Square root |
| BB | RND | rN | R + Shift-N | Random number |
| BC | LOG | — | — | Natural log |
| BD | EXP | eX | E + Shift-X | Exponent |
| BE | COS | — | — | Cosine |
| BF | SIN | sI | S  + Shift-I | Sine |
| C0 | TAN | — | — | Tangent |
| C1 | ATN | aT | A + Shift-T | Arctangent |
| C2 | PEEK | pE | P + Shift-E | Read memory |
| C3 | LEN | — | — | String length |
| C4 | STR$ | stR | S,T + Shift-R | Number→String |
| C5 | VAL | vA | V + Shift-A | String→Number |
| C6 | ASC | aS | A + Shift-S | ASCII code |
| C7 | CHR$ | cH | C + Shift-H | Code→Char |
| C8 | LEFT$ | leF | L,E + Shift-F | Left substring |
| C9 | RIGHT$ | rI | R + Shift-I | Right substring |
| CA | MID$ | mI | M + Shift-I | Middle substring |
| CB | GO | — | — | Used for GOTO/GOSUB |

---

## 8. System Constants and Status

| Name | Meaning | Typical Range |
|------|----------|----------------|
| `PI` | 3.14159265 | Constant (π character, token `$FF`) |
| `ST` | Device status byte | Bit6=EOF, Bit7=No device |
| `TI` | System tick counter | 1/60s resolution |
| `TI$` | Time string | "hhmmss" |
| `FRE(0)` | Free memory in bytes | 0–38911 |
| `TRUE` | −1 ($FFFF) | Boolean |
| `FALSE` | 0 | Boolean |

---

## 9. Validation Rules

- Line numbers: 0–63999.  
- Each program ends with `$0000` sentinel.  
- Parentheses depth ≤10.  
- Array redefinition prohibited.  
- Division by zero → runtime error.  
- Out-of-memory or string overflow → `?OUT OF MEMORY`.  
- Keyword collision in variable name → `?SYNTAX ERROR`.

---

## 10. Performance and Optimisation Guidelines

C64 BASIC V2 is fully interpreted and float-based. Optimise by reducing parsing, conversions, and heap movement. Every line lookup and variable access incurs cost; fast programs minimise interpreter work.

### 10.1 Execution Model

- Each line is linked; `GOTO`, `GOSUB`, `IF` search from start. Keep hot loops in low line numbers.
- Keywords are tokenised; variables and literals parsed at runtime.
- Numeric work is float unless explicitly integer; type conversions are slow.

### 10.2 Variables

- Only first two name letters count—use short names.
- Define scalars before arrays; new scalars shift arrays by 7 B each.
- Floats faster than integers; mixed arithmetic incurs conversion.
- `FRE(0)` scans all variables—use sparingly.
- Use 0 and −1 for Boolean logic.

### 10.3 Arrays

- Always `DIM`; undeclared arrays auto-DIM 11 elements per dimension.
- Re-DIM → error; index 0–32767 only.
- Keep dimensions small and fixed; leftmost index varies fastest.

### 10.4 Arithmetic

- Replace `^` with multiplication; pre-compute constants and function results.
- `INT(X)` faster than truncation math; avoid mixing ints/floats.
- Keep loops tight; each iteration re-parses expressions.

### 10.5 Strings

- Heap grows downward; garbage collection runs when it is exhausted and on `FRE()`.
- Avoid `A$=A$+B$` in loops; prefer `PRINT A$;B$`.
- Reuse string vars; overwrite via `MID$` instead of reallocating.
- Use `CLR` to reclaim heap; `LEFT$/RIGHT$/MID$` create new descriptors—use sparingly.

### 10.6 Control Flow

- Prefer `FOR…NEXT` to manual `GOTO` loops.
- Keep `IF` expressions short; parser re-evaluates every branch.
- Combine short statements with `:` (< 80 chars per line).
- Limit nesting depth (< 5) for readability and speed.

### 10.7 Program Structure & I/O

- Put constants/setup early; `DATA` and rarely used routines last.
- Remove `REM` in loops; still parsed.
- Minimise disk/tape/printer I/O; buffer in memory.
- `CMD` redirection is slow—set once.
- Avoid frequent `TI$`; use loop counters instead.
- Use `SYS` for time-critical routines.

### 10.8 Memory Use

- Each scalar = 7 B; arrays store only element data.
- Pack short related statements on one line.
- Use abbreviations (`?`, `gO`, `sT`) to stay within 80 chars.
- Maintain ≥ 50 % free RAM for string heap stability.
- Call `CLR` to drop unused variables.

### 10.9 Summary

Fast BASIC = minimal parsing, fixed data, short names, reused strings, few allocations.  
Define vars early, pre-DIM arrays, keep loops shallow, and avoid heap churn.  
Typical speed gain: 2–5× over unoptimised code.

---

## 11. Writing Games Efficiently in BASIC

C64 BASIC games rely on careful screen, input, and timing control. Interpreter speed limits frame rate; optimise for responsiveness, not raw throughput.

### 11.1 Core Strategy

- BASIC handles logic; graphics/sound via `POKE` to hardware.
- Use fixed variables and arrays; avoid runtime string creation.
- Keep main loop short and predictable.

### 11.2 Screen Handling

- Screen RAM $0400 (1024 dec); Colour RAM $D800 (55296 dec).
- `PRINT` is slow; use direct writes:

  ```basic
  POKE1024+X+40*Y,CHR
  POKE55296+X+40*Y,COLOR
  ```

- Redraw only modified cells; update deltas, not full screen.
- For static backgrounds, draw once, then update moving parts.
- To clear screen, loop over $0400/$D800 ranges.

### 11.3 Delta Updates

- Track old/new positions; erase previous cell, draw new one.
- Use flags or small arrays for active objects only.
- Skip unchanged elements; BASIC loops are costly.

### 11.4 Timing (Delays)

- **Do not delay by default**—BASIC is slower than 50 Hz refresh.
- Add timing only for pacing (slow motion, animation rhythm, cross-platform consistency, or sync with music).  
- Implement fixed-step gating, not busy-waits:

  ```basic
  IF TI-T0>=N THEN T0=TI:GOSUB UPDATE
  ```

  → limits maximum update rate without freezing input.
- Avoid `FOR T=1 TO N:NEXT` and tight wait loops; they waste CPU.
- If the game already runs slower than `N`, no wait occurs.

### 11.5 Movement & Input

- Move by arithmetic deltas (`X=X+DX`); keep signed `DX/DY`.
- Keyboard: `GET A$` (non-blocking). Avoid `INPUT`.

  ```basic
  GETK$:IFK$<>""THEN...
  ```

- Joystick port 2 @ $DC00 (56320):

  | Bit | Function | Mask |
  |------|-----------|------|
  | 0 | Up | 1 |
  | 1 | Down | 2 |
  | 2 | Left | 4 |
  | 3 | Right | 8 |
  | 4 | Fire | 16 |
  Example:  
  `J=PEEK(56320):IF(JAND1)=0THENPY=PY-1`

### 11.6 Sprites & Graphics

- VIC sprite enable $D015; positions $D000–$D00F; colours $D027–$D02E.
- Pre-load sprite data; update only X/Y each frame via `POKE`.
- VIC renders asynchronously—BASIC handles motion logic only.

### 11.7 Sound

- SID base $D400.  
- Store freq/envelope tables in DATA or arrays; `POKE` directly each frame.

### 11.8 Memory & Performance

- Use integer arrays for coordinates/counters.  
- Keep < 26 variables for faster lookup.  
- Avoid `PRINT` during play; write HUD directly to screen RAM.  
- For scrolling, shift indices or viewport pointers instead of copying memory.  
- Reuse data structures; avoid new strings inside loop.

### 11.9 Example Loop Skeleton

```basic
10 T0=TI:GETK$
20 GOSUB1000:REM LOGIC
30 GOSUB2000:REM DRAW
40 IF TI-T0<2 THEN GOTO40
50 GOTO10
```

→ adds frame pacing only if motion needs slowing.

### 11.10 Summary

Efficient BASIC games minimise interpreter overhead.  
Use `POKE/PEEK` for graphics and input, delta redraw for movement, fixed-step gating only when required, and pre-allocated variables for state.  
Result: smooth, responsive gameplay within BASIC’s limits.

# 6510 Assembly Language

## Overview

MOS 6510 (C64 CPU) is a NMOS 6502 core with an 8‑bit data path and a 16‑bit address space (64 KiB). Registers: `A`, `X`, `Y` (8‑bit), `PC` (16‑bit), `SP` (8‑bit, stack at `$0100..$01FF`), `P` status `[N V - B D I Z C]`. The stack grows downward; pushes write to `$0100+SP` then decrement `SP`.

## Lexical Conventions

- **Numbers:** decimal `42`, hexadecimal `$2A`, binary `%00101010`. Immediate prefix `#`.
- **Identifiers:** `[A–Z_][A–Z0–9_]*` (case‑insensitive).  
- **Labels:** an identifier followed by `:` defines the current address. Reference with the bare identifier (optionally signed offsets in expressions).
- **Comments:** `;` to end of line. Whitespace is insignificant except as separator.
- **Expressions:** integers with `+ - * / & | ^ ~ << >>` and parentheses (assembler‑dependent), may refer to labels and the current location counter `*`.

## Addressing Modes (names and syntax)

| Abbrev | Name | Operand Syntax | Example |
|---|---|---|---|
| `A` | Accumulator | `A` or omitted | `ASL A` / `ASL` |
| `#` | Immediate | `#byte` | `LDA #$0F` |
| `ZP` | Zeropage | `$LL` | `LDA $00` |
| `ZPX` | Zeropage,X | `$LL,X` | `LDA $10,X` |
| `ZPY` | Zeropage,Y | `$LL,Y` | `LDX $10,Y` |
| `ABS` | Absolute | `$HHLL` | `LDA $C000` |
| `ABSX` | Absolute,X | `$HHLL,X` | `LDA $D000,X` |
| `ABSY` | Absolute,Y | `$HHLL,Y` | `LDA $D000,Y` |
| `IND` | Indirect | `($HHLL)` | `JMP ($FFFC)` |
| `IZX` | (ZP,X) | `($LL,X)` | `LDA ($40,X)` |
| `IZY` | (ZP),Y | `($LL),Y` | `LDA ($40),Y` |
| `REL` | Relative | label | `BEQ done` |
| `IMP` | Implied | — | `CLC` |

*6510 `JMP (addr)` has the classic page‑wrap bug at `$xxFF → $xx00`.*

## Labels and Symbol Rules

- **Definition:** `label:` binds `label` to the current address (`*`). Multiple labels may precede an instruction.
- **Use:** Any place an absolute/relative/address expression is expected (`LDA label`, `BEQ loop`).
- **Forward refs:** allowed; assembler resolves in a second pass.
- **Constants:** `name = expr` or `.equ name, expr` (assembler‑specific). Location counter may be set with `.org expr`. Data directives: `.byte`, `.word`, `.fill`, `.align` (names may vary).

## Instruction Semantics (brief)

- **Load/Store:** `LDA/LDX/LDY` load; `STA/STX/STY` store. Affect `N,Z` (stores don’t).
- **ALU:** `ADC/SBC` (use `CLC`/`SEC` before add/sub), `AND/ORA/EOR`, `INC/DEC` (memory), `INX/INY/DEX/DEY` (registers). Flags as per 6502.
- **Shifts/Rotates:** `ASL/LSR/ROL/ROR` on `A` or memory. Shifted‑out bit enters `C`.
- **Compare:** `CMP/CPX/CPY` set `C` for ≥, `Z` for =, `N` for sign of result (no writeback).
- **Branch:** `BPL/BMI/BVC/BVS/BCC/BCS/BNE/BEQ` use signed 8‑bit `REL` offset (−128..+127 from `PC+2`). Taken branch +1 cycle; +1 more if page crosses.
- **Jumps/Calls:** `JMP` `ABS|IND`, `JSR ABS`, `RTS`, `BRK`/`RTI`.
- **Stack/Flags/Xfer:** `PHA/PLA`, `PHP/PLP`, `TAX/TAY/TXA/TYA`, `TSX/TXS`, `CLC/SEC/CLI/SEI/CLD/SED/CLV`, `NOP`.
- **Decimal mode:** C64 typically keeps `D=0` (`CLD`). Use BCD only if intentional.

## EBNF (assembly source)

```ebnf
program     = { line } ;
line        = [ label ] , [ instruction | directive ] , [ comment ] , EOL ;
label       = identifier , ":" ;
instruction = mnemonic , [ operand ] ;
directive   = "." , ident , [ operandlist ] ;

operand     = expr
            | "#" , byte
            | "(" , expr , ")"                          (* IND for JMP *)
            | "(" , zp , "," , "X" , ")"                (* IZX *)
            | "(" , zp , ")" , "," , "Y"                (* IZY *)
            | expr , "," , "X"                          (* ABSX or ZPX *)
            | expr , "," , "Y"                          (* ABSY or ZPY *)
            ;
operandlist = expr , { "," , expr } ;

expr        = term , { ("+"|"-"|"|"|"^") , term } ;
term        = factor , { ("*"|"/"|"&") , factor } ;
factor      = ["+"|"-"|"~"] , primary ;
primary     = number | identifier | "(" , expr , ")" | "*" ;

mnemonic    = "ADC"|"AND"|"ASL"|"BCC"|"BCS"|"BEQ"|"BIT"|"BMI"|"BNE"|"BPL"|
              "BRK"|"BVC"|"BVS"|"CLC"|"CLD"|"CLI"|"CLV"|"CMP"|"CPX"|"CPY"|
              "DEC"|"DEX"|"DEY"|"EOR"|"INC"|"INX"|"INY"|"JMP"|"JSR"|"LDA"|
              "LDX"|"LDY"|"LSR"|"NOP"|"ORA"|"PHA"|"PHP"|"PLA"|"PLP"|"ROL"|
              "ROR"|"RTI"|"RTS"|"SBC"|"SEC"|"SED"|"SEI"|"STA"|"STX"|"STY"|
              "TAX"|"TAY"|"TSX"|"TXA"|"TXS"|"TYA" ;

identifier  = ( "A".."Z" | "_" ) , { "A".."Z" | "0".."9" | "_" } ;
number      = dec | "$" hex | "%" bin ;
dec         = "0".."9" , { "0".."9" } ;
hex         = hexDigit , { hexDigit } ;
bin         = "0"|"1" , { "0"|"1" } ;
hexDigit    = "0".."9" | "A".."F" ;
byte        = number ;      (* assembler validates range *)
zp          = number ;      (* assembler may restrict to 0..255 for ZP *)
comment     = ";" , { any-not-EOL } ;
EOL         = "\n" ;
```

---

## Tokenization

### Addressing‑Mode Profiles (bytes/cycles)

Unless noted, page cross on `ABSX/ABSY/IZY` adds **+1** cycle.

| Group | Mode → bytes/cycles | Notes |
|---|---|---|
| **ALU (ADC,AND,CMP,EOR,LDA,ORA,SBC)** | `#` 2/2 · `ZP` 2/3 · `ZPX` 2/4 · `ABS` 3/4 · `ABSX` 3/4+ · `ABSY` 3/4+ · `IZX` 2/6 · `IZY` 2/5+ | CMP shares counts; LDA as listed. |
| **STA** | `ZP` 2/3 · `ZPX` 2/4 · `ABS` 3/4 · `ABSX` 3/5 · `ABSY` 3/5 · `IZX` 2/6 · `IZY` 2/6 | Store does **not** set `N,Z`. |
| **STX** | `ZP` 2/3 · `ZPY` 2/4 · `ABS` 3/4 | |
| **STY** | `ZP` 2/3 · `ZPX` 2/4 · `ABS` 3/4 | |
| **LDX** | `#` 2/2 · `ZP` 2/3 · `ZPY` 2/4 · `ABS` 3/4 · `ABSY` 3/4+ | |
| **LDY** | `#` 2/2 · `ZP` 2/3 · `ZPX` 2/4 · `ABS` 3/4 · `ABSX` 3/4+ | |
| **INC/DEC (mem)** | `ZP` 2/5 · `ZPX` 2/6 · `ABS` 3/6 · `ABSX` 3/7 | |
| **INX/INY/DEX/DEY** | `IMP` 1/2 | |
| **ASL/LSR/ROL/ROR** | `A` 1/2 · `ZP` 2/5 · `ZPX` 2/6 · `ABS` 3/6 · `ABSX` 3/7 | |
| **BIT** | `ZP` 2/3 · `ABS` 3/4 | On 6510 only ZP/ABS. |
| **JMP** | `ABS` 3/3 · `IND` 3/5 | Buggy wrap on `IND`. |
| **JSR/RTS/RTI/BRK** | `JSR ABS` 3/6 · `RTS` 1/6 · `RTI` 1/6 · `BRK` 1/7 | |
| **Branches (Bcc)** | `REL` 2/2(+1 taken, +1 xpage) | |
| **Flag ops** | `IMP` 1/2 | `CLC,CLD,CLI,CLV,SEC,SED,SEI` |
| **Stack ops** | `PHA,PHP` 1/3 · `PLA,PLP` 1/4 | |
| **Transfers** | `TAX,TAY,TXA,TYA,TSX,TXS` 1/2 | |
| **NOP** | `IMP` 1/2 | Documented form only. |

### Opcode × Addressing‑Mode Matrix (✓ = supported on 6510)

Modes (columns): `A  #  ZP ZPX ZPY ABS ABSX ABSY IND IZX IZY REL IMP`

| Mnemonic |A|#|ZP|ZPX|ZPY|ABS|ABSX|ABSY|IND|IZX|IZY|REL|IMP|
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| ADC | |✓|✓|✓| |✓|✓|✓| |✓|✓| | |
| AND | |✓|✓|✓| |✓|✓|✓| |✓|✓| | |
| ASL |✓| |✓|✓| |✓|✓| | | | | | |
| BCC | | | | | | | | | | | |✓| |
| BCS | | | | | | | | | | | |✓| |
| BEQ | | | | | | | | | | | |✓| |
| BIT | | |✓| | |✓| | | | | | | |
| BMI | | | | | | | | | | | |✓| |
| BNE | | | | | | | | | | | |✓| |
| BPL | | | | | | | | | | | |✓| |
| BRK | | | | | | | | | | | | |✓|
| BVC | | | | | | | | | | | |✓| |
| BVS | | | | | | | | | | | |✓| |
| CLC | | | | | | | | | | | | |✓|
| CLD | | | | | | | | | | | | |✓|
| CLI | | | | | | | | | | | | |✓|
| CLV | | | | | | | | | | | | |✓|
| CMP | |✓|✓|✓| |✓|✓|✓| |✓|✓| | |
| CPX | |✓|✓| | |✓| | | | | | | |
| CPY | |✓|✓| | |✓| | | | | | | |
| DEC | | |✓|✓| |✓|✓| | | | | | |
| DEX | | | | | | | | | | | | |✓|
| DEY | | | | | | | | | | | | |✓|
| EOR | |✓|✓|✓| |✓|✓|✓| |✓|✓| | |
| INC | | |✓|✓| |✓|✓| | | | | | |
| INX | | | | | | | | | | | | |✓|
| INY | | | | | | | | | | | | |✓|
| JMP | | | | | |✓| |✓|✓| | | | |
| JSR | | | | | |✓| | | | | | | |
| LDA | |✓|✓|✓| |✓|✓|✓| |✓|✓| | |
| LDX | |✓|✓| |✓|✓| |✓| | | | | |
| LDY | |✓|✓|✓| |✓|✓| | | | | | |
| LSR |✓| |✓|✓| |✓|✓| | | | | | |
| NOP | | | | | | | | | | | | |✓|
| ORA | |✓|✓|✓| |✓|✓|✓| |✓|✓| | |
| PHA | | | | | | | | | | | | |✓|
| PHP | | | | | | | | | | | | |✓|
| PLA | | | | | | | | | | | | |✓|
| PLP | | | | | | | | | | | | |✓|
| ROL |✓| |✓|✓| |✓|✓| | | | | | |
| ROR |✓| |✓|✓| |✓|✓| | | | | | |
| RTI | | | | | | | | | | | | |✓|
| RTS | | | | | | | | | | | | |✓|
| SBC | |✓|✓|✓| |✓|✓|✓| |✓|✓| | |
| SEC | | | | | | | | | | | | |✓|
| SED | | | | | | | | | | | | |✓|
| SEI | | | | | | | | | | | | |✓|
| STA | | |✓|✓| |✓|✓|✓| |✓|✓| | |
| STX | | |✓| |✓|✓| | | | | | | |
| STY | | |✓|✓| |✓| | | | | | | |
| TAX | | | | | | | | | | | | |✓|
| TAY | | | | | | | | | | | | |✓|
| TSX | | | | | | | | | | | | |✓|
| TXA | | | | | | | | | | | | |✓|
| TXS | | | | | | | | | | | | |✓|
| TYA | | | | | | | | | | | | |✓|

### Opcode Decode Table

#### Scope

- Table order is strictly ascending by opcode from `00` to `FF`.
- `IMM` is the canonical mode token for **immediate** addressing.
- Elsewhere in the spec, immediate operands may be written with `#`, e.g. `LDA #$01`.
- `cycles` is the base cycle count.
- `page_cross_penalty` is only populated where an extra cycle can occur due to page crossing or branch flow.
- `KIL` does not complete normal execution; `cycles=halt`.

#### Semantic Conventions

- `M` = operand value after address resolution
- `[EA]` = memory at effective address
- `EA.hi` = high byte of effective address
- `push(x)` / `pop` / `pop16` = stack operations
- `set(...)` = update listed flags from result
- `ROL(x)` / `ROR(x)` = rotate through carry
- `rel` = signed relative branch displacement
- Unofficial unstable opcodes are marked explicitly with `unstable;`

#### Table Format

```text
opcode mnemonic mode flags cycles page_cross_penalty semantics
```

#### Table

```text
00 BRK IMP O 7 - interrupt; push(PC+2,P|B); I←1; PC←[FFFE]
01 ORA IZX O 6 - A←A|M; set(Z,N)
02 KIL IMP U,H halt - halt
03 SLO IZX U 8 - M←M<<1; A←A|M; set(C,Z,N)
04 NOP ZP U 3 - no-op
05 ORA ZP O 3 - A←A|M; set(Z,N)
06 ASL ZP O 5 - M←M<<1; set(C,Z,N)
07 SLO ZP U 5 - M←M<<1; A←A|M; set(C,Z,N)
08 PHP IMP O 3 - push(P|B)
09 ORA IMM O 2 - A←A|M; set(Z,N)
0A ASL A O 2 - A←A<<1; set(C,Z,N)
0B ANC IMM U 2 - A←A&#; C←bit7(A); set(Z,N)
0C NOP ABS U 4 - no-op
0D ORA ABS O 4 - A←A|M; set(Z,N)
0E ASL ABS O 6 - M←M<<1; set(C,Z,N)
0F SLO ABS U 6 - M←M<<1; A←A|M; set(C,Z,N)
10 BPL REL O 2 +1 if branch taken; +1 more if page-cross if N=0 then PC←PC+rel
11 ORA IZY O 5 +1 if page-cross A←A|M; set(Z,N)
12 KIL IMP U,H halt - halt
13 SLO IZY U 8 - M←M<<1; A←A|M; set(C,Z,N)
14 NOP ZPX U 4 - no-op
15 ORA ZPX O 4 - A←A|M; set(Z,N)
16 ASL ZPX O 6 - M←M<<1; set(C,Z,N)
17 SLO ZPX U 6 - M←M<<1; A←A|M; set(C,Z,N)
18 CLC IMP O 2 - C←0
19 ORA ABSY O 4 +1 if page-cross A←A|M; set(Z,N)
1A NOP IMP U 2 - no-op
1B SLO ABSY U 7 - M←M<<1; A←A|M; set(C,Z,N)
1C NOP ABSX U 4 +1 if page-cross no-op
1D ORA ABSX O 4 +1 if page-cross A←A|M; set(Z,N)
1E ASL ABSX O 7 - M←M<<1; set(C,Z,N)
1F SLO ABSX U 7 - M←M<<1; A←A|M; set(C,Z,N)
20 JSR ABS O 6 - push(PC-1); PC←EA
21 AND IZX O 6 - A←A&M; set(Z,N)
22 KIL IMP U,H halt - halt
23 RLA IZX U 8 - M←ROL(M); A←A&M; set(C,Z,N)
24 BIT ZP O 3 - Z←(A&M)=0; N←bit7(M); V←bit6(M)
25 AND ZP O 3 - A←A&M; set(Z,N)
26 ROL ZP O 5 - M←ROL(M); set(C,Z,N)
27 RLA ZP U 5 - M←ROL(M); A←A&M; set(C,Z,N)
28 PLP IMP O 4 - P←pop
29 AND IMM O 2 - A←A&#; set(Z,N)
2A ROL A O 2 - A←ROL(A); set(C,Z,N)
2B ANC IMM U 2 - A←A&#; C←bit7(A); set(Z,N)
2C BIT ABS O 4 - Z←(A&M)=0; N←bit7(M); V←bit6(M)
2D AND ABS O 4 - A←A&M; set(Z,N)
2E ROL ABS O 6 - M←ROL(M); set(C,Z,N)
2F RLA ABS U 6 - M←ROL(M); A←A&M; set(C,Z,N)
30 BMI REL O 2 +1 if branch taken; +1 more if page-cross if N=1 then PC←PC+rel
31 AND IZY O 5 +1 if page-cross A←A&M; set(Z,N)
32 KIL IMP U,H halt - halt
33 RLA IZY U 8 - M←ROL(M); A←A&M; set(C,Z,N)
34 NOP ZPX U 4 - no-op
35 AND ZPX O 4 - A←A&M; set(Z,N)
36 ROL ZPX O 6 - M←ROL(M); set(C,Z,N)
37 RLA ZPX U 6 - M←ROL(M); A←A&M; set(C,Z,N)
38 SEC IMP O 2 - C←1
39 AND ABSY O 4 +1 if page-cross A←A&M; set(Z,N)
3A NOP IMP U 2 - no-op
3B RLA ABSY U 7 - M←ROL(M); A←A&M; set(C,Z,N)
3C NOP ABSX U 4 +1 if page-cross no-op
3D AND ABSX O 4 +1 if page-cross A←A&M; set(Z,N)
3E ROL ABSX O 7 - M←ROL(M); set(C,Z,N)
3F RLA ABSX U 7 - M←ROL(M); A←A&M; set(C,Z,N)
40 RTI IMP O 6 - P←pop; PC←pop16
41 EOR IZX O 6 - A←A^M; set(Z,N)
42 KIL IMP U,H halt - halt
43 SRE IZX U 8 - M←M>>1; A←A^M; set(C,Z,N)
44 NOP ZP U 3 - no-op
45 EOR ZP O 3 - A←A^M; set(Z,N)
46 LSR ZP O 5 - M←M>>1; set(C,Z,N)
47 SRE ZP U 5 - M←M>>1; A←A^M; set(C,Z,N)
48 PHA IMP O 3 - push(A)
49 EOR IMM O 2 - A←A^M; set(Z,N)
4A LSR A O 2 - A←A>>1; set(C,Z,N)
4B ALR IMM U 2 - A←(A&#)>>1; set(C,Z,N)
4C JMP ABS O 3 - PC←EA
4D EOR ABS O 4 - A←A^M; set(Z,N)
4E LSR ABS O 6 - M←M>>1; set(C,Z,N)
4F SRE ABS U 6 - M←M>>1; A←A^M; set(C,Z,N)
50 BVC REL O 2 +1 if branch taken; +1 more if page-cross if V=0 then PC←PC+rel
51 EOR IZY O 5 +1 if page-cross A←A^M; set(Z,N)
52 KIL IMP U,H halt - halt
53 SRE IZY U 8 - M←M>>1; A←A^M; set(C,Z,N)
54 NOP ZPX U 4 - no-op
55 EOR ZPX O 4 - A←A^M; set(Z,N)
56 LSR ZPX O 6 - M←M>>1; set(C,Z,N)
57 SRE ZPX U 6 - M←M>>1; A←A^M; set(C,Z,N)
58 CLI IMP O 2 - I←0
59 EOR ABSY O 4 +1 if page-cross A←A^M; set(Z,N)
5A NOP IMP U 2 - no-op
5B SRE ABSY U 7 - M←M>>1; A←A^M; set(C,Z,N)
5C NOP ABSX U 4 +1 if page-cross no-op
5D EOR ABSX O 4 +1 if page-cross A←A^M; set(Z,N)
5E LSR ABSX O 7 - M←M>>1; set(C,Z,N)
5F SRE ABSX U 7 - M←M>>1; A←A^M; set(C,Z,N)
60 RTS IMP O 6 - PC←pop16+1
61 ADC IZX O 6 - A←A+M+C; set(C,Z,N,V)
62 KIL IMP U,H halt - halt
63 RRA IZX U 8 - M←ROR(M); A←A+M+C; set(C,Z,N,V)
64 NOP ZP U 3 - no-op
65 ADC ZP O 3 - A←A+M+C; set(C,Z,N,V)
66 ROR ZP O 5 - M←ROR(M); set(C,Z,N)
67 RRA ZP U 5 - M←ROR(M); A←A+M+C; set(C,Z,N,V)
68 PLA IMP O 4 - A←pop; set(Z,N)
69 ADC IMM O 2 - A←A+#+C; set(C,Z,N,V)
6A ROR A O 2 - A←ROR(A); set(C,Z,N)
6B ARR IMM U 2 - A←ROR(A&#); C←bit6(A); V←bit6(A)^bit5(A); set(Z,N)
6C JMP IND O 5 - PC←EA
6D ADC ABS O 4 - A←A+M+C; set(C,Z,N,V)
6E ROR ABS O 6 - M←ROR(M); set(C,Z,N)
6F RRA ABS U 6 - M←ROR(M); A←A+M+C; set(C,Z,N,V)
70 BVS REL O 2 +1 if branch taken; +1 more if page-cross if V=1 then PC←PC+rel
71 ADC IZY O 5 +1 if page-cross A←A+M+C; set(C,Z,N,V)
72 KIL IMP U,H halt - halt
73 RRA IZY U 8 - M←ROR(M); A←A+M+C; set(C,Z,N,V)
74 NOP ZPX U 4 - no-op
75 ADC ZPX O 4 - A←A+M+C; set(C,Z,N,V)
76 ROR ZPX O 6 - M←ROR(M); set(C,Z,N)
77 RRA ZPX U 6 - M←ROR(M); A←A+M+C; set(C,Z,N,V)
78 SEI IMP O 2 - I←1
79 ADC ABSY O 4 +1 if page-cross A←A+M+C; set(C,Z,N,V)
7A NOP IMP U 2 - no-op
7B RRA ABSY U 7 - M←ROR(M); A←A+M+C; set(C,Z,N,V)
7C NOP ABSX U 4 +1 if page-cross no-op
7D ADC ABSX O 4 +1 if page-cross A←A+M+C; set(C,Z,N,V)
7E ROR ABSX O 7 - M←ROR(M); set(C,Z,N)
7F RRA ABSX U 7 - M←ROR(M); A←A+M+C; set(C,Z,N,V)
80 NOP IMM U 2 - no-op
81 STA IZX O 6 - [EA]←A
82 NOP IMM U 2 - no-op
83 SAX IZX U 6 - [EA]←A&X
84 STY ZP O 3 - [EA]←Y
85 STA ZP O 3 - [EA]←A
86 STX ZP O 3 - [EA]←X
87 SAX ZP U 3 - [EA]←A&X
88 DEY IMP O 2 - Y←Y-1; set(Z,N)
89 NOP IMM U 2 - no-op
8A TXA IMP O 2 - A←X; set(Z,N)
8B XAA IMM U 2 - unstable; A←X&#; set(Z,N)
8C STY ABS O 4 - [EA]←Y
8D STA ABS O 4 - [EA]←A
8E STX ABS O 4 - [EA]←X
8F SAX ABS U 4 - [EA]←A&X
90 BCC REL O 2 +1 if branch taken; +1 more if page-cross if C=0 then PC←PC+rel
91 STA IZY O 6 - [EA]←A
92 KIL IMP U,H halt - halt
93 AHX IZY U,S 6 - unstable; [EA]←A&X&(EA.hi+1)
94 STY ZPX O 4 - [EA]←Y
95 STA ZPX O 4 - [EA]←A
96 STX ZPY O 4 - [EA]←X
97 SAX ZPY U 4 - [EA]←A&X
98 TYA IMP O 2 - A←Y; set(Z,N)
99 STA ABSY O 5 - [EA]←A
9A TXS IMP O 2 - SP←X
9B TAS ABSY U,S 5 - unstable; SP←A&X; [EA]←SP&(EA.hi+1)
9C SHY ABSX U,S 5 - unstable; [EA]←Y&(EA.hi+1)
9D STA ABSX O 5 - [EA]←A
9E SHX ABSY U,S 5 - unstable; [EA]←X&(EA.hi+1)
9F AHX ABSY U,S 5 - unstable; [EA]←A&X&(EA.hi+1)
A0 LDY IMM O 2 - Y←#; set(Z,N)
A1 LDA IZX O 6 - A←M; set(Z,N)
A2 LDX IMM O 2 - X←#; set(Z,N)
A3 LAX IZX U 6 - A←M; X←M; set(Z,N)
A4 LDY ZP O 3 - Y←M; set(Z,N)
A5 LDA ZP O 3 - A←M; set(Z,N)
A6 LDX ZP O 3 - X←M; set(Z,N)
A7 LAX ZP U 3 - A←M; X←M; set(Z,N)
A8 TAY IMP O 2 - Y←A; set(Z,N)
A9 LDA IMM O 2 - A←#; set(Z,N)
AA TAX IMP O 2 - X←A; set(Z,N)
AB LAX IMM U 2 - A←#; X←#; set(Z,N)
AC LDY ABS O 4 - Y←M; set(Z,N)
AD LDA ABS O 4 - A←M; set(Z,N)
AE LDX ABS O 4 - X←M; set(Z,N)
AF LAX ABS U 4 - A←M; X←M; set(Z,N)
B0 BCS REL O 2 +1 if branch taken; +1 more if page-cross if C=1 then PC←PC+rel
B1 LDA IZY O 5 +1 if page-cross A←M; set(Z,N)
B2 KIL IMP U,H halt - halt
B3 LAX IZY U 5 +1 if page-cross A←M; X←M; set(Z,N)
B4 LDY ZPX O 4 - Y←M; set(Z,N)
B5 LDA ZPX O 4 - A←M; set(Z,N)
B6 LDX ZPY O 4 - X←M; set(Z,N)
B7 LAX ZPY U 4 - A←M; X←M; set(Z,N)
B8 CLV IMP O 2 - V←0
B9 LDA ABSY O 4 +1 if page-cross A←M; set(Z,N)
BA TSX IMP O 2 - X←SP; set(Z,N)
BB LAS ABSY U 4 +1 if page-cross unstable; A←M&SP; X←A; SP←A; set(Z,N)
BC LDY ABSX O 4 +1 if page-cross Y←M; set(Z,N)
BD LDA ABSX O 4 +1 if page-cross A←M; set(Z,N)
BE LDX ABSY O 4 +1 if page-cross X←M; set(Z,N)
BF LAX ABSY U 4 +1 if page-cross A←M; X←M; set(Z,N)
C0 CPY IMM O 2 - tmp←Y-#; set(C,Z,N)
C1 CMP IZX O 6 - tmp←A-M; set(C,Z,N)
C2 NOP IMM U 2 - no-op
C3 DCP IZX U 8 - M←M-1; tmp←A-M; set(C,Z,N)
C4 CPY ZP O 3 - tmp←Y-M; set(C,Z,N)
C5 CMP ZP O 3 - tmp←A-M; set(C,Z,N)
C6 DEC ZP O 5 - M←M-1; set(Z,N)
C7 DCP ZP U 5 - M←M-1; tmp←A-M; set(C,Z,N)
C8 INY IMP O 2 - Y←Y+1; set(Z,N)
C9 CMP IMM O 2 - tmp←A-#; set(C,Z,N)
CA DEX IMP O 2 - X←X-1; set(Z,N)
CB AXS IMM U 2 - X←(A&X)-#; set(C,Z,N)
CC CPY ABS O 4 - tmp←Y-M; set(C,Z,N)
CD CMP ABS O 4 - tmp←A-M; set(C,Z,N)
CE DEC ABS O 6 - M←M-1; set(Z,N)
CF DCP ABS U 6 - M←M-1; tmp←A-M; set(C,Z,N)
D0 BNE REL O 2 +1 if branch taken; +1 more if page-cross if Z=0 then PC←PC+rel
D1 CMP IZY O 5 +1 if page-cross tmp←A-M; set(C,Z,N)
D2 KIL IMP U,H halt - halt
D3 DCP IZY U 8 - M←M-1; tmp←A-M; set(C,Z,N)
D4 NOP ZPX U 4 - no-op
D5 CMP ZPX O 4 - tmp←A-M; set(C,Z,N)
D6 DEC ZPX O 6 - M←M-1; set(Z,N)
D7 DCP ZPX U 6 - M←M-1; tmp←A-M; set(C,Z,N)
D8 CLD IMP O 2 - D←0
D9 CMP ABSY O 4 +1 if page-cross tmp←A-M; set(C,Z,N)
DA NOP IMP U 2 - no-op
DB DCP ABSY U 7 - M←M-1; tmp←A-M; set(C,Z,N)
DC NOP ABSX U 4 +1 if page-cross no-op
DD CMP ABSX O 4 +1 if page-cross tmp←A-M; set(C,Z,N)
DE DEC ABSX O 7 - M←M-1; set(Z,N)
DF DCP ABSX U 7 - M←M-1; tmp←A-M; set(C,Z,N)
E0 CPX IMM O 2 - tmp←X-#; set(C,Z,N)
E1 SBC IZX O 6 - A←A-M-(1-C); set(C,Z,N,V)
E2 NOP IMM U 2 - no-op
E3 ISC IZX U 8 - M←M+1; A←A-M-(1-C); set(C,Z,N,V)
E4 CPX ZP O 3 - tmp←X-M; set(C,Z,N)
E5 SBC ZP O 3 - A←A-M-(1-C); set(C,Z,N,V)
E6 INC ZP O 5 - M←M+1; set(Z,N)
E7 ISC ZP U 5 - M←M+1; A←A-M-(1-C); set(C,Z,N,V)
E8 INX IMP O 2 - X←X+1; set(Z,N)
E9 SBC IMM O 2 - A←A-#-(1-C); set(C,Z,N,V)
EA NOP IMP O 2 - no-op
EB SBC IMM U 2 - A←A-#-(1-C); set(C,Z,N,V)
EC CPX ABS O 4 - tmp←X-M; set(C,Z,N)
ED SBC ABS O 4 - A←A-M-(1-C); set(C,Z,N,V)
EE INC ABS O 6 - M←M+1; set(Z,N)
EF ISC ABS U 6 - M←M+1; A←A-M-(1-C); set(C,Z,N,V)
F0 BEQ REL O 2 +1 if branch taken; +1 more if page-cross if Z=1 then PC←PC+rel
F1 SBC IZY O 5 +1 if page-cross A←A-M-(1-C); set(C,Z,N,V)
F2 KIL IMP U,H halt - halt
F3 ISC IZY U 8 - M←M+1; A←A-M-(1-C); set(C,Z,N,V)
F4 NOP ZPX U 4 - no-op
F5 SBC ZPX O 4 - A←A-M-(1-C); set(C,Z,N,V)
F6 INC ZPX O 6 - M←M+1; set(Z,N)
F7 ISC ZPX U 6 - M←M+1; A←A-M-(1-C); set(C,Z,N,V)
F8 SED IMP O 2 - D←1
F9 SBC ABSY O 4 +1 if page-cross A←A-M-(1-C); set(C,Z,N,V)
FA NOP IMP U 2 - no-op
FB ISC ABSY U 7 - M←M+1; A←A-M-(1-C); set(C,Z,N,V)
FC NOP ABSX U 4 +1 if page-cross no-op
FD SBC ABSX O 4 +1 if page-cross A←A-M-(1-C); set(C,Z,N,V)
FE INC ABSX O 7 - M←M+1; set(Z,N)
FF ISC ABSX U 7 - M←M+1; A←A-M-(1-C); set(C,Z,N,V)
```

### Vector Entry Points (C64)

- NMI `$FFFA/B`, RESET `$FFFC/D`, IRQ/BRK `$FFFE/F`. After RESET, execution starts at vector `$FFFC` (KERNAL init).

### Minimal Directives (common)

- Location: `.org addr` / `* = addr`  
- Data: `.byte expr[,…]`, `.word expr[,…]`  
- Symbols: `name = expr` / `.equ name, expr`  
- Alignment/fill (assembler‑specific): `.align n`, `.fill count, value`

## Tips and Tricks

### Basic Start Header

- PRG file = 2-byte little-endian load address + bytes
- Place a tokenized BASIC line at $0801, e.g. `10 SYS 4096` (token SYS = $9E) to jump to $1000
- Ensure load-address at PRG start matches where BASIC was placed (e.g. $01 $08)
- Machine code may live at $1000 or directly after BASIC; adjust SYS target accordingly

### Display Text on Screen

1) KERNAL CHROUT (portable)
   - Put PETSCII byte in A; JSR $FFD2 to print at cursor. Handles charset mapping.
   - Use for portability and when charset may vary.
2) Direct screen writes (fast)
   - STA $0400,X writes VIC-II screen codes directly. Use when you control charset and need speed.
   - Color via STA $D800,X (4-bit color index).

Screen-code conversion

- If input is ASCII uppercase 'A'..'Z', convert: screen = PETSCII - $40 (e.g. $41→$01). Implement in a small loop if needed.

This file is intentionally minimal: use `src/tools/basicTokenizer.ts` / `src/tools/assembler.ts` for tokenization/PRG building and `data/graphics/character-set.csv` for exact screen-code mappings.

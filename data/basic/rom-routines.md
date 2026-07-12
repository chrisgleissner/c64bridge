# C64 BASIC ROM Routines Memory Map — Compact ($A000-$BFFF, $E000-$E4D2)

> Purpose: Token-efficient reference for Commodore 64 BASIC V2 ROM routines, tables, parser/evaluator helpers, numeric/string machinery, statement/function dispatch, and C64-specific BASIC continuation code.  
> Format: Address-first tables; **bold** names indicate the most reusable entry points for machine-language or MCP tooling.  
> Conventions: A=Accumulator, X,Y=Index, C=Carry; “—” = not applicable.
> Related memory maps: `../memory/memory-map.md`, `../memory/low-memory-map.md`, `../kernal/rom-routines.md`, `../io/io-spec.md`.

## Legend

Class: A=safe helper, B=usable with guardrails, C=interpreter-coupled, D=non-returning/control-flow, data=table/constant.

## Direct-Use Rules

- BASIC ROM must be banked in (`$0001` LORAM+HIRAM set). KERNAL ROM must also be visible for I/O and error reporting.
- Many failures jump to `$A437` (`ERROR`) rather than returning a status code.
- Prefer KERNAL APIs for files/devices and dynamic keyboard or tokenized program install for statements.
- Best reusable BASIC targets: `FRMEVL`, `FRMNUM`, `GETBYT`, `GETADR`, `PTRGET`, `FOUT`, `MOVFM`, `MOVMF`, `LNKPRG`, `CLR`.
- Avoid direct statement entries unless a wrapper controls `TXTPTR`, stack, BASIC vectors, error recovery, and runtime pointers.

## Essential BASIC State

| Address | Decimal | Name | Function | Notes |
|:--|:--|:--|:--|:--|
| `$000C` | 12 | DIMFLG | Array allocation/reference flag | Used by `PTRGET`. |
| `$000D` | 13 | VALTYP | Current type | `$00` numeric, `$FF` string. |
| `$000E` | 14 | INTFLG | Numeric subtype | `$00` float, `$80` integer. |
| `$0014–$0015` | 20–21 | LINNUM | Line/address/number temp | Used by `PEEK`, `POKE`, `WAIT`, `SYS`. |
| `$0016–$0021` | 22–33 | TEMPPT/TEMPST | Temporary string descriptor stack | Three 3-byte descriptors. |
| `$002B–$002C` | 43–44 | **TXTTAB** | BASIC program start | Normally `$0801`. |
| `$002D–$002E` | 45–46 | **VARTAB** | Scalar variable table start | Updated after program changes. |
| `$002F–$0030` | 47–48 | **ARYTAB** | Array table start | Follows scalars. |
| `$0031–$0032` | 49–50 | **STREND** | End of arrays / free RAM start | Moves upward. |
| `$0033–$0034` | 51–52 | **FREETOP** | Bottom of string heap | Strings grow downward. |
| `$0037–$0038` | 55–56 | **MEMSIZ** | BASIC memory top | Lower then `CLR` to reserve RAM. |
| `$0039–$003A` | 57–58 | CURLIN | Current BASIC line | High byte `$FF` = direct mode. |
| `$0041–$0042` | 65–66 | DATPTR | Current DATA item pointer | Reset by `RESTORE`. |
| `$0045–$0048` | 69–72 | VARNAM/VARPNT | Current variable name/value pointer | Set by `PTRGET`. |
| `$0050–$0052` | 80–82 | DSCPNT | String descriptor pointer/temp | String functions. |
| `$0061–$0066` | 97–102 | **FAC1** | Primary floating-point accumulator | Exponent, mantissa, sign. |
| `$0069–$006E` | 105–110 | FAC2/ARG | Secondary FP accumulator | Arithmetic argument. |
| `$0070` | 112 | FACOV | FP rounding byte | Used by `ROUND`. |
| `$0073–$008A` | 115–138 | **CHRGET/CHRGOT** | BASIC scanner in zero page | `CHRGOT` entry at `$0079`. |
| `$007A–$007B` | 122–123 | **TXTPTR** | BASIC text pointer | Parser/evaluator input. |
| `$008B–$008F` | 139–143 | RNDX | RND seed | Five-byte FP seed. |
| `$0300–$030B` | 768–779 | BASIC vectors | Error, warm start, tokenize, LIST, execute, evaluate | Copied from `$E447`. |
| `$030C–$030F` | 780–783 | SYS save | A, X, Y, status for BASIC `SYS` | Restored after SYS returns. |
| `$0310–$0311` | 784–785 | USR vector | Target for `USR()` | Default illegal quantity. |

## ROM Landmarks

| Address | Decimal | Name | Function | Class | Notes |
|:--|:--|:--|:--|:--|:--|
| `$A000` | 40960 | Cold vector | Points to `$E394` | data | Do not execute as code. |
| `$A002` | 40962 | Warm vector | Points to `$E37B` | data | BASIC warm start. |
| `$A004` | 40964 | CBMBASIC | ROM signature | data | Identification text. |
| `$A00C` | 40972 | Command table | 35 statement addresses minus 1 | data | Token `$80–$A2`. |
| `$A052` | 41042 | Function table | 23 function addresses minus 1 | data | Token `$B4–$CA`. |
| `$A080` | 41088 | Operator table | Precedence + address minus 1 | data | Arithmetic, compare, logical. |
| `$A09E` | 41118 | Keyword table | Statement keywords | data | High bit marks final char. |
| `$A129` | 41257 | Reserved-word table | `TAB(`, `TO`, `SPC(`, etc. | data | Tokenizer metadata. |
| `$A140` | 41280 | Operator keyword table | `+ - * / ^ AND OR > = <` | data | Tokenizer metadata. |
| `$A14D` | 41293 | Function keyword table | `SGN` through `MID$` | data | Tokenizer metadata. |
| `$A19E` | 41374 | Error text | BASIC error message strings | data | Indexed by `$A328`. |
| `$A328` | 41768 | Error pointers | Pointers to error text | data | X = error index. |
| `$A364` | 41828 | Interpreter text | `OK`, `ERROR IN`, `READY`, `BREAK` | data | Screen messages. |
| `$BFED` | 49133 | EXP | EXP function body | A/B | Continues at `$E000`. |
| `$E000–$E4D2` | 57344–58578 | BASIC continuation | EXP/RND/trig, I/O wrappers, init, BASIC vectors | mixed | Located in ROM area often grouped with KERNAL. |

## Core Reusable Entries

| Address | Decimal | Name | Function | Args/Input | Output | Class | Notes |
|:--|:--|:--|:--|:--|:--|:--|:--|
| `$A533` | 42291 | **LNKPRG** | Relink tokenized BASIC program | Program at `TXTTAB` | Forward links rebuilt | B | Use after raw program writes. |
| `$A57C` | 42364 | CRUNCH | Tokenize input line | BASIC input-buffer state | Tokenized line | B/C | Easier: use keyboard injection. |
| `$A613` | 42515 | FNDLIN | Find BASIC line | `LINNUM` target | C set if found | B | Program table must be valid. |
| `$A65E` | 42590 | **CLR** | Clear variables/runtime/string heap | BASIC pointers valid | Runtime reset | B/C | Use after program/memory-bound changes. |
| `$A68E` | 42638 | STXTPT | Set text pointer to program start | `TXTTAB` valid | `TXTPTR=TXTTAB-1` | B/C | Prepares interpreter scan. |
| `$A717` | 42775 | LIST helper | Detokenize through output channel | Program text/current channel | Output text | C | Output-channel dependent. |
| `$AB1E` | 43806 | **STROUT** | Output zero/quote-terminated string | A/Y pointer | Characters output | B | Current output channel used. |
| `$AB47` | 43847 | CHR output wrapper | Output PETSCII char | A=byte | Character output | B/C | Prefer KERNAL `CHROUT`. |
| `$AD8A` | 44426 | **FRMNUM** | Evaluate numeric expression | `TXTPTR` at first char | FAC1 numeric | B | String result -> type error. |
| `$AD8D` | 44429 | **CHKNUM** | Require numeric result | `VALTYP` | Return or error | A | Type mismatch jumps to error. |
| `$AD8F` | 44431 | CHKSTR | Require string result | `VALTYP` | Return or error | A | Type mismatch jumps to error. |
| `$AD90` | 44432 | CHKVAL | Type check by carry | C clear=numeric, set=string | Return or error | A | Helper under `CHKNUM/CHKSTR`. |
| `$AD9E` | 44446 | **FRMEVL** | Evaluate any expression | `TXTPTR` at first char | FAC1 or string result; `VALTYP` | B | Most useful parser entry. |
| `$AEF7` | 44791 | CHKCLS | Require `)` | Scanner state | Advances or error | B | Syntax helper. |
| `$AEFA` | 44794 | CHKOPN | Require `(` | Scanner state | Advances or error | B | Syntax helper. |
| `$AEFD` | 44797 | CHKCOM | Require `,` | Scanner state | Advances or error | B | Syntax helper. |
| `$AEFF` | 44799 | SYNCHR | Require char in A | A=required char | Advances or error | B | Syntax helper. |
| `$B08B` | 45195 | **PTRGET** | Find/create variable | `TXTPTR` at var name | `VARPNT`, Y/A value address | B | May allocate or evaluate subscripts. |
| `$B1AA` | 45482 | FAC→int | Convert FAC1 to signed 16-bit | FAC1 | A=lo,Y=hi | A/B | Range-sensitive. |
| `$B391` | 45969 | **GIVAYF** | Signed int to FAC1 | A=hi,Y=lo | FAC1 | A | Values >32767 become negative. |
| `$B3A2` | 45986 | SNGFLT | Byte to FAC1 | Y=byte | FAC1 | A | Sets numeric result. |
| `$B487` | 46215 | STRLIT | Create string descriptor from literal | A/Y pointer | Temp string descriptor | B | String heap/temps apply. |
| `$B4F4` | 46324 | GETSPA | Allocate string space | A=bytes | X/Y pointer | B/C | May garbage collect or error. |
| `$B526` | 46374 | GARBA2 | Garbage collect string heap | BASIC string state | Compacted strings | C | Avoid unless runtime owned. |
| `$B6DB` | 46811 | FRETMS | Release temp string | A/Y descriptor | Temp stack updated | B/C | Descriptor discipline matters. |
| `$B79E` | 47006 | **GETBYT** | Parse byte expression | `TXTPTR` expression | X=`0..255` | B | Illegal quantity on range error. |
| `$B7EB` | 47083 | **GETNUM** | Parse `addr,byte` | `TXTPTR` expression | `$14/$15`, X=byte | B | Useful for POKE-style syntax. |
| `$B7F1` | 47089 | COMBYT | Parse comma then byte | Current char comma | X=byte | B | Calls comma check. |
| `$B7F7` | 47095 | **GETADR** | FAC1 to unsigned address | FAC1 | `$14/$15`, A/Y | A/B | `0..65535`. |
| `$BBA2` | 48034 | **MOVFM** | Load packed float to FAC1 | A/Y pointer | FAC1 | A/B | Read numeric variable/constant. |
| `$BBD4` | 48084 | **MOVMF** | Store FAC1 as packed float | X/Y destination, FAC1 | 5 bytes written | A/B | Floating scalar vars. |
| `$BC1B` | 48155 | ROUND | Round FAC1 | FAC1/FACOV | FAC1 | A | Numeric helper. |
| `$BC2B` | 48171 | SIGN | Sign of FAC1 | FAC1 | A=`0`,`1`,`$FF` | A | Zero/positive/negative. |
| `$BDDD` | 48605 | **FOUT** | FAC1 to ASCII | FAC1 | A/Y temp string pointer | A/B | Copy text immediately. |

## Math Helpers

| Address | Decimal | Name | Input | Output | Class | Notes |
|:--|:--|:--|:--|:--|:--|:--|
| `$BC39` | 48185 | SGN | FAC1 | FAC1 = -1/0/1 | A | Function token `$B4`. |
| `$BC58` | 48216 | ABS | FAC1 | FAC1 | A | Clears sign. |
| `$BCCC` | 48332 | INT | FAC1 | FAC1 | A | BASIC floor semantics. |
| `$B9EA` | 47594 | LOG | FAC1 > 0 | FAC1 | A/B | Domain errors jump to `ERROR`. |
| `$BF71` | 49009 | SQR | FAC1 >= 0 | FAC1 | A/B | Uses LOG/EXP path. |
| `$BFB4` | 49076 | NEGOP | FAC1 | -FAC1 | A | Unary negation. |
| `$BFED` | 49133 | EXP | FAC1 | FAC1 | A/B | Continues at `$E000`; overflow possible. |
| `$E097` | 57495 | RND | FAC1 argument | FAC1 | A/B | Positive advances, negative seeds, zero mixes time. |
| `$E264` | 57956 | COS | FAC1 radians | FAC1 | A/B | Adds PI/2, uses SIN. |
| `$E26B` | 57963 | SIN | FAC1 radians | FAC1 | A/B | Dispatch entry. |
| `$E2B4` | 58036 | TAN | FAC1 radians | FAC1 | A/B | SIN/COS division. |
| `$E30E` | 58126 | ATN | FAC1 | FAC1 radians | A/B | Polynomial approximation. |

## Statement Dispatch Entries

Statement entries assume live interpreter context unless noted. Prefer text/tokenized program execution over direct calls.

| Token | Command | Entry | Class | Direct-use note |
|:--|:--|:--|:--|:--|
| `$80` | END | `$A831` | D | Program termination. |
| `$81` | FOR | `$A742` | C | Requires FOR stack frame. |
| `$82` | NEXT | `$AD1E` | C | Requires matching FOR frame. |
| `$83` | DATA | `$A8F8` | C | Statement skipper. |
| `$84` | INPUT# | `$ABA5` | C | Prefer KERNAL channel I/O. |
| `$85` | INPUT | `$ABBF` | C | Editor/string context. |
| `$86` | DIM | `$B081` | C | Allocates arrays. |
| `$87` | READ | `$AC06` | C | Depends on `DATPTR`. |
| `$88` | LET | `$A9A5` | C | Prefer `FRMEVL` + `PTRGET` + store helper. |
| `$89` | GOTO | `$A8A0` | D | Interpreter flow. |
| `$8A` | RUN | `$A871` | D | Non-local flow. |
| `$8B` | IF | `$A928` | C | Interpreter-only. |
| `$8C` | RESTORE | `$A81D` | C | Resets DATA state. |
| `$8D` | GOSUB | `$A883` | C | Requires BASIC return frame. |
| `$8E` | RETURN | `$A8D2` | C | Requires GOSUB frame. |
| `$8F` | REM | `$A93B` | C | Statement skipper. |
| `$90` | STOP | `$A82F` | D | STOP/BREAK path. |
| `$91` | ON | `$A94B` | C | Interpreter-only. |
| `$92` | WAIT | `$B82D` | C | Can hang; avoid for MCP. |
| `$93` | LOAD | `$E168` | C | Prefer KERNAL `LOAD`. |
| `$94` | SAVE | `$E156` | C | Prefer KERNAL `SAVE`. |
| `$95` | VERIFY | `$E165` | C | Prefer KERNAL load/verify. |
| `$96` | DEF | `$B3B3` | C | DEF FN machinery. |
| `$97` | POKE | `$B824` | C | Prefer memory write or `GETNUM`. |
| `$98` | PRINT# | `$AA80` | C | Prefer KERNAL channel output. |
| `$99` | PRINT | `$AAA0` | C | Output context required. |
| `$9A` | CONT | `$A857` | D | Requires continuation state. |
| `$9B` | LIST | `$A69C` | C | Output-channel dependent. |
| `$9C` | CLR | `$A65E` | B/C | Useful after memory/program edits. |
| `$9D` | CMD | `$AA86` | C | Prefer KERNAL channel control. |
| `$9E` | SYS | `$E12A` | C | Parses BASIC `SYS`; direct ML should `JSR/JMP`. |
| `$9F` | OPEN | `$E1BE` | C | Prefer KERNAL `OPEN`. |
| `$A0` | CLOSE | `$E1C7` | C | Prefer KERNAL `CLOSE`. |
| `$A1` | GET | `$AB7B` | C | Assignment/string path. |
| `$A2` | NEW | `$A642` | D | Destructive. |

## Function Dispatch Entries

Function entries are normally called by the evaluator. Direct use is safest for simple FAC1 numeric helpers.

| Token | Function | Entry | Class | Direct-use note |
|:--|:--|:--|:--|:--|
| `$B4` | SGN | `$BC39` | A | FAC1 in/out. |
| `$B5` | INT | `$BCCC` | A | FAC1 in/out. |
| `$B6` | ABS | `$BC58` | A | FAC1 in/out. |
| `$B7` | USR | `$0310` | C | RAM vector. |
| `$B8` | FRE | `$B37D` | C | Can trigger GC. |
| `$B9` | POS | `$B39E` | C | Reads cursor/channel state. |
| `$BA` | SQR | `$BF71` | A/B | FAC1 non-negative. |
| `$BB` | RND | `$E097` | A/B | FAC1 argument. |
| `$BC` | LOG | `$B9EA` | A/B | FAC1 positive. |
| `$BD` | EXP | `$BFED` | A/B | Overflow possible. |
| `$BE` | COS | `$E264` | A/B | FAC1 radians. |
| `$BF` | SIN | `$E26B` | A/B | FAC1 radians. |
| `$C0` | TAN | `$E2B4` | A/B | FAC1 radians. |
| `$C1` | ATN | `$E30E` | A/B | FAC1 in/out. |
| `$C2` | PEEK | `$B80D` | C | Parser convention; ML should `LDA`. |
| `$C3` | LEN | `$B77C` | C | String argument convention. |
| `$C4` | STR$ | `$B465` | C | String descriptor result. |
| `$C5` | VAL | `$B7AD` | C | String parser state. |
| `$C6` | ASC | `$B78B` | C | Errors on empty string. |
| `$C7` | CHR$ | `$B6EC` | C | String descriptor result. |
| `$C8` | LEFT$ | `$B700` | C | String function convention. |
| `$C9` | RIGHT$ | `$B72C` | C | String function convention. |
| `$CA` | MID$ | `$B737` | C | String function convention. |

## Operator Dispatch Entries

| Operator | Entry | Precedence | Direct-use note |
|:--|:--|:--|:--|
| `+` | `$B86A` | `$79` | Prefer `FRMEVL`. |
| `-` | `$B853` | `$79` | Prefer `FRMEVL`. |
| `*` | `$BA2B` | `$7B` | Prefer `FRMEVL`. |
| `/` | `$BB12` | `$7B` | Prefer `FRMEVL`. |
| `^` | `$BF7B` | `$7D` | Prefer `FRMEVL`. |
| `AND` | `$AFE9` | low | Evaluator convention. |
| `OR` | `$AFE6` | low | Evaluator convention. |
| comparison | `$B016` | compare | Evaluator convention. |
| unary `-` | `$BFB4` | unary | FAC1 negation is reasonable. |
| `NOT` | `$AF0D` | unary | Evaluator convention. |

## C64-Specific BASIC Continuation (`$E000–$E4D2`)

| Address | Decimal | Name | Function | Class | Notes |
|:--|:--|:--|:--|:--|:--|
| `$E000` | 57344 | EXP continuation | Completes EXP from `$BFED` | A/B | Cross-ROM BASIC code. |
| `$E043` | 57411 | POLY1 | FP polynomial helper | B | FAC1/coefficient state. |
| `$E059` | 57433 | POLY2 | FP polynomial helper | B | Used by math functions. |
| `$E08D` | 57485 | RMULC | RND multiply constant | data | Five-byte FP. |
| `$E092` | 57490 | RADDC | RND add constant | data | Five-byte FP. |
| `$E097` | 57495 | RND | Random number function | A/B | FAC1 argument. |
| `$E0F9` | 57593 | BASIC/KERNAL I/O bridge | Checked CHKIN/CHKOUT/CHRIN/CHROUT/GETIN | C/D | May enter BASIC error path. |
| `$E12A` | 57642 | SYS | BASIC `SYS` parser/executor | C | Uses `$030C–$030F`. |
| `$E156` | 57686 | SAVE wrapper | BASIC `SAVE` statement | C | Prefer KERNAL API. |
| `$E165` | 57701 | VERIFY wrapper | BASIC `VERIFY` statement | C | Falls into LOAD path. |
| `$E168` | 57704 | LOAD wrapper | BASIC `LOAD` statement | C | May relink BASIC program. |
| `$E1BE` | 57790 | OPEN wrapper | BASIC `OPEN` statement | C | Prefer KERNAL API. |
| `$E1C7` | 57799 | CLOSE wrapper | BASIC `CLOSE` statement | C | Prefer KERNAL API. |
| `$E1D4` | 57812 | L/V/S parameter setup | Parse filename/LFN/dev/SA | C | For LOAD/SAVE/VERIFY. |
| `$E200` | 57856 | Get int to X | Parse comma + integer byte | B/C | Parser helper. |
| `$E206` | 57862 | Fetch/endline helper | Parser control-flow helper | D | Can unwind caller. |
| `$E20E` | 57870 | Check comma | Require comma | B/C | Parser helper. |
| `$E219` | 57881 | O/C parameter setup | Parse OPEN/CLOSE params | C | Sets KERNAL file state. |
| `$E264` | 57956 | COS | Cosine | A/B | FAC1 radians. |
| `$E26B` | 57963 | SIN | Sine | A/B | FAC1 radians. |
| `$E2B4` | 58036 | TAN | Tangent | A/B | FAC1 radians. |
| `$E30E` | 58126 | ATN | Arctangent | A/B | FAC1 in/out. |
| `$E37B` | 58235 | Warm BASIC | READY/warm-start path | D | Jump target, not subroutine. |
| `$E38B` | 58251 | Error message path | Print BASIC error and READY | D | X=error index. |
| `$E394` | 58260 | Cold BASIC | Power-on BASIC init | D | Reset/init path. |
| `$E3A2` | 58274 | CHRGET image | Source copied to `$0073` | data | Scanner code image. |
| `$E3BF` | 58303 | INIT | BASIC zero-page init | C/D | Copies `CHRGET`. |
| `$E422` | 58402 | Startup messages | Banner and bytes-free output | D | Boot path. |
| `$E447` | 58439 | BASIC vector table | Defaults for `$0300–$030B` | data | Error, warm, crunch, list, execute, evaluate. |
| `$E453` | 58451 | Copy BASIC vectors | Restore BASIC RAM vectors | B/C | Mostly init/recovery. |
| `$E460` | 58464 | Text constants | Startup/message text | data | Constants. |

## Compact Workflows

| Need | Preferred mechanism | Minimal sequence |
|:--|:--|:--|
| Evaluate expression | `FRMNUM`/`FRMEVL` | Set `TXTPTR` to first char, `JSR $AD8A` or `JSR $AD9E`, handle BASIC errors. |
| Numeric result as text | `FOUT` | FAC1 ready, `JSR $BDDD`, copy A/Y string immediately. |
| Parse byte/address syntax | `GETBYT`/`GETADR`/`GETNUM` | Use BASIC-compatible expression text and controlled `TXTPTR`. |
| Read/write numeric scalar | `PTRGET` + `MOVFM`/`MOVMF` | Set `TXTPTR` to var name; use returned `VARPNT`. |
| Install tokenized program | Raw write + `LNKPRG` + `CLR` | Write at `TXTTAB`, final next pointer `$0000`, `JSR $A533`, `JSR $A65E`. |
| Execute BASIC statement | Dynamic keyboard or normal interpreter | Avoid direct statement entries unless runtime/error context is controlled. |
| Reserve high RAM | Lower `MEMSIZ`, then `CLR` | Update `$37/$38`, `JSR $A65E`; keep ML/sprites above new top. |

## Avoid as General MCP APIs

| Entry | Reason |
|:--|:--|
| `$A437` | BASIC error path; non-returning for normal callers. |
| `$A7AE` | Main interpreter loop; full runtime context required. |
| `$A7ED` | Command dispatcher; token/stack conventions required. |
| `$E206` | May skip a return address at end-of-statement. |
| `$E37B`, `$E394` | Warm/cold BASIC entry paths, not subroutines. |
| Direct string allocation/GC | Safe only when descriptor stack and movable string heap are controlled. |

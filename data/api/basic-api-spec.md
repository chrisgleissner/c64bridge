# C64 BASIC API — Callable Routines & Token Dispatch (ROM $A000–$BFFF)

> Purpose: Minimal, deduplicated interface spec for **callable** BASIC API entry points and token dispatch.  
> Format: Markdown table (one row per routine). Addresses shown in **hex** and **decimal**. **Bold** Name = callable/public API.  
> Conventions: A=Accumulator, X,Y=Index registers, C=Carry; Token shown where a BASIC token invokes the routine; “—” if not applicable.

## Use of Low Memory ($0000–$03FF)

BASIC uses the [low memory area](./memory/low-memory-map.md) for program management, variable tracking, and floating-point math, with temporary overlap of certain KERNAL variables. It shares this space with the Kernal.

| Range | Purpose | Key Variables / Pointers |
|:------|:---------|:-------------------------|
| `$002B–$0030` | Core pointers defining BASIC memory layout | TXTTAB, VARTAB, ARYTAB |
| `$0031–$0038` | Free-space and string pool boundaries | STREND, FREETOP, MEMSIZ |
| `$0039–$0042` | Current/previous line context and DATA pointer | CURLIN, OLDLIN, DATPTR |
| `$0061–$006E` | Floating point accumulators (FAC1/FAC2) | FP math workspace |
| `$0073–$007A` | Inline copy of CHRGET/CHRGOT tokenizer entry | BASIC text reader |
| `$0099–$009A` | Default I/O device numbers | DFLTN (input), DFLTO (output) |
| `$0200–$0258` | Input buffer for keyboard and direct statements | INBUF |
| `$0281–$0284` | BASIC start and end addresses after memory test | BASBOT, BASTOP |
| `$0300–$030B` | **BASIC RAM vectors** (redirectable entry points) | e.g. LIST, NEW, RUN |
| `$033C–$03FB` | Cassette buffer reused by BASIC LOAD/SAVE | TBUFFER |

BASIC and KERNAL share portions of this map; modifying these variables directly  
allows the relocation of program text, redefining top-of-memory, or injecting custom LOAD/SAVE behavior.

## Callable Routines

| Address | Decimal | Token | Name | Function | Args | Input | Output | Notes |
|:--------|:--------|:------|:-----|:---------|:-----|:------|:-------|:------|
| `$A000` | 40960 | — | **COLDV** | Cold start vector target (BASIC init) | — | Entry via OS after power-on | — | Prints banner/bytes free; see `$E394` |
| `$A002` | 40962 | — | **WARMV** | Warm start vector target (STOP/RESTORE) | — | Entry via BRK/STOP | — | Preserves program; see `$E37B` |
| `$A00C` | 40972 | — | **STMDSP** | Statement dispatch table (addr-1 entries) | — | NEWSTT preloads return to CHRGET | — | Maps tokens 128–162 to handlers |
| `$A052` | 41042 | — | **FUNDSP** | Function dispatch table | — | FRMEVAL evals arg; jumps by token | — | Maps tokens 180–202 to handlers |
| `$A080` | 41088 | — | **OPTAB** | Operator dispatch table (addr-1 + precedence) | — | Expression parsing | — | Maps tokens 170–179 |
| `$A19E` | 41374 | — | **ERRTAB** | BASIC error message texts | — | — | — | Indexed via vector table `$A328` |
| `$A328` | 41768 | — | **ERRVEC** | Error message vector table | — | X=err# (in ERROR) | — | 30 entries; BREAK msg in misc |
| `$A365` | 41829 | — | **MSGTBL** | Misc messages (OK, ERROR, READY., BREAK) | — | — | — | Zero-terminated strings |
| `$A38A` | 41866 | — | **FNDFOR** | Find FOR block on stack | — | Stack contains FOR frames | — | Used by NEXT/LOOP control |
| `$A3B8` | 41912 | — | **BLTU** | Open space for new line/variable | — | Requested insert size | — | Moves text/vars; checks space |
| `$A3FB` | 41979 | — | **GETSTK** | Check stack space | — | Needed bytes in A? | — | Errors on overflow |
| `$A408` | 41992 | — | **REASON** | Check free memory; GC if needed | — | Requested bytes | — | Calls GARBAG `$B526` then error |
| `$A435` | 42037 | — | **OMERR** | OUT OF MEMORY handler | X=err# | — | — | Falls through to ERROR |
| `$A437` | 42039 | — | **ERROR** | General error handler | X=err# | — | — | Vectored via RAM $0300 for trapping |
| `$A474` | 42089 | — | **READY** | Print READY and enter main loop | — | — | — | Sets KERNAL message flag |
| `$A480` | 42112 | — | **MAIN** | Main loop: read line, exec/store | — | Via RAM vector $0302 | — | Keyboard via CHRIN `$F157` |
| `$A49C` | 42140 | — | **MAIN1** | Add/replace program line | — | Line in input buffer | — | Tokenizes; updates links; CLR |
| `$A533` | 42291 | — | **LINKPRG** | Relink tokenized program lines | — | Program text | — | Rewrites next-line pointers |
| `$A560` | 42336 | — | **INLIN** | Read input line to buffer ($0200) | — | From current input (keyboard) | — | Max 80 chars; error if >80 |
| `$A579` | 42361 | — | **CRUNCH** | Tokenize input buffer line | — | Buffer @ $0200 | — | Vectored via RAM $0304 |
| `$A613` | 42515 | — | **FINDLN** | Find line number (target in $14/$15) | — | Program text | C=1 if found; $5F/$60=ptr | C=0 if not found |
| `$A642` | 42562 | 162 ($A2) | **NEW** | NEW: clear program to zero link | — | — | — | Falls through CLR |
| `$A65E` | 42590 | 156 ($9C) | **CLR** | CLR: close files; reset var areas | — | — | — | Calls KERNAL CLALL `$F32F` |
| `$A68E` | 42638 | — | **RUNC** | Reset text pointer to start | — | — | — | Sets TXTPTR $7A/$7B |
| `$A69C` | 42652 | 155 ($9B) | **LIST** | LIST: print lines in range | — | Start/end in $5F/$60 and $14/$15 | — | Uses QPLOP for tokens |
| `$A717` | 42775 | — | **QPLOP** | Convert tokens → ASCII for LIST | — | Vectored via RAM $0306 | — | Supports custom keywords |
| `$A742` | 42818 | 129 ($81) | **FOR** | Save FOR frame on stack | — | TO expr eval once; STEP default 1 | — | Non-array FP loop var |
| `$A7AE` | 42926 | — | **NEWSTT** | Prepare next statement execution | — | — | — | Tests STOP; advances pointers |
| `$A7E4` | 42980 | — | **GONE** | Fetch next token and execute | — | Vectored via RAM $0308 | — | PUSH (addr-1) from STMDSP; CHRGET |
| `$A81D` | 43037 | 140 ($8C) | **RESTORE** | RESET DATA pointer | — | — | — | DATA ptr $41/$42 ← start $2B/$2C |
| `$A82C` | 43052 | — | **STOPTST** | Test STOP key and branch | — | Calls KERNAL STOP `$F6ED` | — | |
| `$A82F` | 43055 | 144 ($90) | **STOP** | STOP: break program | — | STOP pressed | — | Prints BREAK then READY |
| `$A831` | 43057 | 128 ($80) | **END** | END: terminate program | — | — | — | Preserves CONT pointers |
| `$A857` | 43095 | 154 ($9A) | **CONT** | CONT: resume after STOP/END | — | Saved CONT pointers | — | Errors if missing |
| `$A871` | 43121 | 138 ($8A) | **RUN** | RUN: SETMSG, CLR, optional GOTO | — | Optional line# | — | SETMSG `$FE18` |
| `$A883` | 43139 | 141 ($8D) | **GOSUB** | Push return context; then GOTO | — | — | — | Marks stack frame (0x8D) |
| `$A8A0` | 43168 | 137 ($89) | **GOTO** | Branch to target line | — | Scans program for line | — | Adjusts pointers to target |
| `$A8D2` | 43218 | 142 ($8E) | **RETURN** | Pop GOSUB frame; resume | — | Stack contains frame | — | Restores line/char pointers |
| `$A8F8` | 43256 | 131 ($83) | **DATA** | Skip DATA text | — | — | — | Skips to next stmt (like REM) |
| `$A906` | 43270 | — | **DATAN** | Find end of current statement | — | — | — | Stops at 0 or colon (outside quotes) |
| `$A928` | 43304 | 139 ($8B) | **IF** | Eval expr; if nonzero do THEN-part | — | Uses FRMEVAL `$AD9E` | — | Else falls through to REM |
| `$A93B` | 43323 | 143 ($8F) | **REM** | Skip to next statement | — | — | — | Shares code path with IF |
| `$A94B` | 43339 | 145 ($91) | **ON** | ON GOTO/GOSUB list dispatch | — | Arg → integer; select target | — | No-op if out-of-range |
| `$A96B` | 43371 | — | **LINGET** | Parse decimal → 2-byte line# | — | Range 0–63999 | $14/$15=line# | |
| `$A9A5` | 43429 | 136 ($88) | **LET** | Evaluate/assign var (all types) | — | Var ref and expr | — | Type-checked assign/create |
| `$AA80` | 43648 | 152 ($98) | **PRINT#** | PRINT# (to device) | — | Calls CMD then CLRCHN `$F333` | — | |
| `$AA86` | 43654 | 157 ($9D) | **CMD** | Route output to device; keep open | — | CHKOUT `$F250`; PRINT text | — | Leaves channel open |
| `$AAA0` | 43680 | 153 ($99) | **PRINT** | PRINT with TAB/SPC/;/, variables | — | Converts to strings; CHROUT | — | Handles TI, TI$, ST |
| `$AB1E` | 43806 | — | **STROUT** | Print zero-terminated string at (A,Y) | A=lo,Y=hi | Points to string | — | |
| `$AB4D` | 43853 | — | **DOAGIN** | Input error formatting (GET/INPUT/READ) | — | — | — | |
| `$AB7B` | 43899 | 161 ($A1) | **GET** | GET/GET#: get single char | — | Optional CHKIN/CLRCHN | A=char | Uses READ common I/O |
| `$ABA5` | 43941 | 132 ($84) | **INPUT#** | INPUT# from device | — | CHKIN; then INPUT; CHKOUT | — | Discards excess silently |
| `$ABBF` | 43967 | 133 ($85) | **INPUT** | Prompt; read; assign to vars | — | Not allowed in direct mode | — | Uses READ common code |
| `$AC06` | 44038 | 135 ($87) | **READ** | Read from DATA; assign | — | DATA pointer | — | Shared I/O for GET/INPUT |
| `$ACFC` | 44284 | — | **EXIGNT** | Input error message texts | — | — | — | “?EXTRA IGNORED”, “?REDO FROM START” |
| `$AD1E` | 44318 | 130 ($82) | **NEXT** | Increment FOR var; loop test | — | FOR frame on stack | — | Removes frame when complete |
| `$AD8A` | 44426 | — | **FRMNUM** | Type check (string vs numeric) | — | Desired type | — | TYPE MISMATCH on mismatch |
| `$AD9E` | 44446 | — | **FRMEVAL** | Evaluate expression | — | Text pointer at term start | Result→FAC1/desc | Sets flags at $0D/$0E |
| `$AE83` | 44675 | — | **EVAL** | Parse single numeric term → FAC1 | — | Constant/variable/PI | FAC1 | Vectored via RAM $030A |
| `$AEF1` | 44785 | — | **PARCHK** | Evaluate expression in parentheses | — | — | — | Calls FRMEVAL |
| `$AEFF` | 44799 | — | **SYNCHR** | Syntax helper: expect & skip char | A=expected | — | — | For comma/parens checks |
| `$AF08` | 44808 | — | **SNERR** | Print SYNTAX ERROR | — | — | — | |
| `$AF2B` | 44843 | — | **ISVAR** | Fetch variable value | — | — | Result in FAC1/desc | |
| `$AFA7` | 44967 | — | **ISFUN** | Dispatch and evaluate function | — | Token in current text | — | Uses FUNDSP |
| `$AFE6` | 45030 | 176 ($B0) | **OR** | Logical OR | — | Operands coerced to 16-bit ints | FAC1=0/−1 | Shares code with AND |
| `$AFE9` | 45033 | 175 ($AF) | **AND** | Logical AND | — | Operands coerced to 16-bit ints | FAC1=0/−1 | — |
| `$B016` | 45078 | 177 ($B1) | **REL** | Comparisons (>,<,=) | — | Strings or floats | FAC1=0/−1 | Used by tokens 177/178/179 |
| `$B081` | 45185 | 134 ($86) | **DIM** | Create array(s) | — | Variables list | — | Default size 11 elements if missing |
| `$B08B` | 45195 | — | **PTRGET** | Find/create variable descriptor | — | Name in text | Ptr→$47/$48 | |
| `$B113` | 45331 | — | **ISALPHA** | Test A for alphabetic | A=char | — | Z/N set | Part of var-name check |
| `$B11D` | 45341 | — | **NOTFNS** | Create new variable descriptor | — | — | — | Moves storage up 7 bytes |
| `$B185` | 45445 | — | **FINPTR** | Return address of variable | — | — | Ptr→$47/$48 | |
| `$B194` | 45460 | — | **ARYGET** | Allocate array descriptor | — | Dims parsed | — | 5 + 2*ndim bytes |
| `$B1AA` | 45482 | — | **FTOI_AY** | Float→signed int in A(high)/Y(low) | — | FAC1 | A,Y=int | Also writes $64/$65 |
| `$B1B2` | 45490 | — | **INTIDX** | Subscript to positive integer | — | FAC1 | — | Range check |
| `$B1BF` | 45503 | — | **AYINT** | Float→signed int @ $64/$65 | — | FAC1 in range | — | Errors if out of range |
| `$B245` | 45637 | — | **BSERR** | BAD SUBSCRIPT error | — | — | — | |
| `$B248` | 45640 | — | **FCERR** | ILLEGAL QUANTITY error | — | — | — | |
| `$B34C` | 45900 | — | **UMULT** | Size of multidimensional array | — | Dims | — | Multiply dims |
| `$B37D` | 45949 | 184 ($B8) | **FRE** | Return free memory (fix sign) | — | Calls GARBAG `$B526` | FAC1 | Use `FRE(0)-65536*(FRE(0)<0)` |
| `$B391` | 45969 | — | **GIVAYF** | 16-bit signed int (A,Y) → float | A,Y=int | — | FAC1 | RAM vector at 5–6 |
| `$B39E` | 45982 | 185 ($B9) | **POS** | Cursor position (logical) | — | Calls PLOT `$E50A` | FAC1 | Equivalent to PEEK(211) |
| `$B3B3` | 46003 | 150 ($96) | **DEF** | Define FN | — | Syntax checks; push frame | — | Nested functions allowed |
| `$B3E1` | 46049 | — | **GETFNM** | Check DEF/FN syntax | — | — | — | Finds/creates dep. var |
| `$B3F4` | 46068 | — | **FNDOER** | Evaluate FN(...) | — | — | FAC1 | Uses definition text |
| `$B465` | 46181 | 196 ($C4) | **STR$** | Number → string | — | Number required | String desc | |
| `$B487` | 46215 | — | **STRLIT** | Scan string literal; set pointers | — | — | — | Allocates/copies as needed |
| `$B4F4` | 46324 | — | **GETSPA** | Allocate string space (may GC) | — | Length in A? | — | Calls GARBAG on shortage |
| `$B526` | 46374 | — | **GARBAG** | String garbage collection | — | — | — | Compacts live strings; moves bottom ptr |
| `$B63D` | 46653 | — | **CAT** | Concatenate strings | — | A$+B$ | New string desc | Allocates & builds |
| `$B67A` | 46714 | — | **MOVINS** | Move string text | — | — | — | Utility |
| `$B6A3` | 46755 | — | **FRESTR** | Discard temporary string | — | — | — | Updates bottom if topmost |
| `$B6DB` | 46811 | — | **FRETMS** | Remove entry from temp string stack | — | — | — | |
| `$B6EC` | 46828 | 199 ($C7) | **CHR$** | Create one-byte string | — | Byte value | String desc | |
| `$B700` | 46848 | 200 ($C8) | **LEFT$** | Left substring | — | String, count | String desc | |
| `$B72C` | 46892 | 201 ($C9) | **RIGHT$** | Right substring | — | String, count | String desc | |
| `$B737` | 46903 | 202 ($CA) | **MID$** | Mid substring | — | String, pos[,len] | String desc | |
| `$B761` | 46945 | — | **PREAM** | Pull params for LEFT$/RIGHT$/MID$ | — | — | — | Helper |
| `$B77C` | 46972 | 195 ($C3) | **LEN** | String length → number | — | String desc | FAC1 | |
| `$B78B` | 46987 | 198 ($C6) | **ASC** | First char code → number | — | String | FAC1 | |
| `$B79B` | 47003 | — | **GETBYTC** | Read byte parameter (0–255) | — | — | X=byte | For USR/new commands |
| `$B7AD` | 47021 | 197 ($C5) | **VAL** | Parse number in string | — | String | FAC1 | |
| `$B7EB` | 47083 | — | **GETNUM** | Get 16-bit address and 8-bit byte | — | Parses next numeric; range-checks | $14/$15=addr, X=byte | For POKE/WAIT |
| `$B7F7` | 47095 | — | **GETADR** | Float→unsigned 16-bit address | — | FAC1 in range | $14/$15 | For PEEK |
| `$B80D` | 47117 | 194 ($C2) | **PEEK** | Read byte at address | — | Addr via GETADR | FAC1 | Reads via Y then float |
| `$B824` | 47140 | 151 ($97) | **POKE** | Write byte to address | — | GETNUM (addr,byte) | — | |
| `$B82D` | 47149 | 146 ($92) | **WAIT** | Wait on (addr XOR pat) AND mask | — | Addr, mask[,pattern] | — | Poll loop until nonzero |
| `$BC39` | 48185 | 180 ($B4) | **SGN** | Sign of number | — | FAC1 | FAC1 | |
| `$BC58` | 48216 | 182 ($B6) | **ABS** | Absolute value | — | FAC1 | FAC1 | |
| `$BCCC` | 48332 | 181 ($B5) | **INT** | Truncate to integer | — | FAC1 | FAC1 | |
| `$BDDD` | 48605 | — | **FOUT** | Float → ASCII string | — | FAC1 | A,Y→string | Used by PRINT/STR$ |
| `$BF71` | 49009 | 186 ($BA) | **SQR** | Square root | — | FAC1 | FAC1 | |
| `$BF7B` | 49019 | 174 ($AE) | **^** | Exponentiation | — | FAC2^FAC1 | FAC1 | |
| `$BFB4` | 49076 | — | **unary -** | Negation | — | FAC1 | FAC1 | Operator table entry for unary minus |
| `$BFED` | 49133 | 189 ($BD) | **EXP** | e^X | — | FAC1 | FAC1 | Jumps into KERNAL continuation |
| `$B86A` | 47210 | 170 ($AA) | **+** | Addition | — | FAC1,FAC2 | FAC1 | |
| `$B853` | 47187 | 171 ($AB) | **-** | Subtraction | — | FAC1,FAC2 | FAC1 | |
| `$BA2B` | 47659 | 172 ($AC) | **\*** | Multiplication | — | FAC1,FAC2 | FAC1 | |
| `$BB12` | 47890 | 173 ($AD) | **/** | Division | — | FAC2/FAC1 | FAC1 | |
| `$AFE9` | 45033 | 175 ($AF) | **AND** | Logical AND | — | ints | FAC1 | duplicate entry for clarity |
| `$AFE6` | 45030 | 176 ($B0) | **OR** | Logical OR | — | ints | FAC1 | duplicate entry for clarity |
| `$AED4` | 44756 | 168 ($A8) | **NOT** | Logical NOT | — | FAC1 | FAC1 | NOT X = -(X+1) |
| `$B016` | 45078 | 177-179 ($B1-$B3) | **> = <** | Relational comparison (one routine for all three) | — | — | FAC1=0/−1 | |

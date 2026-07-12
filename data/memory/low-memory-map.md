# Low Memory Pages 0–3 (Zero Page, Stack, System Work Areas)

> Scope: **$0000–$03FF (0–1023)**: Zero page (BASIC + KERNAL vars), page-1 stack, page-2 system buffers/tables, page-3 vectors + **cassette (tape) buffer**.  

> Style: Same compact table schema used in your KERNAL/BASIC specs. **Hex + decimal** addresses. **Bold** = key/callable vectors.  

> Hints: Zero page gives **1‑byte addressing** → faster code; keep ML temporaries in $FB–$FE. If **tape is unused**, the **cassette buffer $033C–$03FB (828–1019)** is ideal for **small ML helpers** or even **sprite/char data** (e.g., sprite blocks 13 @ $0340–$037F, 14 @ $0380–$03BF). Keyboard buffering enables **“dynamic keyboard”** input injection. Adjust **LORAM/HIRAM/CHAREN** via $0001 for ROM/RAM banking.
> Related memory maps: `memory-map.md`, `../basic/rom-routines.md`, `../kernal/rom-routines.md`, `../io/io-spec.md`.

## Legend

A=Accumulator, X,Y=index, C=Carry; “—” = not applicable. Pointers are little‑endian unless noted.

| Address | Decimal | Name | Function | Args | Input | Output | Notes |
|:--|:--|:--|:--|:--|:--|:--|:--|
| `$0000` | 0 | **D6510** | 6510 on‑chip I/O **Data Direction** | bitmask | — | — | Bits0–5 valid; default `$EF`. Configure port at $0001. |
| `$0001` | 1 | **R6510** | 6510 on‑chip **I/O Port** (banking + cassette) | bitmask | — | — | Bit0=LORAM,1=HIRAM,2=CHAREN; 3=data out; 4=switch sense; 5=motor. |
| `$0002` | 2 | — | Unused | — | — | — | Free (zero page). |
| `$0003–$0004` | 3–4 | **ADRAY1** | Vector: FP→signed **int** | — | FAC1 | A,Y or $64/65 | Points to `$B1AA`. |
| `$0005–$0006` | 5–6 | **ADRAY2** | Vector: **int→FP** | — | A,Y or $64/65 | FAC1 | Points to `$B391`. |
| `$0007` | 7 | CHARAC | Scanner work byte | — | — | — | Search char for tokeniser. |
| `$0008` | 8 | ENDCHR | Scanner work byte | — | — | — | Often 0 or 34 ("). |
| `$0009` | 9 | TRMPOS | Cursor col before TAB/SPC | — | — | — | 0–79 logical col. |
| `$000A` | 10 | VERCK | LOAD(0)/VERIFY(1) flag → KERNAL | — | — | — | Also copied to $0093. |
| `$000B` | 11 | COUNT | Input buffer index/array subscripts | — | — | — | Tokeniser & DIM/array helper. |
| `$000C` | 12 | DIMFLG | Array build/reference flags | — | — | — | Array state. |
| `$000D` | 13 | VALTYP | Type flag | — | — | — | 0=numeric, $FF=string. |
| `$000E` | 14 | INTFLG | Numeric kind flag | — | — | — | $80=int, 0=float. |
| `$000F` | 15 | GARBFL | LIST/GC/tokenize flag | — | — | — | GC tried; LIST in quotes. |
| `$0010` | 16 | SUBFLG | “(” seen → array/FN | — | — | — | PTRGET helper. |
| `$0011` | 17 | INPFLG | GET/READ/INPUT kind | — | — | — | 0=INPUT, $40=GET, $98=READ. |
| `$0012` | 18 | TANSGN | Sign/compare mask | — | — | — | Also holds compare result flags. |
| `$0013` | 19 | CHANNL | Current I/O **channel** (CMD LFN) | — | device state | — | 0=screen/keyboard; ≠0 alters prompts/tabs. |
| `$0014–$0015` | 20–21 | LINNUM | Target/line number | — | — | — | Also PEEK/POKE/WAIT/SYS address temp. |
| `$0016` | 22 | TEMPPT | Temp string stack ptr | — | — | — | 3 slots @ $19–$21; FORMULA TOO COMPLEX if full. |
| `$0017–$0018` | 23–24 | LASTPT | Temp string stack last | — | — | — | =TEMPPT−3. |
| `$0019–$0021` | 25–33 | TEMPST | Temp string descriptors | — | — | — | length/addr triples. |
| `$0022–$0025` | 34–37 | INDEX | Misc temp/save | — | — | — | Scratch. |
| `$0026–$002A` | 38–42 | RESHO | FP mult/div work | — | — | — | Also array-size calc. |
| `$002B–$002C` | 43–44 | **TXTTAB** | Ptr: start of BASIC text | — | — | — | Usually $0801; changing relocates program base. |
| `$002D–$002E` | 45–46 | **VARTAB** | Ptr: start of variables | — | — | — | 7‑byte descriptors; type via high bit(s). |
| `$002F–$0030` | 47–48 | **ARYTAB** | Ptr: start of arrays | — | — | — | Array header + dims + data. |
| `$0031–$0032` | 49–50 | **STREND** | Ptr: end of arrays (=start free RAM) | — | — | — | Moves up as vars grow. |
| `$0033–$0034` | 51–52 | **FREETOP** | Ptr: bottom of string text | — | — | — | CLR sets to MEMSIZ; strings grow downward. |
| `$0035–$0036` | 53–54 | FRESPC | Temp string ptr | — | — | — | Recent string. |
| `$0037–$0038` | 55–56 | **MEMSIZ** | Ptr: BASIC top (limit) | — | — | — | User‑lowerable to reserve safe area. |
| `$0039–$003A` | 57–58 | **CURLIN** | Current BASIC line # | — | — | — | $FF in $3A = immediate mode. |
| `$003B–$003C` | 59–60 | OLDLIN | Previous line # | — | — | — | For CONT. |
| `$003D–$003E` | 61–62 | OLDTXT | Ptr: current stmt text | — | — | — | Saved/restored by STOP/CONT. |
| `$003F–$0040` | 63–64 | DATLIN | DATA line # | — | — | — | Error context. |
| `$0041–$0042` | 65–66 | **DATPTR** | Ptr: current DATA item | — | — | — | RESTORE resets to TXTTAB. |
| `$0043–$0044` | 67–68 | INPPTR | Ptr: GET/READ/INPUT source | — | — | — | DATA or $0200 buffer. |
| `$0045–$0046` | 69–70 | VARNAM | Current var name (2 bytes) | — | — | — | High‑bit type tagging. |
| `$0047–$0048` | 71–72 | VARPNT | Ptr: current var value | — | — | — | Points past name bytes. |
| `$0049–$004A` | 73–74 | FORPNT | Temp FOR var ptr | — | — | — | Pushed to stack. |
| `$004B–$004C` | 75–76 | OPPTR | Operator table offset | — | — | — | Also text save. |
| `$004D` | 77 | OPMASK | Compare mask | — | — | — | 1/2/4 for </=/>. |
| `$004E–$004F` | 78–79 | DEFPNT | Ptr: current FN descriptor | — | — | — | DEF/FN. |
| `$0050–$0052` | 80–82 | DSCPNT | Temp string desc ptr/len | — | — | — | — |
| `$0053` | 83 | FOUR6 | GC format constant | — | — | — | 3 vs 7‑byte desc. |
| `$0054–$0056` | 84–86 | JMPER | `JMP` + addr for FN | — | — | — | Table @ $A052. |
| `$0057–$0060` | 87–96 | — | BASIC numeric work area | — | — | — | — |
| `$0061–$0066` | 97–102 | **FAC1** | FP accumulator #1 | — | — | FAC1 | Exp @ $61; mant $62–$65; sign $66. |
| `$0067–$0068` | 103–104 | SGNFLG/BITS | Series count/overflow | — | — | — | FP helper. |
| `$0069–$006E` | 105–110 | **FAC2** | FP accumulator #2 | — | — | FAC2 | Exp/mant/sign. |
| `$006F–$0072` | 111–114 | ARISGN/FACOV | Sign compare/rounding | — | — | — | — |
| `$0071–$0072` | 113–114 | FBUFPT | Series eval ptr | — | — | — | Multi‑use scratch. |
| `$0073–$008A` | 115–138 | **CHRGET** | Get/peek next BASIC char | — | TXTPTR | A=char; flags | Copied from ROM @ $E3A2 for speed. Entry **CHRGOT**=$0079. |
| `$008B–$008F` | 139–143 | RNDX | RND seed (5‑byte FP) | — | — | — | Init from ROM seed. |
| `$0090` | 144 | STATUS | **KERNAL ST** (I/O status) | — | device | — | Bits vary (EOF=bit6). |
| `$0091` | 145 | STKEY | STOP/row readback | — | keyboard | — | $7F when STOP pressed. |
| `$0092` | 146 | SVXT | Tape timing const | — | — | — | Adjustable. |
| `$0093` | 147 | VERCK | LOAD/VERIFY flag | — | — | — | Mirrors $000A usage. |
| `$0094–$0097` | 148–151 | C3PO/BSOUR/SYNO/XSAV | Serial/tape temporaries | — | — | — | Buffered char, etc. |
| `$0098` | 152 | LDTND | Open files count / table end | — | OPEN/CLOSE | — | Drives LAT/FAT/SAT mgmt. |
| `$0099` | 153 | DFLTN | Default input device | — | — | — | 0=keyboard; set by CHKIN. |
| `$009A` | 154 | DFLTO | Default output (CMD) | — | — | — | 3=screen; set by CHKOUT. |
| `$009B–$00A2` | 155–162 | Tape/serial state + **TIME** | — | IRQ | TIME ticks | TI/TI$ use RDTIM/SETTIM. |
| `$00A3–$00AD` | 163–173 | Temp + **SAL** | Load start (work) | — | — | — | Screen routines reuse. |
| `$00AE–$00AF` | 174–175 | **EAL** | Load end | — | — | — | Also SAVE limit. |
| `$00B0–$00B3` | 176–179 | CMP0/**TAPE1** | Tape timing / **tape buffer start ptr** | — | — | — | TAPE1→$033C. |
| `$00B4–$00B7` | 180–183 | BITTS/NXTBIT/RODATA/FNLEN | RS‑232/tape/fname len | — | — | — | Tape names up to 187 bytes. |
| `$00B8–$00BC` | 184–188 | **LA/SA/FA/FNADR** | LFN/SA/device/fname ptr | — | — | — | Device ids: 0,1,2,3,4–5,8–11. |
| `$00BD–$00C2` | 189–194 | ROPRTY/FSBLK/MYCH/**STAL** | RS‑232/tape start | — | — | — | STAL used by LOAD/SAVE. |
| `$00C5` | 197 | LSTX | Last key matrix code | — | — | — | 64 if none. |
| `$00C6` | 198 | NDX | Keyboard buffer count | — | — | — | Set to 0 to flush. |
| `$00C7` | 199 | RVS | Reverse‑video flag | — | — | — | CHR$(18)/CHR$(146) toggle; clears on CR. |
| `$00C8–$00CA` | 200–202 | INDX/LXSP | Input line end / start X,Y | — | — | — | Logical lines. |
| `$00CB` | 203 | SFDX | Current key matrix code | — | keyboard | — | Used with KEYTAB tables. |
| `$00D1` | 209 | — | Ptr: current screen line | — | — | — | USER ($F3) follows color RAM. |
| `$00D9` | 217 | SCRLLN | **Screen line link table index** | — | — | — | Logical line topology (hi‑bit marks head). |
| `$00F3–$00F6` | 243–246 | **USER/KEYTAB** | Color RAM ptr / keyboard table vector | — | — | — | KEYTAB→tables at $EB81/$EBC2/$EC03/$EC78. |
| `$00F7–$00FA` | 247–250 | **RIBUF/ROBUF** | RS‑232 input/output buffer ptrs | — | — | — | 256‑byte rings at top of RAM. |
| `$00FB–$00FE` | 251–254 | **FREEZP** | **Free zero‑page bytes** | — | — | — | Safe for ML use. |
| `$00FF` | 255 | BASZPT | FP→ASCII temp | — | — | — | — |

### Page 1 — Stack / Tape Log

| Address | Decimal | Name | Function | Args | Input | Output | Notes |
|:--|:--|:--|:--|:--|:--|:--|:--|
| `$0100–$01FF` | 256–511 | **STACK** | 6510 **hardware stack** | pushes/pulls | JSR/IRQ | return addr/reg saves | BASIC also uses as work area; keep ≥62 bytes free; FOR frame = 18 bytes. |
| `$0100–$010A` | 256–266 | — | FP→string and scan work | — | — | — | — |
| `$0100–$013E` | 256–318 | **BAD** | Tape input error log | — | tape pass 1 | — | 62 bytes. |

### Page 2 — Input Buffer, File Tables, Keyboard Queue

| Address | Decimal | Name | Function | Args | Input | Output | Notes |
|:--|:--|:--|:--|:--|:--|:--|:--|
| `$0200–$0258` | 512–600 | **INBUF** | Keyboard/direct‑mode & GET/INPUT/READ buffer | — | KERNAL CHRIN | — | 89 bytes; last ~8 free on C64. |
| `$0259–$0262` | 601–610 | **LAT** | Table: active **logical file #s** | — | OPEN/CLOSE | — | 10 entries. |
| `$0263–$026C` | 611–620 | **FAT** | Table: device # per LFN | — | — | — | 10 entries. |
| `$026D–$0276` | 621–630 | **SAT** | Table: secondary address per LFN | — | — | — | 10 entries. |
| `$0277–$0280` | 631–640 | **KEYD** | **Keyboard buffer (FIFO)** | — | IRQ keyboard | dequeued chars | Max length set by $0289 (649). Supports “dynamic keyboard”. |
| `$0281–$0284` | 641–644 | **BASBOT/BASTOP** | BASIC bottom/top pointers | — | RAMTAS | — | Set by RAM test; RS‑232 lowers by 512 for buffers. |
| `$0288–$0289` | 648–649 | SCRNPAGE/KEYMAX | Screen page base / max KEYD size | — | — | — | Screen base page used with $ECF0 low‑byte table. |

### Page 3 — KERNAL/BASIC Vectors & **Cassette Buffer**

| Address | Decimal | Name | Function | Args | Input | Output | Notes |
|:--|:--|:--|:--|:--|:--|:--|:--|
| `$0300–$030B` | 768–779 | **BASIC RAM vectors** | Pointers to BASIC core routines (editable) | — | — | — | Copied from ROM @ $E447; used for wedges/overrides. |
| `$0314–$0333` | 788–819 | **KERNAL RAM vectors** | CHRIN/CHROUT/STOP/GETIN/etc. | — | — | — | IOPEN/ICLOSE/ICHKIN/ICKOUT/ICLRCH/IBASIN/IBSOUT/ISTOP/IGETIN/ICLALL/USRCMD/ILOAD/ISAVE. |
| `$0334–$033B` | 820–827 | — | Free vector slots | — | — | — | 8 bytes free. |
| `$033C–$03FB` | 828–1019 | **TBUFFER** | **Cassette buffer** (192 bytes) | — | tape I/O | — | Reusable if **no tape**: ML stash or VIC‑II data (sprites **13** @ $0340–$037F, **14** @ $0380–$03BF). Header/data block formats; id byte at $033C. |
| `$03FC–$03FF` | 1020–1023 | — | Unused | — | — | — | 4 free bytes. |

---

## Practical Tips (LLM prompts → actions)

- **Reserve safe RAM** above BASIC: lower `MEMSIZ` ($37/$38) then `CLR` to keep ML/sprite/charset. RS‑232 OPEN auto‑lowers top by 512 for 2×256‑byte buffers.  
- **Dynamic keyboard**: preload KEYD ($0277–$0280), set NDX ($00C6), characters are consumed in order; handy for quoted INPUT.  
- **ROM banking** via $0001: temporarily map out BASIC/KERNAL/CHAR for patching or ROM reads; remember to **disable IRQs** before switching out KERNAL.  
- **Cassette buffer reuse**: if device 1 not active, use $033C–$03FB for short ML stubs or graphics data; keep header semantics in mind; **do not** run tape I/O concurrently.

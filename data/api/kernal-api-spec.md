# C64 KERNAL API — Callable Routines (ROM $E000–$FFFF)

> Purpose: Minimal, deduplicated interface spec for **callable** KERNAL API routines.  
> Format: Markdown table (one row per routine). Addresses shown in **hex** and **decimal** for BASIC friendliness.  
> Conventions: A=Accumulator, X,Y=Index registers, C=Carry; “—” means not applicable. **Bold** Name = callable/public API.

## Use of Low Memory ($0000–$03FF)

The KERNAL relies on the [low memory region](./memory/low-memory-map.md) for all I/O and interrupt control. It shares this space with BASIC.

| Range | Purpose | Key Variables / Vectors |
|:------|:---------|:------------------------|
| `$0000–$0001` | 6510 I/O registers controlling memory banking and cassette motor | D6510, R6510 |
| `$0090` | I/O **status byte** updated by KERNAL routines | STATUS |
| `$00A0–$00A2` | Jiffy clock (**TIME**) for RDTIM/SETTIM | TI, TI$ |
| `$00B8–$00BC` | File/device association (LFN, SA, FA) | LA, SA, FA, FNADR |
| `$00C6` | Keyboard buffer count | NDX |
| `$00F3–$00F6` | Vectors to color RAM and keyboard decode tables | USER, KEYTAB |
| `$0314–$0333` | **Interrupt and I/O vectors** (modifiable by user) | CINV, CBINV, IRQ, BRK, NMI, etc. |
| `$033C–$03FB` | **Cassette buffer** (192 bytes, reusable for ML code if no tape is used) | TBUFFER |
| `$03FC–$03FF` | Unused bytes (safe for temporary data) | — |

The KERNAL modifies `$0001` to switch ROM/RAM banks, writes device status to `$0090`,  
and maintains IRQ/NMI linkage through `$0314–$0319`. Avoid overwriting these unless intercepting system vectors.

## Callable Routines

| Address | Decimal | Name | Function | Args | Input | Output | Notes |
|:--------|:--------|:-----|:---------|:-----|:------|:-------|:------|
| `$FF81` | 65409 | **CINT** | Init screen editor; clear/home; cursor state | — | Call after IOINIT/RAMTAS/RESTOR | — | Sets screen/keyboard defaults |
| `$FF84` | 65412 | **IOINIT** | Init CIAs; SID volume off; set IRQ @ 60 Hz | — | Power‑up or RESTORE flow | — | Sets CIA1 Timer A, bus lines |
| `$FF87` | 65415 | **RAMTAS** | RAM test; set MEMBOT/MEMTOP; zp/pages clear | — | Power‑up | MEMBOT=`$0281/2`, MEMTOP=`$0283/4` | Sets screen base via `$0288` |
| `$FF8A` | 65418 | **RESTOR** | Restore default RAM vectors | — | — | Vectors at `$0314–$0333` reset | Uses ROM table at `$FD30` |
| `$FF8D` | 65421 | **VECTOR** | Read/Write RAM vector table | C=1 read; C=0 write; X/Y=table addr | SEI recommended | Vectors copied to/from (X,Y) | Affects IRQ/NMI; use SEI/CLI |
| `$FF90` | 65424 | **SETMSG** | Enable/disable control & error messages | A: bit7=control messages, bit6=KERNAL error messages | — | — | Does not suppress cassette prompts |
| `$FF93` | 65427 | **SECOND** | Send secondary addr after LISTEN (serial) | A=sec addr | Device is LISTENing | — | For serial LISTEN path |
| `$FF96` | 65430 | **TKSA** | Send secondary addr after TALK (serial) | A=sec addr | Device is TALKing | — | For serial TALK path |
| `$FF99` | 65433 | **MEMTOP** | Get/Set top of BASIC RAM pointer | C=1 get; C=0 set; (get→X/Y; set: X/Y=in) | — | On get: X=lo,Y=hi | Pointer at `$0283/4` |
| `$FF9C` | 65436 | **MEMBOT** | Get/Set bottom of BASIC RAM pointer | C=1 get; C=0 set; (get→X/Y; set: X/Y=in) | — | On get: X=lo,Y=hi | Pointer at `$0281/2` |
| `$FF9F` | 65439 | **SCNKEY** | Scan keyboard; buffer PETSCII | — | IRQ normally handles; call if IRQ off | — | Keycode→`$CB`; buffer at `$0277` |
| `$FFA2` | 65442 | **SETTMO** | Set IEEE/serial timeout flag | A bit7=0 enable; bit7=1 disable | — | — | Rarely used |
| `$FFA5` | 65445 | **ACPTR** | Read byte from current TALKer (serial) | — | Device TALK/TKSA set | A=byte | Use READST for status |
| `$FFA8` | 65448 | **CIOUT** | Send byte to current LISTENer (serial) | A=byte | Device LISTEN/SECOND set | — | Buffers until next/UNLSN |
| `$FFAB` | 65451 | **UNTLK** | Send UNTALK on serial bus | — | — | — | Ends TALK state |
| `$FFAE` | 65454 | **UNLSN** | Send UNLISTEN on serial bus | — | — | — | Ends LISTEN state |
| `$FFB1` | 65457 | **LISTEN** | Send LISTEN+dev | A=device# | — | — | — |
| `$FFB4` | 65460 | **TALK** | Send TALK+dev | A=device# | — | — | — |
| `$FFB7` | 65463 | **READST** | Read & clear I/O status | — | — | A=status | RS‑232 clears its own |
| `$FFBA` | 65466 | **SETLFS** | Set logical file#, device#, secondary | A=file#, X=device#, Y=secondary or `$FF` | — | — | Required before OPEN/LOAD/SAVE |
| `$FFBD` | 65469 | **SETNAM** | Set filename pointer & length | A=len, X=lo, Y=hi | — | — | Points to PETSCII name |
| `$FFC0` | 65472 | **OPEN** | Open channel to device | — | After SETLFS/SETNAM | C=1 on error | Entry uses vector `$031A` |
| `$FFC3` | 65475 | **CLOSE** | Close logical file | A=file# | File was OPENed | — | Frees resources; sends UNLSN |
| `$FFC6` | 65478 | **CHKIN** | Select input channel (logical file) | X=file# | After OPEN | — | For CHRIN/GETIN |
| `$FFC9` | 65481 | **CHKOUT** | Select output channel (logical file) | X=file# | After OPEN | — | For CHROUT |
| `$FFCC` | 65484 | **CLRCHN** | Restore default I/O devices | — | — | — | Keyboard/screen; sends UNTALK/UNLSN if needed |
| `$FFCF` | 65487 | **CHRIN** | Read byte from current input device | — | After CHKIN (or default keyboard) | A=byte | Keyboard path echoes & line-buffers |
| `$FFD2` | 65490 | **CHROUT** | Write byte to current output device | A=byte | After CHKOUT (or default screen) | — | Screen path handles control codes |
| `$FFD5` | 65493 | **LOAD** | Load/Verify to RAM | A=0 load, A=1 verify; X/Y=start | SETLFS/SETNAM done | X/Y=end addr loaded | SA=1 uses header address |
| `$FFD8` | 65496 | **SAVE** | Save RAM to device | A=zp ptr offset; X/Y=end addr | SETLFS/SETNAM done; ZP ptr→start | — | Cassette buffers; disk writes file |
| `$FFDB` | 65499 | **SETTIM** | Set software clock | A=lo, X=mid, Y=hi | — | Clock `$00A0–$00A2` set | Disables IRQ during set |
| `$FFDE` | 65502 | **RDTIM** | Read software clock | — | — | A=lo, X=mid, Y=hi | From `$00A0–$00A2` |
| `$FFE1` | 65505 | **STOP** | Test STOP key | — | UDTIM updates key state | Z=1 if STOP pressed | Also clears I/O channels on stop |
| `$FFE4` | 65508 | **GETIN** | Get next char (unbuffered if possible) | — | Device selected; keyboard uses buffer | A=byte | Via vector `$032A` |
| `$FFE7` | 65511 | **CLALL** | Close all files | — | — | — | Resets open-file index; restores I/O |
| `$FFEA` | 65514 | **UDTIM** | Jiffy clock tick; STOP key scan | — | IRQ calls every 1/60 s | `$00A0–$00A2`++ | Part of standard IRQ |
| `$FFED` | 65517 | **SCREEN** | Return screen size | — | — | X=cols(40), Y=rows(25) | For cross‑platform compatibility |
| `$FFF0` | 65520 | **PLOT** | Read/Set cursor | C=1 read; C=0 set from X=row, Y=column | — | On read: X=row, Y=column | Uses PNTR `$00D3`/TBLX `$00D6` |
| `$FFF3` | 65523 | **IOBASE** | Return I/O base address | — | — | X=lo, Y=hi | Present value `$DC00` (CIA1) |

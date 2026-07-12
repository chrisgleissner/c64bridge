# C64 KERNAL ROM Routines Memory Map — Complete ($E000–$FFFF)

> Purpose: Exhaustive sequential map of KERNAL ROM: callable routines, internal subroutines, constants, tables, IRQ/NMI handlers, and vectors.  
> Format: One table row per symbol; **bold** names indicate callable/public API (also present in `data/api/kernal-api-spec.md`).  
> Conventions: A=Accumulator, X,Y=Index, C=Carry; “—” not applicable.
> Related memory maps: `../memory/memory-map.md`, `../memory/low-memory-map.md`, `../basic/rom-routines.md`, `../io/io-spec.md`.

| Address | Decimal | Name | Function | Args | Input | Output | Notes |
|:--------|:--------|:-----|:---------|:-----|:------|:-------|:------|
| `$E000` | 57344 | EXP cont. | Continuation of BASIC EXP evaluation | — | Entered via BASIC JMP | — | Cross‑ROM linkage |
| `$E043` | 57411 | POLY1 | FP series evaluation helper 1 | — | FAC1 set | — | Calls POLY2 |
| `$E059` | 57433 | POLY2 | FP series evaluation helper 2 | — | FAC1 | FAC1 | Uses constant tables |
| `$E08D` | 57485 | RMULC | FP const for RND multiply (5‑byte) | — | — | — | Constant |
| `$E092` | 57490 | RADDC | FP const for RND add (5‑byte) | — | — | — | Constant |
| `$E097` | 57495 | RND | RND(X): seed ops / scramble | A=mode in FAC | X>0 next; X<0 seed; X=0 CIA/ToD mix | FAC1 | See CIA/BCD caveats |
| `$E0F9` | 57593 | BASIC↔KERNAL I/O | Bridge to CHRIN/CHROUT/CHKx/GETIN | — | — | — | Handles RS‑232 buffer |
| `$E12A` | 57642 | SYS | Perform SYS; register save/restore | — | Uses `$030C–$030F` | Stores back post‑RTS | JSR target from SYS |
| `$E156` | 57686 | SAVE (BASIC) | Prepare range; call KERNAL SAVE | — | Uses `$002B/$002D` | — | Can save arbitrary by ptr tweak |
| `$E165` | 57701 | VERIFY (BASIC) | Set verify flag then LOAD | — | — | — | Falls through LOAD |
| `$E168` | 57704 | LOAD (BASIC) | Prepare start; call KERNAL LOAD | — | Adjusts BASIC links | — | Retains variables; relinks |
| `$E1BE` | 57790 | OPEN (BASIC) | BASIC OPEN → KERNAL OPEN | — | — | — | — |
| `$E1C7` | 57799 | CLOSE (BASIC) | BASIC CLOSE → KERNAL CLOSE | — | — | — | — |
| `$E1D4` | 57812 | Param setup L/V/S | Set filename/LFN/dev/sec | — | Prior to LOAD/SAVE/VERIFY | — | — |
| `$E200` | 57856 | Get int to X | Comma skip, parse integer to X | — | Parsing context | X=integer | — |
| `$E206` | 57862 | Fetch/Endline | Fetch char; if 0, unwind caller | — | — | — | Control‑flow helper |
| `$E20E` | 57870 | Check comma | Require comma; advance text ptr | — | — | — | Error on missing comma |
| `$E219` | 57881 | Param setup O/C | Set filename/LFN/dev/sec for O/C | — | Before OPEN/CLOSE | — | — |
| `$E264` | 57956 | COS | COS(FAC1) via SIN | — | FAC1 | FAC1 | Adds PI/2 then SIN |
| `$E268` | 57960 | SIN | SIN(FAC1) | — | FAC1 | FAC1 | — |
| `$E2B4` | 58036 | TAN | TAN(FAC1)=SIN/COS | — | FAC1 | FAC1 | — |
| `$E2E0` | 58080 | PI2 | Const PI/2 (5‑byte) | — | — | — | Constant |
| `$E2E5` | 58085 | TWOPI | Const 2*PI (5‑byte) | — | — | — | Constant |
| `$E2EA` | 58090 | FR4 | Const 1/4 (5‑byte) | — | — | — | Constant |
| `$E2EF` | 58095 | SINCON | SIN/COS/TAN constants table | — | — | — | 6×5‑byte, count=5 |
| `$E30E` | 58126 | ATN | ATN(FAC1) | — | FAC1 | FAC1 | Uses table |
| `$E33E` | 58174 | ATNCON | ATN constants table | — | — | — | 12×5‑byte, count=11 |
| `$E37B` | 58235 | Warm BASIC | Warm start; CLRCHN; READY vector | — | From BRK | — | Vector `$0300` |
| `$E38B` | 58251 | Error msg | BASIC error/READY printing | X=index | Vector `$0302` next | — | — |
| `$E394` | 58260 | Cold BASIC | Power‑on BASIC init | — | — | — | Copies vectors to RAM |
| `$E3A2` | 58274 | INITAT | CHRGET text (to $0073) | — | — | — | Moved to ZP |
| `$E3BA` | 58298 | RND seed | Initial RND seed (5‑byte) | — | — | — | Constant |
| `$E3BF` | 58303 | INIT | BASIC ZP init; copy CHRGET | — | — | — | — |
| `$E422` | 58402 | Startup msgs | Print banner & BYTES FREE | — | — | — | — |
| `$E447` | 58439 | BASIC vec tbl | ROM vector table (→RAM $0300) | — | — | — | — |
| `$E453` | 58451 | Copy vec | Copy BASIC vectors to RAM | — | — | — | — |
| `$E460` | 58464 | WORDS | Text constants | — | — | — | — |
| `$E4AD` | 58541 | CHKOUT patch | Preserve A on BASIC→KERNAL CHKOUT | — | — | — | Later KERNAL patch |
| `$E4B7` | 58551 | Unused | 35 bytes of $AA | — | — | — | — |
| `$E4DA` | 58586 | Color RAM clr | Clear line color to background | — | Called by `$E9FF` | — | Patch; changes old behavior |
| `$E4E0` | 58592 | Tape pause | Pause after FOUND; auto‑continue | — | Cassette find | — | Newer KERNAL |
| `$E4EC` | 58604 | PAL baud tbl | PAL RS‑232 prescalers | — | — | — | Matches NTSC at `$FEC2` |
| `$E500` | 58624 | **IOBASE** | Return I/O base | — | — | X=lo,Y=hi | Default `$DC00` |
| `$E505` | 58629 | **SCREEN** | Return screen cols/rows | — | — | X=40,Y=25 | For compat layouts |
| `$E50A` | 58634 | **PLOT** | Read/Set cursor | C=1 read; C=0 set; Y=row,X=col | — | Read→X/Y | Uses PNTR/TBLX |
| `$E518` | 58648 | CINT (part) | Init screen/keyboard (orig) | — | — | — | Falls through |
| `$E544` | 58692 | Screen links | Init line link table; clear screen | — | — | — | — |
| `$E566` | 58726 | Home | Home cursor | — | — | — | Sets PNTR/TBLX=0 |
| `$E56C` | 58732 | PNT set | Pointer to current line | — | Uses links | `$00D1/$00D2` | — |
| `$E5A0` | 58784 | Defaults | Set default I/O; init VIC regs | — | — | — | Writes table at `$ECB9` |
| `$E5B4` | 58804 | LP2 | Pop from keyboard buffer | — | Buffer `$0277` | A=char | — |
| `$E5CA` | 58826 | KBD line | Line input; echo; handles SHIFT‑RUN/STOP | — | Keyboard CHKIN path | A=bytes of line | — |
| `$E632` | 58930 | CHRIN (kbd/scr) | Device handler for keyboard/screen | — | From CHRIN/GETIN | A=byte | — |
| `$E684` | 59012 | Quote test | Toggle quote flag | — | — | — | `$00D4` |
| `$E691` | 59025 | Add char | Put printable to screen | A=PETSCII | — | — | — |
| `$E6A8` | 59048 | Exit print | Common exit of screen output | — | — | — | — |
| `$E6B6` | 59062 | Advance cur | Advance cursor; scroll/insert as needed | — | — | — | — |
| `$E701` | 59137 | Back 40 | Move cursor back across 40‑col boundary | — | — | — | — |
| `$E716` | 59158 | Screen out | CHROUT screen device path | A=byte | — | — | Prints/control‑codes |
| `$E87C` | 59516 | Next line | Cursor to next line / scroll | — | — | — | — |
| `$E891` | 59537 | CR | Carriage return behavior | — | — | — | Reset modes; move line |
| `$E8A1` | 59553 | BOF prev | If at start of line, move up | — | — | — | — |
| `$E8B3` | 59571 | EOF next | If at end of line, move down | — | — | — | — |
| `$E8CB` | 59595 | Color chk | Detect color control | A=code | — | — | — |
| `$E8D1` | 59601 | Color tbl | PETSCII→color control map | — | — | — | 16 entries listed |
| `$E8EA` | 59626 | Scroll | Scroll screen | — | CTRL pauses | — | — |
| `$E965` | 59749 | Insert line | Insert blank physical line | — | — | — | — |
| `$E9C8` | 59848 | Move line | Move screen line (and color) | — | — | — | — |
| `$E9E0` | 59872 | Set color ptr | Temp color pointer for scrolling | — | — | `$00AE/$00AF` | — |
| `$E9F0` | 59888 | Set line start | Pointer to start of line by X | X=line# | — | `$00D1/$00D2` | — |
| `$E9FF` | 59903 | Clear line | Clear screen line & color | — | — | — | Uses `$E4DA` patch |
| `$EA13` | 59923 | Blink & color | Cursor blink timer & color RAM base | — | — | — | — |
| `$EA1C` | 59932 | Store to screen | Store A to screen, X to color | A=char,X=color | `$00D1`/`$00F3` set | — | — |
| `$EA24` | 59940 | Sync color ptr | Sync color ptr to screen line | — | `$00D1` | `$00F3` | — |
| `$EA31` | 59953 | IRQ | Standard IRQ entry | — | Via `$0314` | Updates jiffy clock; SCNKEY | Every 1/60 s |
| `$EA87` | 60039 | **SCNKEY** | Keyboard scan; buffer char | — | IRQ context | Keycode→`$00CB` | Sets shift/control flags |
| `$EAE0` | 60128 | Decode→buffer | Decode key; handle repeat; buf put | — | Keycode | Adds to `$0277` | — |
| `$EB48` | 60232 | Set decode tbl | Choose PETSCII table (shift/ctrl/logo) | — | Flags at `$028D` | `$00F5` ptr | Handles char set toggle |
| `$EB79` | 60281 | Tbl vectors | Addresses of decode tables | — | — | — | — |
| `$EB81` | 60289 | Std decode | Standard key decode table | — | — | — | 64+1 entries |
| `$EBC2` | 60354 | Shift decode | Shifted key decode table | — | — | — | 64+1 entries |
| `$EC03` | 60419 | Logo decode | Commodore‑logo decode table | — | — | — | 64+1 entries |
| `$EC44` | 60484 | Charset switch | Handle CHR$(14)/CHR$(142) | — | — | — | Writes `$D018` |
| `$EC5E` | 60510 | Toggle enable | Enable/disable charset toggle | — | — | — | Uses `$0291` |
| `$EC78` | 60536 | Ctrl decode | Control key decode table | — | — | — | 64+1 entries |
| `$ECB9` | 60601 | VIC defaults | VIC‑II register default table | — | — | — | 47 regs |
| `$ECE7` | 60647 | Shift‑RUN text | "LOAD\rRUN\r" buffer text | — | — | — | Injected on SHIFT‑RUN |
| `$ECF0` | 60656 | Screen low tbl | Low bytes of line addresses | — | — | — | High from links/`$0288` |
| `$ED09` | 60681 | **TALK** | Send TALK+dev | A=dev | — | — | — |
| `$ED0C` | 60684 | **LISTEN** | Send LISTEN+dev | A=dev | — | — | — |
| `$ED11` | 60689 | Serial cmd | Send serial command in A | A=cmd | — | — | Helper |
| `$ED40` | 60736 | Serial out | Send byte on serial bus | A=byte | `$0095` buffer used | — | — |
| `$EDB0` | 60848 | Serial timeout | TIMEOUT handler | — | — | Sets status | — |
| `$EDB9` | 60857 | **SECOND** | Send secondary after LISTEN | A=sec | LISTEN sent | — | — |
| `$EDC7` | 60871 | **TKSA** | Send secondary after TALK | A=sec | TALK sent | — | — |
| `$EDDD` | 60893 | **CIOUT** | Serial write byte | A=byte | LISTEN path active | — | Buffers until UNLSN |
| `$EDEF` | 60911 | **UNTLK** | Send UNTALK | — | — | — | — |
| `$EDFE` | 60926 | **UNLSN** | Send UNLISTEN | — | — | — | — |
| `$EE13` | 60947 | **ACPTR** | Serial read byte | — | TALK path active | A=byte | — |
| `$EE85` | 61061 | SCLK low | Serial clock low | — | — | — | CIA2 `$DD00`.4 |
| `$EE8E` | 61070 | SCLK high | Serial clock high | — | — | — | CIA2 `$DD00`.4 |
| `$EE97` | 61079 | SDATA low | Serial data low | — | — | — | CIA2 `$DD00`.5 |
| `$EEA9` | 61097 | Read SDATA/SCLK | Read serial input bits | — | — | C=data, N=clock | CIA2 `$DD00`.7/.6 |
| `$EEB3` | 61107 | Delay 1ms | Busy wait ~1 ms | — | — | — | Timing helper |
| `$EEBB` | 61115 | RS232 send bit | NMI bit‑send routine | — | NMI context | — | — |
| `$EF2E` | 61230 | RS232 errors | Set RS‑232 status bits | — | — | Status at `$0297` | — |
| `$EF4A` | 61258 | RS232 wordlen | Word length to X | — | Control reg | X=len | — |
| `$EF59` | 61273 | RS232 recv bit | NMI bit‑receive routine | — | NMI context | — | — |
| `$EF7E` | 61310 | RS232 setup rx | Setup to receive new byte | — | — | — | — |
| `$EF90` | 61328 | RS232 start? | Test start bit | — | — | — | — |
| `$EF97` | 61335 | RS232 store | Store received byte; check errors | — | — | — | Manage overrun/parity etc. |
| `$EFE1` | 61409 | RS232 CHKOUT | Device‑specific CHKOUT | — | After OPEN | — | — |
| `$F014` | 61460 | RS232 CHROUT | Device‑specific CHROUT | A=byte | After CHKOUT | — | — |
| `$F04D` | 61517 | RS232 CHKIN | Device‑specific CHKIN | — | After OPEN | — | — |
| `$F086` | 61574 | RS232 GETIN | Device‑specific GETIN | — | — | A=byte | Checks buffer empty |
| `$F0A4` | 61604 | Stop RS232 NMIs | Disable RS‑232 NMIs for tape/serial | — | Before cassette/serial ops | — | Timing safety |
| `$F0BD` | 61629 | Ctrl messages | Text: I/O ERROR, SEARCHING, … | — | — | — | High bit set on last char |
| `$F12B` | 61739 | Print error | Print KERNAL error if direct | Y=index | Message flag `$009D` | — | — |
| `$F13E` | 61758 | **GETIN** | Get next char | — | Device selected | A=byte | Vector `$032A` |
| `$F157` | 61783 | **CHRIN** | Read from current input | — | After CHKIN | A=byte | Keyboard path does line read |
| `$F1CA` | 61898 | **CHROUT** | Output to current device | A=byte | After CHKOUT | — | Screen handler at `$E716` |
| `$F20E` | 61966 | **CHKIN** | Select input channel | X=file# | After OPEN | — | Sends TALK/SA as needed |
| `$F250` | 62032 | **CHKOUT** | Select output channel | X=file# | After OPEN | — | Sends LISTEN/SA as needed |
| `$F291` | 62097 | **CLOSE** | Close logical file | A=file# | File open | — | Frees buffers; UNLSN |
| `$F30F` | 62223 | Find LFN | Find file in LFN table | A=file# | Tables at `$0259/$0263/$026D` | X=index | Helper |
| `$F31F` | 62239 | Set current | Set current LFN/dev/SA | — | — | `$00B8–$00BA` | Helper |
| `$F32F` | 62255 | **CLALL** | Close all channels | — | — | — | Vector `$032C` |
| `$F333` | 62259 | **CLRCHN** | Restore default I/O | — | — | — | Keyboard/screen |
| `$F34A` | 62282 | **OPEN** | Open logical file | — | After SETLFS/SETNAM | C=1 on error | Vector `$031A` |
| `$F49E` | 62622 | **LOAD** | Load/Verify RAM | A=0/1; X/Y=start | After SETLFS/SETNAM | X/Y=end addr | SA=1 uses header |
| `$F5A5` | 62885 | SEARCHING | Print SEARCHING (direct mode) | — | Direct mode | — | — |
| `$F5D2` | 62930 | LOAD/VERIFY msg | Print LOADING/VERIFYING | — | — | — | — |
| `$F5DD` | 62941 | **SAVE** | Save RAM to device | A=ZP ptr; X/Y=end addr | After SETLFS/SETNAM | — | Vector `$0332` |
| `$F68F` | 63119 | SAVING msg | Print SAVING and filename | — | Direct mode | — | — |
| `$F69B` | 63131 | **UDTIM** | Update clock; STOP scan | — | IRQ 60 Hz | `$00A0–$00A2`++ | STOP key to `$0091` |
| `$F6DD` | 63197 | **RDTIM** | Read clock | — | — | A=lo,X=mid,Y=hi | From `$00A0–$00A2` |
| `$F6E4` | 63204 | **SETTIM** | Set clock | A=lo,X=mid,Y=hi | — | Clock set | Disables IRQ during set |
| `$F6ED` | 63213 | **STOP** | Test STOP key | — | — | Z=1 if pressed | Also CLRCHN & clear queue |
| `$F6FB` | 63227 | I/O error | Handle KERNAL I/O errors | — | — | C=1, A=code | Prints if enabled |
| `$F72C` | 63276 | Tape: next header | Find next tape header; print FOUND | — | Cassette | — | — |
| `$F76A` | 63338 | Tape: write hdr | Write tape header block | — | — | — | — |
| `$F7D0` | 63440 | Tape: ptr→X/Y | Pointer to tape buffer | — | — | X/Y | — |
| `$F7D7` | 63447 | Tape: set IO area | I/O start/end to tape buffer | — | — | — | — |
| `$F7EA` | 63466 | Tape: search name | Search tape for filename | — | — | — | — |
| `$F817` | 63511 | Tape: buttons read | Press PLAY msg; wait / OK | — | Direct mode unaffected | — | — |
| `$F82E` | 63534 | Cassette sense | Check cassette switch | — | — | — | — |
| `$F838` | 63544 | Tape: buttons write | Press PLAY & RECORD msg; wait / OK | — | — | — | — |
| `$F841` | 63553 | Tape: start read | Init flags; start read | — | — | — | — |
| `$F864` | 63588 | Tape: start write | Init flags; start write | — | — | — | — |
| `$F875` | 63605 | Tape: common | Setup IRQ, blank screen, save/replace IRQ | — | — | — | Uses CIA1 Timer B |
| `$F8D0` | 63696 | Tape: STOP test | Test STOP during tape I/O | — | — | — | — |
| `$F8E2` | 63714 | Tape: TimerA tune | Adjust CIA1 Timer A for bit timing | — | — | — | — |
| `$F92C` | 63788 | Tape: read IRQ | IRQ handler for tape read | — | IRQ | — | Restores IRQ at end |
| `$FA60` | 64096 | Tape: get byte | Receive/store next cassette byte | — | IRQ | — | — |
| `$FB8E` | 64398 | Tape: addr→172 | Copy save/load address to `$00AC` | — | — | — | — |
| `$FB97` | 64407 | Tape: reset counters | For new byte R/W | — | — | — | — |
| `$FBA6` | 64422 | Tape: toggle out | Toggle 6510 port bit 3 for data | — | — | — | `$0001`.3 |
| `$FBC8` | 64456 | Tape: write IRQ 2 | Cassette write (part 2) | — | IRQ | — | — |
| `$FC6A` | 64618 | Tape: write IRQ 1 | Cassette write (part 1) | — | IRQ | — | — |
| `$FC93` | 64659 | IRQ restore | Restore default IRQ; stop motor | — | — | — | Re‑enable 60 Hz IRQ |
| `$FCB8` | 64696 | Tape I/O end | Terminate cassette I/O | — | — | — | RTS from IRQ |
| `$FCCA` | 64714 | Tape motor off | Turn off cassette motor | — | — | — | — |
| `$FCD1` | 64721 | Tape ptr chk | Compare R/W ptr vs end | — | — | — | — |
| `$FCDB` | 64731 | Tape ptr adv | Advance R/W pointer | — | — | — | — |
| `$FCE2` | 64738 | RESET | Power‑on reset entry | — | HW reset | — | Checks cartridge; calls IOINIT,RAMTAS,RESTOR,CINT |
| `$FD02` | 64770 | Cart detect | Check autostart cartridge | — | — | Z set on match | Compares `$8004–$8008` |
| `$FD10` | 64784 | Cart text | CBM+“80” text for detect (hi‑bit set) | — | — | — | — |
| `$FD15` | 64789 | **RESTOR** | Restore RAM vectors | — | — | — | Uses ROM table `$FD30` |
| `$FD1A` | 64794 | **VECTOR** | Read/Write vectors | C=1 read; C=0 write; X/Y=table | — | Copy vectors | Affect IRQ/NMI; SEI |
| `$FD30` | 64816 | Default vectors | ROM vector table (to `$0314–$0333`) | — | — | — | — |
| `$FD50` | 64848 | **RAMTAS** | RAM test; set pointers | — | — | `$0281–$0284` | Clears ZP, pages 2–3 |
| `$FD9B` | 64923 | IRQ vector tbl | Pointers to IRQ routines | — | — | — | Tape write1/2, standard IRQ, tape read |
| `$FDA3` | 64931 | **IOINIT** | Initialize CIAs/SID | — | — | — | Sets CIA1 Timer A |
| `$FDF9` | 65017 | **SETNAM** | Set filename pointer/len | A=len, X=lo, Y=hi | — | — | For OPEN/LOAD/SAVE |
| `$FE00` | 65024 | **SETLFS** | Set LFN/dev/SA | A=lfn, X=dev, Y=sa or `$FF` | — | — | For OPEN/LOAD/SAVE |
| `$FE07` | 65031 | **READST** | Read I/O status word | — | — | A=status | RS‑232 clears own |
| `$FE18` | 65048 | **SETMSG** | Control/error messages | A bits6–7 | — | — | — |
| `$FF81` | 65409 | **CINT** | Init screen/keyboard | — | — | — | Jump table |
| `$FF84` | 65412 | **IOINIT** | Initialize I/O | — | — | — | Jump table |
| `$FF87` | 65415 | **RAMTAS** | RAM test/setup | — | — | — | Jump table |
| `$FF8A` | 65418 | **RESTOR** | Restore vectors | — | — | — | Jump table |
| `$FF8D` | 65421 | **VECTOR** | Vectors R/W | C,X,Y | — | — | Jump table |
| `$FF90` | 65424 | **SETMSG** | Message flags | A | — | — | Jump table |
| `$FF93` | 65427 | **SECOND** | Serial SA after LISTEN | A | — | — | Jump table |
| `$FF96` | 65430 | **TKSA** | Serial SA after TALK | A | — | — | Jump table |
| `$FF99` | 65433 | **MEMTOP** | Get/Set top of RAM | C,X,Y | — | X/Y | Jump table |
| `$FF9C` | 65436 | **MEMBOT** | Get/Set bottom of RAM | C,X,Y | — | X/Y | Jump table |
| `$FF9F` | 65439 | **SCNKEY** | Keyboard scan | — | — | — | Jump table |
| `$FFA2` | 65442 | **SETTMO** | Timeout control | A | — | — | Jump table |
| `$FFA5` | 65445 | **ACPTR** | Serial read | — | — | A | Jump table |
| `$FFA8` | 65448 | **CIOUT** | Serial write | A | — | — | Jump table |
| `$FFAB` | 65451 | **UNTLK** | Serial UNTALK | — | — | — | Jump table |
| `$FFAE` | 65454 | **UNLSN** | Serial UNLISTEN | — | — | — | Jump table |
| `$FFB1` | 65457 | **LISTEN** | Serial LISTEN | A | — | — | Jump table |
| `$FFB4` | 65460 | **TALK** | Serial TALK | A | — | — | Jump table |
| `$FFB7` | 65463 | **READST** | Read status | — | — | A | Jump table |
| `$FFBA` | 65466 | **SETLFS** | Set LFN/dev/SA | A,X,Y | — | — | Jump table |
| `$FFBD` | 65469 | **SETNAM** | Set filename | A,X,Y | — | — | Jump table |
| `$FFC0` | 65472 | **OPEN** | Open | — | — | C on error | Jump table |
| `$FFC3` | 65475 | **CLOSE** | Close | A | — | — | Jump table |
| `$FFC6` | 65478 | **CHKIN** | Select input | X | — | — | Jump table |
| `$FFC9` | 65481 | **CHKOUT** | Select output | X | — | — | Jump table |
| `$FFCC` | 65484 | **CLRCHN** | Restore default I/O | — | — | — | Jump table |
| `$FFCF` | 65487 | **CHRIN** | Read byte | — | — | A | Jump table |
| `$FFD2` | 65490 | **CHROUT** | Write byte | A | — | — | Jump table |
| `$FFD5` | 65493 | **LOAD** | Load/Verify | A,X,Y | — | X/Y=end | Jump table |
| `$FFD8` | 65496 | **SAVE** | Save | A,X,Y | — | — | Jump table |
| `$FFDB` | 65499 | **SETTIM** | Set clock | A,X,Y | — | — | Jump table |
| `$FFDE` | 65502 | **RDTIM** | Read clock | — | — | A,X,Y | Jump table |
| `$FFE1` | 65505 | **STOP** | Test STOP | — | — | Z flag | Jump table |
| `$FFE4` | 65508 | **GETIN** | Get char | — | — | A | Jump table |
| `$FFE7` | 65511 | **CLALL** | Close all | — | — | — | Jump table |
| `$FFEA` | 65514 | **UDTIM** | Jiffy tick | — | — | — | Jump table |
| `$FFED` | 65517 | **SCREEN** | Screen size | — | — | X,Y | Jump table |
| `$FFF0` | 65520 | **PLOT** | Cursor read/set | C,X,Y | — | X,Y | Jump table |
| `$FFF3` | 65523 | **IOBASE** | I/O base | — | — | X,Y | Jump table |
| `$FFFA` | 65530 | NMI vec | NMI vector | — | HW | — | RAM at `$0318/9` |
| `$FFFC` | 65532 | RESET vec | RESET vector | — | HW | — | Points to `$FCE2` |
| `$FFFE` | 65534 | IRQ/BRK vec | IRQ/BRK vector | — | HW | — | RAM at `$0314/5` |

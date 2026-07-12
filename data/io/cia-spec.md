# Commodore 64 CIA Specification

> Purpose: Single source of truth for CIA hardware on the C64 (LLM/MCP).  
> Companion specs: `io-spec.md` (system I/O topology, IEC/tape/ports), `data/printer/printer-spec.md` (printers).  
> Notes: Do **not** duplicate I/O details here—refer to `io-spec.md`. This file defines *exact CIA semantics*. Where sources disagree, this merged spec defers to the attached “Mapping the C64 CIA” and the C64 Programmer’s Reference Guide.

## Overview

- **Chips:** 2× MOS **6526/6526A/8521** (functionally equivalent for C64 use).  
- **Address blocks:** **CIA1** `$DC00–$DC0F` (mirrored every 16 bytes to `$DCFF`), **CIA2** `$DD00–$DD0F` (mirrored to `$DDFF`).  
- **Core units:** Ports **PA/PB (8+8)**, **Timers A/B (16‑bit)**, **TOD clock+alarm (BCD)**, **Serial shift (SDR)**, **ICR**.  
- **System wiring:** CIA1 → **/IRQ**; CIA2 → **/NMI**. `FLAG` inputs: **CIA1** (cassette READ), **CIA2** (user port pin B).  
- **Electrical:** Port bits are open‑collector with pull‑ups; CMOS‑compatible; CNT/SP serial pins present on user port.  
- **Defaults after init:** CIA1 `DDRA=$FF` (PA out), `DDRB=$00` (PB in); CIA2 `DDRA=$3F` (bits 6–7 in), `DDRB=$00` (in).  
- **Cross‑refs:** IEC bus, user port pins, datasette lines, VIC bank select, joystick/paddles/key scan → see `io-spec.md`.

## CIA #1 Registers (`$DC00–$DC0F`) — Keyboard/Joysticks/Paddles/Lightpen/IRQ

| Address | Decimal | Name | Function / Bits (compact) |
|:-------:|:-------:|:-----|:---------------------------|
| `$DC00` | 56320 | **PRA** | Keyboard **column select** (write), **joy2** read, paddle mux/fire. **b7..b0** column sel; **b7/b6** paddle mux (`01`=Port1, `10`=Port2); **b4** joy2 fire (0=pressed); **b3..b0** joy2 dir; **b3..b2** paddle fires. |
| `$DC01` | 56321 | **PRB** | Keyboard **row read**, **joy1** read, timer outputs. **b7..b0** rows; **b7** Timer B out (toggle/pulse); **b6** Timer A out; **b4** joy1 fire (0=pressed); **b3..b0** joy1 dir; **b3..b2** paddle fires. |
| `$DC02` | 56322 | **DDRA** | Port A direction (0=in, 1=out). Default `$FF`. |
| `$DC03` | 56323 | **DDRB** | Port B direction (0=in, 1=out). Default `$00`. |
| `$DC04` | 56324 | **TALO** | Timer A **low**. **R:** counter; **W:** latch low. |
| `$DC05` | 56325 | **TAHI** | Timer A **high**. **R:** counter; **W:** latch high (if stopped, also loads). |
| `$DC06` | 56326 | **TBLO** | Timer B **low**. **R/W** as above. |
| `$DC07` | 56327 | **TBHI** | Timer B **high**. **R/W** as above. |
| `$DC08` | 56328 | **TOD10TH** | TOD tenths BCD (0–9). **CRB7=0:** writes set **time**; **=1:** set **alarm**. |
| `$DC09` | 56329 | **TODSEC** | TOD seconds BCD. |
| `$DC0A` | 56330 | **TODMIN** | TOD minutes BCD. |
| `$DC0B` | 56331 | **TODHR** | TOD hours BCD; **b7 AM/PM** (1=PM). **Write halts** TOD until `$DC08` read. |
| `$DC0C` | 56332 | **SDR** | Serial shift data. **CRA6:** 0=input (SP→SDR on CNT↑); 1=output (SDR→SP, CNT strobes). |
| `$DC0D` | 56333 | **ICR** | **R:** b0 TA UF, b1 TB UF, b2 TOD=ALARM, b3 serial byte, b4 FLAG; **b7**=any pending. **W:** b7=1 set mask bits0–4; b7=0 clear them. **Read clears** status bits. |
| `$DC0E` | 56334 | **CRA** | **Timer A ctrl**/**serial/TOD**: **b0** start; **b1** PB6 enable; **b2** PB6 mode (1 toggle / 0 pulse); **b3** one‑shot; **b4** force load; **b5** count src (1=CNT / 0=Φ2); **b6** SDR dir (1 out); **b7** TOD freq (1=50 Hz/0=60 Hz). |
| `$DC0F` | 56335 | **CRB** | **Timer B ctrl/TOD sel**: **b0** start; **b1** PB7 enable; **b2** PB7 mode; **b3** one‑shot; **b4** force load; **b6..b5** mode: `00`=Φ2, `01`=CNT, `10`=TA underflow, `11`=TA underflow gated by CNT; **b7** TOD write target (1=ALARM/0=TIME). |

**Notes (CIA1):** Keyboard matrix via column write (PRA) + row read (PRB), active‑low. Joystick‑keyboard contention on **Port 1** (PRB) exists; avoid or gate scanning accordingly. Paddle select uses **PRA b7/b6**; paddle *positions* read via SID POTX/POTY; paddle buttons via CIA (bits 2–3). Lightpen appears as fire on PRA b4 and via VIC `/LP`.

## CIA #2 Registers (`$DD00–$DD0F`) — IEC/User Port/RS‑232/VIC Bank/NMI

| Address | Decimal | Name | Function / Bits (compact) |
|:-------:|:-------:|:-----|:---------------------------|
| `$DD00` | 56576 | **PRA** | **IEC** + **VIC bank** + RS‑232 TXD. **b7** DATA IN, **b6** CLOCK IN, **b5** DATA OUT, **b4** CLOCK OUT, **b3** ATN OUT (bus lines active‑low via drivers); **b2** RS‑232 TXD (user M); **b1..b0** VIC 16 KiB bank: `00=$C000–FFFF`, `01=$8000–BFFF`, `10=$4000–7FFF`, `11=$0000–3FFF` (power‑on `11`). |
| `$DD01` | 56577 | **PRB** | **User Port/RS‑232** lines (TTL). **b7** DSR (L), **b6** CTS (K), **b5** User‑J, **b4** DCD (H), **b3** RI (F), **b2** DTR (E), **b1** RTS (D), **b0** RXD (C). **Also:** PB7/PB6 timer outputs when enabled. |
| `$DD02` | 56578 | **DDRA** | Port A direction. Default `$3F` (b6–b7 in). |
| `$DD03` | 56579 | **DDRB** | Port B direction. Default `$00`; RS‑232 may set b1–b2 out when opened. |
| `$DD04` | 56580 | **TALO** | Timer A low (R counter / W latch low). |
| `$DD05` | 56581 | **TAHI** | Timer A high (R counter / W latch high). |
| `$DD06` | 56582 | **TBLO** | Timer B low. |
| `$DD07` | 56583 | **TBHI** | Timer B high. |
| `$DD08` | 56584 | **TOD10TH** | TOD tenths BCD. (OS typically unused here.) |
| `$DD09` | 56585 | **TODSEC** | TOD seconds BCD. |
| `$DD0A` | 56586 | **TODMIN** | TOD minutes BCD. |
| `$DD0B` | 56587 | **TODHR** | TOD hours BCD + AM/PM (b7). |
| `$DD0C` | 56588 | **SDR** | Serial shift data (rarely used by OS; available via user port SP2/CNT2). |
| `$DD0D` | 56589 | **ICR** | As CIA1, but flags drive **/NMI**. **b4**=FLAG (user‑port pin B). |
| `$DD0E` | 56590 | **CRA** | As CIA1 `$DC0E`. |
| `$DD0F` | 56591 | **CRB** | As CIA1 `$DC0F`. |

**Notes (CIA2):** Provides **IEC** master control (ATN/CLOCK/DATA), **User Port** digital I/O and RS‑232 signals, and **VIC bank** selection via `PRA[1:0]`. `/PC2` (handshake) pulses low for one cycle after **PRB** access—available on user port for external strobing.

## Timers (A/B) — Operation

- **16‑bit down‑counters** with separate **latches** (write low→high). **Start** or **CRA/CRB b4** forces latch→counter.  
- **Clock sources:** Φ2 (system cycles) or **CNT** pulses; **Timer B** can count **Timer A underflows**, gated by CNT if mode `11`.  
- **Underflow:** Sets ICR bit (and asserts IRQ/NMI). Optional **PB6/PB7** **pulse** (b2=0) or **toggle** (b2=1). **b3=1** one‑shot; else auto‑reload.  
- **Readback:** Reads return current counter; device internally manages proper two‑byte read behavior.  
- **Typical OS setup:** CIA1 Timer A ≈ 1/60 s IRQ; tape I/O repurposes CIA1 timers; CIA2 timers often used by RS‑232.  

## Time‑of‑Day (TOD) Clock — BCD + Alarm

- **Regs:** `$xx08–$xx0B` (10th, sec, min, hr). **Hours b7**=AM/PM.  
- **Write target:** **CRB7=0** write **time**; **CRB7=1** write **alarm**.  
- **Halt rule:** Writing **TODHR** halts update until **TOD10TH** is read (for read‑latch/write‑latch coherency).  
- **Tick source:** **CRA7** selects 60 Hz/50 Hz. **Alarm match** sets ICR bit2 (IRQ/NMI by CIA).  

## Serial Shift (SDR) — SP/CNT

- **Direction:** **CRA6** (0=in, 1=out).  
- **Input:** On **CNT↑**, bit from **SP** shifts into SDR; byte complete → **ICR b3**.  
- **Output:** With Timer A running (cont.), SDR shifts MSB→LSB out **SP** with **CNT** strobes; byte complete → **ICR b3**.  
- **System:** OS uses port‑bit IEC more than SDR; SDR remains available on user port **SP1/CNT1** (CIA1) and **SP2/CNT2** (CIA2).  

## Interrupts (ICR) — Mask/Status

- **Status read (clears):** b0 TA UF, b1 TB UF, b2 TOD alarm, b3 serial, b4 FLAG; **b7**=any pending (ANDed with mask).  
- **Mask write:** **b7=1** sets bits 0–4; **b7=0** clears bits 0–4; bits written as 0 are unchanged.  
- **Wiring:** CIA1 ICR → **/IRQ**; CIA2 ICR → **/NMI** (not maskable by SEI).  

## Pinout (logical summary)

`PA0–PA7`, `PB0–PB7` (parallel I/O); `/PC` (handshake pulse after PB access; only CIA2 connected externally); `SP` (serial data), `CNT` (count/serial clock); `FLAG` (neg‑edge IRQ/NMI input); `/IRQ` (CIA1), `/NMI` (CIA2); `RS0–RS3` (reg select); `DB0–DB7`; `R/W`; `/CS`; `/RES`; `Φ2`; `Vcc`; `Vss`.  
User‑port mapping for CIA2 PRB and PRA b2 is defined in `io-spec.md` (pin letters C..N).  

## Behavior Notes / Gotchas (LLM hints)

- **Keyboard scan vs Joystick 1:** Shared on **PRB**; keyscan can misread joystick state and vice‑versa. Gate scan or prefer **Port 2** for games.  
- **Paddles:** Buttons via CIA **bits 2–3**; *positions* via **SID** POTX/POTY; select port with **PRA b7/b6**.  
- **Mirroring:** Access any `$xx00–$xx0F` alias in the `$xx10–$xxFF` window; use base addresses for clarity.  
- **VIC bank:** Use **CIA2 PRA[1:0]**; update VIC `$D018` pointers accordingly (see `io-spec.md`).  
- **Datasette:** READ→CIA1 **FLAG** (ICR b4); MOTOR/WRITE/SENSE via CPU `$0001` (see `io-spec.md`).  

## Cross‑References

- **System I/O (IEC, tape, user/expansion ports, keyboard algorithm):** `io-spec.md`  
- **Printers:** `data/printer/printer-spec.md`  
- **KERNAL vector/entry points:** `../kernal/rom-routines.md`

---

**Provenance:**

- [C64 Programmer’s Reference Guide](https://www.zimmers.net/cbmpics/cbm/c64/c64prg.txt)
- [Mapping the C64](https://www.zimmers.net/anonftp/pub/cbm/c64/manuals/mapping-c64_txt)

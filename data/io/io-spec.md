# Commodore 64 I/O Specification

**Scope:** Single source of truth for C64 I/O architecture and programmer interfaces.  

**Companion docs:** 

- `data/io/cia-spec.md` (CIA registers/semantics)
- `data/drive/drive-spec.md` (printer details)
- `data/printer/printer-spec.md` (printer details)

---

## 1. I/O Topology (What connects where)

- **CIA1 (@ $DC00)** → Keyboard matrix, Joystick Port 1, Joystick Port 2 (via matrix), Paddles select, Lightpen flag, Datasette read IRQ flag, IRQ output.  
- **CIA2 (@ $DD00)** → Serial IEC bus (ATN/CLOCK/DATA), User Port (PB0–PB7; RS‑232 lines), VIC bank select (PRA[1:0]), NMI output.  
- **6510 CPU Port ($0000/$0001)** → Memory map control; **Datasette motor, sense, write** lines. Datasette **read** goes to **CIA1 FLAG**.  
- **Expansion Port** → Direct 6510 bus (A/D/R/W/Φ2/IRQ/NMI/RESET); cartridges/REUs map registers/ROM, **bypassing CIAs**.  
- **SID** → Paddles (analog) POTX/POTY; audio; not covered here.
- **VIC-II** → Lightpen latch; video; not covered here.

(For CIA registers and bit meanings, see `cia-spec.md`.)

---

## 2. Device Addressing & KERNAL I/O

- **Device numbers (IEC):** Printers **4–7** (convention: 4), Storage **8–30** (convention: first disk **8**). Keyboard=0, Tape=1, RS‑232=2, Screen=3. Secondary addresses distinguish channels on same device.
- **Bus role:** C64 is IEC **master**; commands: **LISTEN**, **TALK**, **UNLISTEN**, **UNTALK**, **OPEN/CLOSE channel**, with **ATN** controlling command vs data phases.
- **Key KERNAL entry points:** `OPEN`, `CLOSE`, `CHKIN`, `CHKOUT`, `CLRCHN`, `CHRIN`, `CHROUT`, `LOAD`, `SAVE` (see pagetable KERNAL reference for exact call vectors/regs).

---

## 3. Serial IEC Bus (Disk, Printers)

**Physical lines (on CIA2 PRA):**  

- **b3 ATN OUT**, **b4 CLOCK OUT**, **b5 DATA OUT** (active‑low drivers via 7406), **b6 CLOCK IN**, **b7 DATA IN**. Use open‑collector semantics (0V=true/active). Bytes shift **LSB first**, valid on **CLK rising**.

**Protocol sketch:**  

1) Master asserts **ATN**, sends device **TALK/LISTEN** + (optional) **secondary address**.  
2) Data phase with **ATN released**; talker drives DATA, listeners ack. **EOI** marks last byte.  
3) Master sends **UNLISTEN/UNTALK** to end.

> Use KERNAL calls where possible; custom fastloaders may bit‑bang CIA2 lines for speed.

---

## 4. Datasette (Tape) I/O

- **CPU Port ($0001):** **bit5 MOTOR** (0=on), **bit4 SENSE** (0=key pressed), **bit3 WRITE** (tape out). Direction via $0000.
- **Read:** Cassette **READ → CIA1 /FLAG** (edge‑sensitive, falling only). **ICR bit4** set on edge; enable IRQ via ICR mask.
- **Implication:** Can **toggle** write/motor; **cannot level‑poll** read—only edges—so loaders measure inter‑edge timing (often with CIA timers).

---

## 5. Keyboard (Matrix Scan) — Detailed

**Hardware:** 8×8 matrix via **CIA1**: write **PRA ($DC00)** to select **column**, read **PRB ($DC01)** to sense **rows** (active‑low). Configure **DDRA=$FF**, **DDRB=$00**. Typical scan masks: `$FE,$FD,$FB,$F7,$EF,$DF,$BF,$7F`.
**Algorithm (debounce omitted):**  

```text
init:  DDRA=$FF, DDRB=$00
for col in 0..7:
  PRA = ~(1<<col)            ; one column low, others high
  rows = ~PRB & $7F/$FF      ; read active rows (0=pressed)
  record (col, rows)         ; map to keys
```

**Notes:**  

- Joystick **Port 1** shares PRB bits; pressed directions can alias key bits: e.g. Right = “2” key. Prefer **Port 2** for games.
- **Shift/Ctrl/Commodore** are matrix keys; handle modifiers in lookup.  
- KERNAL scan routine entry in ROM; custom code may be faster/leaner.

---

## 6. Joysticks, Lightpen, Paddles

- **Joysticks:** Digital switches, active‑low. **Port 1 → CIA1 PRB[0..4]**, **Port 2 → CIA1 PRA[0..4]** (see `cia-spec.md` mapping). Joystick‑keyboard contention exists on Port 1.
- **Lightpen:** Routed via VIC /LP; also appears as “fire” on CIA1. Use VIC registers for position latch. (Mapping note: see `cia-spec.md`.)
- **Paddles:** Analog via **SID POTX/POTY**; channel selection via **CIA1 PRA[6:7]** to choose control port.

---

## 7. User Port (Rear Edge Connector)

- **Logical:** **CIA2 PRB (PB0–PB7)** as general‑purpose digital I/O; configure with **DDRB**; read/write via **PRB**. KERNAL also provides RS‑232 routines mapping PB pins.
- **RS‑232:** TTL‑level via User Port; needs level shifting (e.g., MAX232). High‑speed bit‑bangers (e.g., UP9600) leverage CIA timing/interrupts.

---

## 8. Expansion Port (Cartridges/REU/Fastloaders)

- **Direct 6510 bus exposure:** A[15:0], D[7:0], R/W, Φ2, /IRQ, /NMI, /RESET, chip selects. Devices can map ROM/RAM/I/O and trap vectors. **No CIA mediation.**

---

## 9. VIC Bank Select (Memory Windows)

- **CIA2 PRA[1:0]:** **00=$C000–FFFF**, **01=$8000–BFFF**, **10=$4000–7FFF**, **11=$0000–3FFF (default)**. Controls VIC’s addressable 16 KiB bank. (Use with VIC memory pointers).

---

## 10. Recommended Access Patterns (Summary)

- **Prefer KERNAL** for disk/printer where compatibility matters; switch to custom IEC only for speed‑critical paths.
- **Keyboard:** CIA1 column‑by‑column scan; handle Port‑1 joystick aliasing.
- **Tape:** Control motor/write via $0001; measure **FLAG** edges via CIA1 ICR.
- **User Port:** Set DDRB and use PRB; add RS‑232 level shifting if interfacing to standard serial.
- **Expansion Port:** Memory‑mapped by cartridge; coordinate with bank switching and KERNAL vectors.

---

## 11. External References

- **CIA details:** `cia-spec.md` (this repo).  
- **Printers:** `data/printer/printer-spec.md` (this repo).  
- **KERNAL API (official lookup):** pagetable.com C64 KERNAL reference.
- **IEC protocol (electrical & byte‑level):** Derogee “IEC dissected”; pagetable Standard Serial overview; Wikipedia Commodore bus.
- **Keyboard matrix & scan masks:** C64 OS deep‑dive.
- **Datasette lines:** C64‑Wiki Cassette Port; Luigi Di Fraia on FLAG edge; 6510 port overview.
- **User Port/RS‑232:** C64‑Wiki Serial Port; pagetable UP9600.

# Printing with Commodore MPS and Epson FX

**Scope:** C64 → Printer via serial device **4**. Two protocols:

- **Commodore MPS** (PETSCII + MPS-801 control codes; the MPS-803 uses the same codes)
- **Epson FX (ESC/P)** (ASCII + ESC sequences; widely compatible)

**Defaults & Routing:** If user/printer is unspecified → **Commodore MPS**.  
See `printer-prompts.md` for routing logic and prompt templates.

---

## Quick Start — Text Output Examples

### Commodore BASIC

```basic
10 OPEN1,4,0 : REM Commodore MPS, PETSCII upper/graphics (sa=0)
20 PRINT#1,"HELLO"
30 REM PRINT# ALREADY ENDS THE LINE WITH CR
40 PRINT#1,CHR$(12)
50 CLOSE1
```

### Epson FX BASIC

```basic
10 OPEN1,4 : REM Epson FX (ESC/P), ASCII
20 PRINT#1,CHR$(27);"E";"BOLD ON";CHR$(27);"F"
30 PRINT#1,"HELLO"
40 PRINT#1,CHR$(12)
50 CLOSE1
```

---

## ✳️ Writing Assembly Code to Talk to the Printer

The C64 KERNAL provides complete device-independent I/O through standardized entry points.

### (A) Commodore BASIC Equivalent in Assembly

```asm
; Print "HELLO" to printer device #4 via KERNAL

    lda #1       ; Logical file number
    ldx #4       ; Device number (printer)
    ldy #0       ; Secondary address (0 = upper case/graphics)
    jsr $ffba    ; SETLFS: A = file, X = device, Y = secondary address

    lda #0       ; no file name
    jsr $ffbd    ; SETNAM: A = length, X/Y = name address low/high

    jsr $ffc0    ; OPEN
    ldx #1
    jsr $ffc9    ; CHKOUT: X = logical file number

    ldx #0
next:
    lda msg,x
    jsr $ffd2    ; CHROUT (send character)
    inx
    cpx #5
    bne next

    jsr $ffcc    ; CLRCHN (restore I/O)
    lda #1
    jsr $ffc3    ; CLOSE
    rts

msg: .text "HELLO"
```

### (B) Epson FX Version in Assembly

Same code as above, but `msg` should contain **ASCII** (not PETSCII) characters.  
For example, to print bold text before HELLO (set the `cpx` count to the new length, 9):

```asm
msg: .byte 27,"E",'H','E','L','L','O',27,"F"
```

### Relevant KERNAL API Calls

| Routine | Addr | Purpose |
|:--|:--|:--|
| **SETLFS** | `$FFBA` | Define Logical File, Device, Secondary Address |
| **SETNAM** | `$FFBD` | Define Filename/Command String |
| **OPEN** | `$FFC0` | Open logical file on device |
| **CHKOUT** | `$FFC9` | Select output channel |
| **CHROUT** | `$FFD2` | Send single character to output |
| **CLRCHN** | `$FFCC` | Restore default I/O devices |
| **CLOSE** | `$FFC3` | Close logical file |
| **READST** | `$FFB7` | Read status flags (I/O errors, device busy) |

---

## 🧩 Printer Command Cheat Sheet — Commodore & Epson (BASIC + Assembly)

| Operation | Commodore BASIC | Commodore Assembly (hex) | Epson FX BASIC | Epson FX Assembly (hex) |
|:--|:--|:--|:--|:--|
| **Reset / Init** | — | — | `ESC @` | `1B 40` |
| **Carriage Return** | `CHR$(13)` | `0D` | `CHR$(13)` | `0D` |
| **Line Feed** | `CHR$(10)` | `0A` | `CHR$(10)` | `0A` |
| **Form Feed / Page Eject** | `CHR$(12)` | `0C` | `CHR$(12)` | `0C` |
| **Horizontal Tab** | `CHR$(9)` | `09` | `CHR$(9)` | `09` |
| **Standard Width** | `CHR$(15)` | `0F` | `DC4` / `ESC W 0` | `14` / `1B 57 00` |
| **Double Width** | `CHR$(14)` | `0E` | `SO` / `ESC W 1` | `0E` / `1B 57 01` |
| **Elite (12 cpi)** | — | — | `ESC M` | `1B 4D` |
| **Condensed (17.16 cpi) ON / OFF** | — | — | `SI` / `DC2` | `0F` / `12` |
| **Pica (10 cpi)** | — | — | `ESC P` | `1B 50` |
| **Bold ON / OFF** | — | — | `ESC E` / `ESC F` | `1B 45` / `1B 46` |
| **Italic ON / OFF** | — | — | `ESC 4` / `ESC 5` | `1B 34` / `1B 35` |
| **Underline ON / OFF** | — | — | `ESC - 1` / `ESC - 0` | `1B 2D 01` / `1B 2D 00` |
| **Reverse Video ON / OFF** | `CHR$(18)` / `CHR$(146)` | `12` / `92` | — | — |
| **Set Line Spacing (n×1/72")** | — | — | `ESC A n` | `1B 41 nn` |
| **Set Left Margin** | — | — | `ESC l n` | `1B 6C nn` |
| **Set Right Margin** | — | — | `ESC Q n` | `1B 51 nn` |
| **Horizontal Position (col)** | `CHR$(16);"nn"` (2 digits) | `10 3x 3y` | — (FX-80 has no absolute position) | — |
| **Horizontal Position (dots)** | `CHR$(27);CHR$(16);CHR$(HP);CHR$(LP)` | `1B 10 HP LP` | — | — |
| **Enter Bit Image Mode** | `CHR$(8)` | `08` | `ESC K/L/Y/Z/*/^ n m ...` | `1B 4B/4C/59/5A/2A/5E nn mm ...` |
| **Repeat Next Data Byte (MPS only)** | `CHR$(26);CHR$(n);CHR$(byte)` | `1A nn dd` | — | — |
| **Exit Bit Image Mode** | `CHR$(15)` | `0F` | ends after `n + 256·m` columns | — |
| **Graphics Data Format** | 7 bits/byte (**bit7=1**) | — | 8 bits/byte (MSB=top) | — |
| **Vertical Line Spacing (graphics rows)** | CR (bit image lines are 7 dots apart) | `0D` | `ESC A 8` | `1B 41 08` |
| **Switch Charset** | `sa=0` or `7` | — | `ESC R n` (international set) | `1B 52 nn` |
| **Reset / End Job** | `CLOSE ch` | — | `ESC @` + `FF` + `CLOSE ch` | `1B 40 0C` |

---

**Notes**

- Always `OPEN ch,4[,sa]` → `PRINT#` → `CLOSE ch`.  
- Add `CHR$(12)` (Form Feed) before closing to eject the page.  
- For MPS bitmap output, add **128** to each data byte (bit7=1).  
- For Epson, compute `(n + 256·m)` bytes per graphics line.  
- `$033C–$03FB` (cassette buffer) can store small print buffers.

**Cross‑refs:**  
[`printer-commodore.md`](printer-commodore.md) · [`printer-commodore-bitmap.md`](printer-commodore-bitmap.md) · [`printer-epson.md`](printer-epson.md) · [`printer-epson-bitmap.md`](printer-epson-bitmap.md) · [`printer-prompts.md`](printer-prompts.md)

---

## Protocol Differences (critical)

- **Character set:** MPS expects **PETSCII**; Epson expects **ASCII** with ESC/P sequences.  
- **Mode switching:** MPS uses single-byte PETSCII controls; Epson uses multi-byte ESC (27) commands.  
- **Graphics:** MPS Bit Image = 7-dot columns (bit7=1); Epson = 8-dot columns `(n,m)` pairs.  
- **Line endings:** MPS: one CR (13) or LF (10) ends the line and advances (`PRINT#` sends CR itself); CR+LF gives an empty line on the Ultimate emulation. Epson: CR + LF (FX-80 DIP switch 2-4 can add the line feed automatically). FF (12) for page eject.

---

## Commodore MPS Essentials (Text)

- **Open:** `OPEN ch,4[,sa]` (`sa=0` upper/graphics, `7` lower/upper).  
- **Print:** `PRINT#ch,…` or `CMD ch`.  
- **Close:** `CLOSE ch`.  
- **Bit Image:** Enter `CHR$(8)`; repeat `CHR$(26);count;byte`; exit `CHR$(15)`.

---

## Epson FX Essentials (Text)

- **Pitch:** `ESC M` (12 cpi), `ESC P` (10 cpi). **Bold:** `ESC E`/`ESC F`.  
- **Underline:** `ESC - n`. **Spacing:** `ESC A n`. **Reset:** `ESC @`.

---

## Graphics Summary

- **MPS:** 7 dots/byte; bit7=1; 60 dpi horizontal, about 63 dpi vertical; at most 480 columns.  
- **Epson:** 8 dots/byte; multiple densities via `ESC K/L/Y/Z/*/^`; use `ESC A 8` for 8-dot rows.

---

## Emulation Notes

- **Ultimate printer emulation** (an MPS-1230): the printer setting selects Commodore MPS (default), Epson FX-80, IBM Graphics Printer or IBM Proprinter; it does not detect the protocol.  
  Commodore mode parses and ignores downloadable characters (`ESC =`); `ESC Y` uses the same spacing as `ESC L`. Send FF (12) or use "Flush Printer/Eject Page" to finish a page (256-byte buffer).

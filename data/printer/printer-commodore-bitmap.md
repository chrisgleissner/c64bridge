# Commodore MPS — Bitmap Images (Bit Image Mode)

**Enter:** `CHR$(8)`  | **Exit:** `CHR$(15)` (MPS-801 manual; the Ultimate emulation also leaves on any printable character below 128)  
**Data model:** 1 byte per **column**, **7 active bits** (LSB=top). **Set bit7=1** (add 128) so data prints. 60 dpi H (480 columns per 8" line), about 63 dpi V (7 dots per 1/9" line feed). At most 480 columns.

## Commands

| Action | Bytes to send | Notes |
|:--|:--|:--|
| Enter Bit Image | `CHR$(8)` | Subsequent bytes are columns |
| Repeat next data byte | `CHR$(26);CHR$(n);CHR$(byte)` | Repeats `byte` **n** times (Ultimate: `n` = 0 means 256) |
| Position by dots | `CHR$(27);CHR$(16);HP;LP` | Absolute dot column 0–479 |
| Exit Bit Image | `CHR$(15)` | Or send a printable character |

## Minimal pattern example

```basic
10 OPEN1,4
20 A$="":FOR I=1 TO 16:READ B:A$=A$+CHR$(B):NEXT
30 PRINT#1,CHR$(8);A$;A$;A$; : REM 48 COLUMNS IN ONE ROW
40 PRINT#1,CHR$(15); : PRINT#1,CHR$(12):CLOSE1
50 DATA 136,148,162,193,162,148,136,136,156,186,255,186,156,136,235,136
```

**Tips**

- Pre-add **128** to each data byte (bit7=1) before sending.
- For vertical tiling, reprint the same columns with one CR between rows (in bit image mode a line advances 7 dots).
- Keep a row within 480 columns (what happens beyond that is unverified).

**Cross‑ref:** Basic text controls in `printer-commodore.md`; overview in `printer-spec.md`.

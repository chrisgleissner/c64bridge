# Epson FX-80 (ESC/P) — Bitmap Graphics

**Data model:** 1 byte per **column**, **8 dots** (MSB=top). Send graphics command + **byte count** `(n + 256*m)` then data. Set line spacing for 8‑dot rows, e.g., `ESC A 8`.

## Graphics commands

| Mode | Sequence | Density (H) |
|:--|:--|:--|
| Normal | `ESC K n m ...data...` | ~60 dpi |
| Double | `ESC L n m ...` | ~120 dpi |
| Double (hi‑speed)* | `ESC Y n m ...` | 120 dpi, no two adjacent dots in a row |
| Quadruple | `ESC Z n m ...` | 240 dpi, no two adjacent dots in a row |
| Explicit | `ESC * d n m ...` | `d`=0:60,1:120,2:120(hi),3:240,4:80,5:72,6:90 dpi |
| 9‑pin strips | `ESC ^ d n m b1 b2 ...` | `d` 0 single, 1 double density; 2 bytes per column: `b1` top 8 pins, bit 7 of `b2` the 9th pin |

\* The Ultimate emulation draws `Y` with the same 120‑dpi spacing as `L`. Always match `n,m` to **exact** data length (`n + 256*m` columns).

### Minimal example

```basic
10 OPEN1,4
20 A$=CHR$(27)+"K"+CHR$(16)+CHR$(0)
30 FOR I=1 TO 16:READ B:A$=A$+CHR$(B):NEXT
40 PRINT#1,CHR$(27);"A";CHR$(8) : REM 8/72"
50 PRINT#1,A$;A$;A$; : PRINT#1,CHR$(12):CLOSE1
60 DATA 60,66,129,129,129,66,60,24,60,126,255,126,60,24,235,24
```

**Cross‑ref:** Text controls `printer-epson.md`; overview `printer-spec.md`.

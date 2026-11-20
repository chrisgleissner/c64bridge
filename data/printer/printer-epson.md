# Epson FX-80 (ESC/P) — Text Controls

**Protocol:** ASCII with ESC sequences (`ESC` = `CHR$(27)`).

## Controls (concise)

| Feature | ESC/P sequence | Notes |
|:--|:--|:--|
| Reset | `ESC @` | Clear modes between jobs |
| Pitch | `ESC M` (12 cpi), `ESC P` (10 cpi) | |
| Width | `SO` (`CHR$(14)`) on / `DC4` (`CHR$(20)`) off, or `ESC W n` | `SO` ends with the line; `ESC W 1` stays until `ESC W 0` |
| Condensed | `SI` (`CHR$(15)`) on / `DC2` (`CHR$(18)`) off | |
| Bold | `ESC E` on / `ESC F` off | |
| Italic | `ESC 4` on / `ESC 5` off | |
| Underline | `ESC - n` | `n=1` on, `0` off |
| Quality | `ESC x n` | `n=1` NLQ, `0` Draft; not on the FX-80, accepted by the Ultimate emulation |
| Line spacing | `ESC 0/1/2`, `ESC 3 n`, `ESC A n` | `n` in 1/216" or 1/72" |
| Tabs/margins | `ESC D` (HT), `ESC B` (VT), `ESC l` (left), `ESC Q` (right) | |
| Paper | `LF=10`, `CR=13`, `FF=12`, `ESC J n` (fwd n/216"), `ESC j n` (rev n/216") | |

### Example

```basic
10 OPEN1,4
20 PRINT#1,CHR$(27);"@";CHR$(27);"x";CHR$(1);CHR$(27);"M"
30 PRINT#1,CHR$(27);"-";CHR$(1);"UNDER";CHR$(27);"-";CHR$(0)
40 PRINT#1,CHR$(12):CLOSE1
```

**Cross‑ref:** Bitmap (`printer-epson-bitmap.md`); overview & routing (`printer-spec.md`).

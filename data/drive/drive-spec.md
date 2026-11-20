# Commodore Disk Drives — 1541, 1571, 1581

**Scope:** Commodore floppy drives used with the C64/C128 via the IEC serial bus.  
Each drive contains an internal 6502 CPU and DOS ROM implementing a self‑contained filesystem.  
Main reference drive: **1541 (DOS 2.6)**; extensions for **1571 (DOS 3.0)** and **1581 (DOS 10.0)** below.

---

## 1541 — Disk Format and DOS 2.6

**Medium:** 5¼″ single‑sided DD, 35 tracks (17–21 sectors per track).  
**Capacity:** 174 848 B (683 × 256 B); 664 free (169 984 B).  
**Directory:** Track 18 Sectors 1–18; BAM = Track 18 Sector 0.  
**Max files:** 144 (no subdirs). **DOS:** v2.6.

### File Types

| Type | Description | Max Size | Notes |
|:--|:--|:--|:--|
| **PRG** | Program (LOAD/SAVE) | ~202 blocks | Loadable code |
| **SEQ** | Sequential file | 168 656 B | Text/data |
| **USR** | User file | ≈SEQ | App‑defined |
| **REL** | Relative file | 167 132 B / 65 535 records | Random access |
| **DEL** | Deleted entry | — | Hidden or invalid |

Flags: `<` = locked (read‑only); `*` = not closed (use VALIDATE).

### Track Layout (256‑B sectors)

| Tracks | Sectors/Track | Total Sectors |
|:--|:--|:--|
| 1–17 | 21 | 357 |
| 18 | 19 (Dir/BAM) | 19 |
| 19–24 | 18 | 108 |
| 25–35 | 17 | 187 |
| **Total** |  | **683** |

Tracks 40–41 exist physically but unused by DOS 2.6.

### BAM (Track 18 Sector 0)

| Bytes | Purpose |
|:--|:--|
| $00–$01 | First directory T/S (18/1) |
| $02 | DOS version type `$41` ("A") |
| $04–$8F | 4 bytes per track (free count + 3-byte bitmap) |
| $90–$9F | Disk name (16 B PETSCII, `$A0`-padded) |
| $A2–$A3 | Disk ID |
| $A5–$A6 | DOS type "2A" |

### Directory Entries (32 B each)

| Offset | Field | Size | Notes |
|:--|:--|:--|:--|
| $00–$01 | Next directory T/S | 2 | only in the first entry of a sector |
| $02 | File type | 1 | bit 7=closed, bit 6=locked, bits 0-3=file type |
| $03–$04 | Start T/S | 2 | first block |
| $05–$14 | File name | 16 | PETSCII, `$A0`-padded |
| $1E–$1F | Blocks used | 2 | file size in blocks, low/high |

### DOS 2.6 Commands (via channel 15)

| Action | Command | Example |
|:--|:--|:--|
| Format disk | `N0:name,ID` | `OPEN15,8,15,"N0:DISK,01"` |
| Validate | `V0` | `PRINT#15,"V0"` |
| Initialize | `I0` | `PRINT#15,"I0"` |
| Reset | `UI0` | `PRINT#15,"UI0"` |
| Copy file | `C0:new=old` | `PRINT#15,"C0:NEW=OLD"` |
| Rename | `R0:new=old` | `PRINT#15,"R0:NEW=OLD"` |
| Delete | `S0:mask` | `PRINT#15,"S0:*"` |
| Concatenate | `C0:new=a,b` | `PRINT#15,"C0:MERGE=A,B"` |
| Replace (file overwrite) | `@0:name` | `SAVE"@0:FILE",8` ⚠ bug on 1541‑I |
| Memory write | `M-W addrL addrH size data` | Direct RAM write |
| Position (REL) | `P ch recL recH pos` | Record seek |

---

## Programming Interface (BASIC & Assembly)

The following applies to all drives.

### Relevant BASIC / KERNAL APIs

| Operation | BASIC Keyword | KERNAL Routine | Addr (hex) | Notes |
|---|---|---|---|---|
| Open channel | `OPEN` | `SETLFS` / `SETNAM` / `OPEN` | $FFBA / $FFBD / $FFC0 | Set device, secondary, file name |
| Print data | `PRINT#` | `CHKOUT` / `CHROUT` | $FFC9 / $FFD2 | Write bytes to drive |
| Read data | `GET#`, `INPUT#` | `CHKIN` / `CHRIN` | $FFC6 / $FFCF | Read bytes |
| Close file | `CLOSE` | `CLOSE` / `CLRCHN` | $FFC3 / $FFCC | Release channel |
| Load file | `LOAD` | `LOAD` | $FFD5 | Load PRG from disk |
| Save file | `SAVE` | `SAVE` | $FFD8 | Write PRG to disk |
| Read status | `PRINT STATUS` | `READST` | $FFB7 | Check error/status flags |

---

### BASIC Examples

```basic
REM --- PRINT DIRECTORY ---
LOAD"$",8:LIST

REM --- LOAD FILE ---
LOAD"HELLO.PRG",8,1

REM --- SAVE FILE ---
SAVE"HELLO.PRG",8
```

---

### Assembly Examples

#### Print Directory

```asm
    lda #<dir
    ldx #>dir
    ldy #len
    jsr $ffbd   ; SETNAM
    lda #1      ; logical
    ldx #8      ; device
    ldy #0      ; secondary
    jsr $ffba   ; SETLFS
    jsr $ffd5   ; LOAD (LOAD"$",8)
dir: .text "$"
len = *-dir
```

#### Load File

```asm
    lda #<name
    ldx #>name
    ldy #len
    jsr $ffbd
    lda #0      ; LFN=0
    ldx #8      ; device
    ldy #1      ; SA=1
    jsr $ffba
    lda #0
    jsr $ffd5   ; LOAD (A=0=load)
name: .text "HELLO.PRG"
len = *-name
```

#### Save File

```asm
    lda #<name
    ldx #>name
    ldy #len
    jsr $ffbd
    lda #0
    ldx #8
    ldy #1
    jsr $ffba
    lda #0
    jsr $ffd8   ; SAVE
name: .text "HELLO.PRG"
len = *-name
```

---

## 1571 — Double‑Sided Drive (DOS 3.0)

**Medium:** 5¼″ double‑sided DD, 70 tracks (35 × 2).  
**Capacity:** ~349 KB (1368 blocks). **DOS:** 3.0.  
Reads/writes 1541 disks (side A only); auto‑flips heads; supports burst mode with C128.

### Key Differences

- Dual BAMs (one per side, merged view).  
- Identical file types and commands to 1541.  
- Burst protocol ≈ 2× speed vs 1541.  
- Optional MFM mode for CP/M.  

**Geometry:** Same sector zones per side as 1541.  

---

## 1581 — 3½″ Drive (DOS 10.0)

**Medium:** 3½″ DS/DD. Logical format: 80 tracks × 40 sectors × 256 B = 3200 blocks.  
**Capacity:** 819 200 B; 3160 blocks free on a new disk.  
Supports partitions; a partition that meets the size rules can be used as a sub-directory. Compatible with C64 and C128 via IEC. I/O ≈ 4× 1541 speed.

### Command Summary

| Action | Command | Example |
|---|---|---|
| Format disk | `N0:NAME,ID` | `OPEN15,8,15,"N0:WORK,01"` |
| Create partition | `/0:NAME,`+track+sector+blocks lo+blocks hi+`,C` | `PRINT#15,"/0:DATA,"+CHR$(41)+CHR$(0)+CHR$(120)+CHR$(0)+",C"` |
| Select partition | `/0:NAME` | `PRINT#15,"/0:DATA"` |
| Back to root | `/` | `PRINT#15,"/"` |
| Delete file/dir | `S0:NAME` | `PRINT#15,"S0:OLD"` |
| Validate | `V0` | `PRINT#15,"V0"` |

### Notes

- The 1581 has no `MD`/`CD` commands. A sub-directory is a partition of at least 120 sectors that starts at sector 0, ends on a multiple of 40 sectors and does not contain track 40; select it with `/0:NAME`, then format it with `N`.  
- Only one level is selected per command; return to the root with `/`. Sub-directory file and BAM information is stored inside the partition.  
- Geometry: logical 80 × 40 × 256 B = 819 200 B (physically 80 tracks × 2 sides × 10 × 512 B).

---

## Drive Comparison Summary

| Drive | DOS | Sides | Tracks | Sectors/Track | Capacity (bytes) | Notes |
|:--|:--|:--|:--|:--|:--|:--|
| **1541** | 2.6 | 1 | 35 | 17–21 | 174 848 (664 free blocks) | Standard C64 drive |
| **1571** | 3.0 | 2 | 70 | 17–21 per side | 349 696 | Burst mode, dual BAM |
| **1581** | 10.0 | 2 (3½″) | 80 | 40 × 256 B (logical) | 819 200 (3160 free blocks) | Partitions, sub-directories |

---

**Cross‑Refs:** [`io/cia-spec.md`](../io/cia-spec.md) · [`printer/printer-spec.md`](../printer/printer-spec.md)

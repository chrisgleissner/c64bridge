# REU (RAM Expansion Unit) on Ultimate Devices

**Summary:** Ultimate devices emulate a 1750-compatible REU (128 KB to 16 MB) in SDRAM, registers at `$DF00-$DF0A`. DMA stalls the CPU, REU contents survive C64 resets, and the REU is disabled by default. No REST endpoint writes REU memory: data gets in through boot-time preload, UCI LOAD_REU from game code, or a stash stub. Games use it for level data, charset/sprite/bitmap streaming and sample storage.
**Read when:** storing or streaming game data via the REU, writing DMA routines, or deciding how to load an REU image.

Marks: "(unverified)" = inferred or single secondary source. Related: c64://ultimate/uci (LOAD_REU commands), c64://ultimate/hardware (turbo, `$DE00-$DFFF` map), c64://memory/map, c64://io/spec.

## Configuration

Category "C64 and Cartridge Settings" (set with `c64_config`; changing it re-initialises the cartridge, a reset follows):

| Item | Values | Default |
|---|---|---|
| `RAM Expansion Unit` | Disabled, Enabled, GeoRAM Mode (mutually exclusive with REU) | Disabled |
| `REU Size` | 128 KB, 256 KB, 512 KB, 1 MB, 2 MB, 4 MB, 8 MB, 16 MB | 2 MB |
| `REU Preload` | Disabled, Enabled | Disabled |
| `REU Preload Image` | path, max 31 characters | `/Usb0/preload.reu` |
| `REU Preload Offset` | 0 KB, 128 KB ... 16 MB | 0 KB |

- An active REU disables cartridges that use `$DF00-$DFFF` (EasyFlash, Final Cartridge III).
- Reads beyond the configured size wrap and return plausible wrong data. Check the size at startup; a program should refuse to start with a text message naming the setting if the REU is missing or too small.
- REU contents survive C64 reset, `machine:reset` and `run_prg`; assume they are lost at power off.

## Registers (`$DF00-$DF0A`)

| Addr | Name | Meaning |
|---|---|---|
| `$DF00` | Status (R) | b7 IRQ pending, b6 END OF BLOCK, b5 FAULT (verify mismatch), b4 size >= 256 KB (not a size probe), b3-0 version. **Reading clears b6, b5 and the IRQ**: read once, keep a copy. |
| `$DF01` | Command | b7 EXECUTE, b5 AUTOLOAD, b4 FF00 (1 = run at once, 0 = wait for a write to `$FF00`), b1-0 type: 00 stash (C64 to REU), 01 fetch (REU to C64), 10 swap, 11 verify |
| `$DF02/03` | C64 address lo/hi | reads return the advancing address |
| `$DF04/05/06` | REU address lo/mid/bank | bank = 64 KB units |
| `$DF07/08` | Length lo/hi | 0 = 65536 bytes; reads return remaining count |
| `$DF09` | IRQ mask | b7 enable, b6 on END OF BLOCK, b5 on FAULT |
| `$DF0A` | Address control | b7 fix C64 address, b6 fix REU address (not cleared by transfers) |

Command bytes: `$90` stash, `$91` fetch, `$92` swap, `$93` verify (execute, immediate, no autoload); `$B0-$B3` same with autoload; `$80-$83` wait for `$FF00` write.
- Without autoload, after a transfer both base addresses point past the last byte and length reads 1: consecutive blocks can continue without rewriting REU address, but length and C64 address must be set again as needed. With autoload the base values are restored (repeat the same transfer with only `$DF01`).
- Swap: both memories read, then both written. Verify: stops at first mismatch, FAULT set, END OF BLOCK not set; the address registers point at the mismatching byte on Ultimate devices (real REUs differ). Clear FAULT first by reading `$DF00`.
- C64 address wraps at `$FFFF`. `$DF0A = $80` (fix C64 address): a fetch writes every REU byte to one location, at DMA speed (too fast to play samples). `$40` (fix REU address): a fetch fills memory with one byte.
- Write all bytes of a base-address pair before executing.
- Extended registers on some FPGA builds (existence on U64/C64U cores unverified): `$DF0C` size mask (`$01` 128 KB ... `$FF` 16 MB), `$DF0D` start delay, `$DF0E` rate divider, `$DF0F` length bits 23-16 (write-only, allows over 64 KB per transfer). Probe `$DF0C` before use; do not depend on it.
- `$DF1B-$DF1F` are UCI (the REU logic aliases `$DF10-$DF1F`): use only `$DF00-$DF0A`.

## Timing, stall, size, wrap

- The CPU is halted for the whole transfer (no wait loop needed; the status is valid on the next instruction). A raster/CIA IRQ falling inside it fires late. Menu freeze pauses a running transfer.
- Standard rate: one byte per phi2, plus VIC badline and sprite stealing; swap is half speed (unverified here). Plan with 1 byte per phi2 (about 1 microsecond) unless you measure.
- Conflicting measurements on a C64U: one project reports exactly 1 byte per microsecond regardless of CPU speed; another measured faster (fetch about 0.23 phi2 per byte, stash about 0.13, about 13 phi2 fixed: 256 bytes fetch 72 phi2, 4096 bytes about 955, 49152 bytes about 12,400). Cause unknown (VIC state or firmware/core). Measure with a CIA timer on the target; use the slow figure for budgets.
- DMA time does not scale with CPU turbo. Do not DMA-fill when the CPU can store faster (unverified at 64 MHz).
- **512 KB wrap:** on builds without the extended registers, and in VICE, a transfer that crosses a 512 KB boundary (REU address multiple of `$080000`) wraps inside that block. Rule: split every DMA so `(addr & $07FFFF) + len <= $080000`; guard length 0 (it means 64 KB). Extended builds mask the address to the configured size instead.
- **Size detection** (no UCI command reports it): fetch the byte at REU offset 0, stash back `a^$A5`, fetch again (no REU if it does not hold; restore it). Then for s = 64 KB, 128 KB, ... 8 MB: save bytes at 0 and s, write distinct values at 0 (`a^$A5`) and s (`a^$5A`); if offset 0 now holds the second value the REU aliases at s, so size = s. Restore bytes afterwards. No wrap up to 8 MB means 16 MB. At most eight tiny DMAs. Also verify a magic header and block checksums after loading: a missing or stale REU returns valid-looking stale data without error.
- **`$FF00` trigger** (b4 = 0): set the command, change `$01` (e.g. to `$34` for RAM under I/O), then store to `$FF00`. Whether this reaches RAM under I/O on the C64U is unverified; the safe route is DMA into a normal-RAM bounce buffer then CPU copy. DMA writes to colour RAM (`$D800`) need I/O visible.
- Turbo: starting a transfer must halt the CPU in the same cycle as the `$DF01` write. Firmware before 2026-08-28 could run instructions after the command write while DMA was in flight on U64-class cores. Put no instruction after `sta $DF01` that depends on the transfer or on stable REU registers, add `nop nop`, and disable interrupts from first register write to the trigger.

## Routine (ca65 syntax, fresh example)

```
REU_STAT = $DF00
REU_CMD  = $DF01
REU_C64  = $DF02        ; lo, hi
REU_ADDR = $DF04        ; lo, mid, bank
REU_LEN  = $DF07        ; lo, hi
REU_IRQM = $DF09
REU_CTRL = $DF0A
; zp: c64p (2), reup (3), lenp (2), cmd (1)
reu_do:
        php
        sei
        lda c64p
        sta REU_C64
        lda c64p+1
        sta REU_C64+1
        lda reup
        sta REU_ADDR
        lda reup+1
        sta REU_ADDR+1
        lda reup+2
        sta REU_ADDR+2
        lda lenp
        sta REU_LEN
        lda lenp+1
        sta REU_LEN+1
        lda #0
        sta REU_IRQM
        sta REU_CTRL
        lda cmd                 ; $90 stash, $91 fetch, $92 swap, $93 verify
        sta REU_CMD             ; MUST be the last register write
        nop
        nop
        plp
        rts
```
- In C compilers (Oscar64 reordered stores to constant I/O addresses once) write the register sequence as one inline-assembly block, and re-read the first byte of a fetched buffer through a volatile pointer.

## Getting data into the REU

| Path | Works from host? | Notes |
|---|---|---|
| UCI DOS LOAD_REU (`01 21`, open file first) | by a running program | recommended for shipped games; file to REU without the C64; chunk at 32 KB or less; see c64://ultimate/uci |
| Menu: file browser, `.reu` file, load into REU | no (menu) | whole file to offset 0 |
| `REU Preload` (config) | partly | **boot only** (see below) |
| Stash stub + `machine:writemem` | yes | slow but scriptable |
| `runners:modplay` (PUT file / POST body) | yes | loads a MOD into REU offset 0 and plays it; overwrites the REU; needs the sampler |
| UCI control LOAD_REU `04 08` | avoid | wedged the interface on firmware 3.14d |

- There is no REST endpoint that writes REU memory. `machine:writemem`/`readmem` cover only C64 `$0000-$FFFF` (DMA on the cartridge bus, CPU stalls briefly).
- **Preload runs once at firmware boot.** It starts only if `REU Preload` is already enabled at boot and the image file appears (volume mounted), waits about 125 ms (25 ticks at 200 Hz), loads `min(file size, REU size - offset)` bytes, then never runs again. `machine:reset`, C64 reboot and `run_prg` do not reload it; setting it by REST after boot does not arm it; a power cycle or menu reboot does. The image need not equal the REU size (VICE `-reuimage` does require exactly that size).
- **Stash stub pattern:** a small resident PRG with a mailbox (REU address, C64 address, length, command, trigger byte written last). The host writes a 16 KB chunk to C64 RAM with `machine:writemem`, fills the mailbox, trigger last; the stub stashes it and clears the trigger; the host polls the trigger, then verifies by fetching back. Do not send a "terminate" command after every chunk (an early stub hung and ignored later chunks). Hash chunks to skip unchanged ones (REU survives resets). Verify the whole used region.
- `.reu` files are raw REU dumps without header. "Save REU Memory" writes the configured size. LOAD_REU/SAVE_REU assume 16 MB.
- Image layout: header (magic, version, block table of id/flags/24-bit offset/length), per-block checksums checked at boot.

## Patterns for games

- **Level/map streaming:** keep tile maps in the REU page-aligned; once per frame, after the raster IRQ passed the visible area, fetch one 256-byte column or row into an off-screen buffer. Measured on a C64U at 64 MHz: one 256-byte fetch per frame for 500 frames, no glitches.
- **Charset/sprite swap into a VIC bank** between frames: fetch the new 2 KB charset or sprite blocks into the inactive part of the VIC bank, then flip `$D018`/`$DD00` in the next IRQ. Fetching 2 KB costs about 2,000 phi2 at the conservative rate.
- **Bitmap/screen swap:** 8000 + 1000 + 1000 bytes is about 10,000 phi2 (half a PAL frame at the slow rate): start after the bottom IRQ, flip in the next top IRQ, or hide it under a fade. Colour RAM needs I/O visible.
- **Overlays:** keep rarely used code/data in the REU, copy to a RAM window via a bounce buffer, checksum on load.
- **Digi samples (design, unverified):** 4-bit samples in the REU, a 256-byte ring in RAM, a CIA timer IRQ writing one byte to `$D418` per tick (about 8 kHz), and a 64-byte fetch each time 64 samples were consumed (shorter than the 123-cycle period). Wrap REU access in `sei` or let the IRQ own the REU. `$D418` bits 4-7 are filter/voice-3 bits: write the whole value. Alternative: the Ultimate Audio sampler (`$DF20-$DFFF`, config `Map Ultimate Audio $DF20-DFFF`) plays from REU memory without the CPU (layout not verified here).
- A raster IRQ and the main loop must not both program the REU: one owner, or `sei`/`cli` around main-loop use.

## Pitfalls

1. REU disabled by default; size default 2 MB.
2. Stale or absent REU looks like valid data: magic, version, checksum at boot.
3. Preload is boot-only; use LOAD_REU or a stub for reproducible loads.
4. Command register last; no compiler reordering.
5. Split DMAs at 512 KB boundaries; length 0 means 64 KB.
6. Autoload restores base values, so use no-autoload for streaming consecutive blocks.
7. `$DF0A` fix bits persist: clear them after use.
8. `$FF00` mode leaves a pending command until `$FF00` is written; a stray store starts it.
9. Reading `$DF00` clears flags and IRQ; enabling the REU IRQ requires reading it in the handler.
10. VICE charges DMA at about 1 cycle per byte (3.10, measured); Ultimate rates differ: test streaming budgets on hardware.
11. GeoRAM mode replaces the REU (window `$DE00`, banks `$DFFE/$DFFF`; layout unverified).

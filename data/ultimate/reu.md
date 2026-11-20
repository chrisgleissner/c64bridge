# REU (RAM Expansion Unit) on Ultimate Devices

**Summary:** Ultimate devices emulate a 1750-compatible REU (128 KB to 16 MB) in SDRAM, registers at `$DF00-$DF0A`. DMA stalls the CPU, REU contents survive C64 resets, and the REU is disabled by default. No REST endpoint writes REU memory: data gets in through boot-time preload, UCI LOAD_REU from game code (DOS `21`, or Control `04 08` for the configured preload image), or a stash stub. Games use it for level data, charset/sprite/bitmap streaming and sample storage.
**Read when:** storing or streaming game data via the REU, writing DMA routines, or deciding how to load an REU image.

Sources: REU gateware `fpga/cart_slot/vhdl_source/reu.vhd` and firmware of GideonZ/1541ultimate master 700c7f2fa (2026-11-13); the U64-family top level that instantiates `reu.vhd` is not public. "Measured" = benchmark of 2026-11-13 on Ultimate 64 Elite firmware 3.15a and C64 Ultimate firmware 1.2.1 (c64://ultimate/bench), or "measured U64" = Ultimate 64 Elite, firmware 3.15a, 2026-11-20. Related: c64://ultimate/uci (LOAD_REU commands), c64://ultimate/hardware (turbo, `$DE00-$DFFF` map), c64://memory/map, c64://io/spec.

## Configuration

Category "C64 and Cartridge Settings" (`software/io/c64/c64.cc:60-61,91-96`; set with `c64_config` before the program starts):

| Item | Values | Default |
|---|---|---|
| `RAM Expansion Unit` | Disabled, Enabled, GeoRAM Mode (mutually exclusive with REU) | Disabled |
| `REU Size` | 128 KB, 256 KB, 512 KB, 1 MB, 2 MB, 4 MB, 8 MB, 16 MB | 2 MB |
| `REU Preload` | Disabled, Enabled | Disabled |
| `REU Preload Image` | path, max 31 characters | `/Usb0/preload.reu` |
| `REU Preload Offset` | 0 KB, 128 KB ... 16 MB | 0 KB |

- A loaded `.crt` switches the REU off unless its type allows it: EasyFlash subtype 1, C128 std-IO subtypes 1 and 2 and Final Cartridge III subtype 1 keep it; EasyFlash other subtypes and every `PROHIBIT_DFXX`/`PROHIBIT_IO` type switch it off (table in c64://ultimate/hardware, I/O area).
- REU addresses wrap at the configured size: the address bits above `REU Size` are masked (`reu.vhd:127-140`), so a read past the end returns data from the start. A program measures the size at startup and, if the REU is missing or too small, prints a message naming `RAM Expansion Unit` and `REU Size` instead of starting.
- REU contents survive a C64 reset, `machine:reset` and `run_prg`, and are lost at power-off (SDRAM).

## Registers (`$DF00-$DF0A`)

| Addr | Name | Meaning |
|---|---|---|
| `$DF00` | Status (R) | b7 IRQ pending, b6 END OF BLOCK, b5 FAULT (verify mismatch), b4 = 1 when `REU Size` >= 256 KB (not a size probe), b3-0 version `0`. **Reading clears b6, b5 and the IRQ**: read once, keep a copy. |
| `$DF01` | Command | b7 EXECUTE, b5 AUTOLOAD, b4 FF00 (1 = run at once, 0 = wait for a write to `$FF00`), b1-0 type: 00 stash (C64 to REU), 01 fetch (REU to C64), 10 swap, 11 verify |
| `$DF02/03` | C64 address lo/hi | reads return the advancing address |
| `$DF04/05/06` | REU address lo/mid/bank | bank = 64 KB units; without the extended registers `$DF06` reads bits 7-3 as 1 (`reu.vhd:461-465`) |
| `$DF07/08` | Length lo/hi | 0 = 65536 bytes; reads return remaining count |
| `$DF09` | IRQ mask | b7 enable, b6 on END OF BLOCK, b5 on FAULT |
| `$DF0A` | Address control | b7 fix C64 address, b6 fix REU address (not cleared by transfers) |

Command bytes: `$90` stash, `$91` fetch, `$92` swap, `$93` verify (execute, immediate, no autoload); `$B0-$B3` same with autoload; `$80-$83` wait for `$FF00` write.
- Without autoload, after a transfer both base addresses point past the last byte and length reads 1: consecutive blocks can continue without rewriting REU address, but length and C64 address must be set again as needed. With autoload the base values are restored (repeat the same transfer with only `$DF01`).
- Swap: both memories read, then both written. Verify: stops at first mismatch, FAULT set, END OF BLOCK not set; the address registers point at the mismatching byte on Ultimate devices (real REUs differ). Clear FAULT first by reading `$DF00`.
- C64 address wraps at `$FFFF`. `$DF0A = $80` (fix C64 address): a fetch writes every REU byte to one location, at DMA speed (too fast to play samples). `$40` (fix REU address): a fetch fills memory with one byte.
- Extended registers exist only in FPGA builds with `g_extended => true`: `$DF0C` size mask (read; `$01` 128 KB ... `$FF` 16 MB), `$DF0D` start delay (R/W), `$DF0E` rate divider (R/W), `$DF0F` length bits 23-16 (write-only, allows more than 64 KB per transfer) (`reu.vhd:253-266,469-471`). Every public U2-family top level sets `g_extended_reu => false`. Measured U64 (core 1.50): `$DF0C-$DF0F` read `$FF` at 128 KB and at 16 MB, and a `$05` written to `$DF0D` is not kept (CPU and DMA). A program does not use them; the C64 Ultimate is listed under Not verified.
- The REU answers reads at `$DF00-$DF17`; `$DF0B` and `$DF10-$DF17` read `$FF` (`reu.vhd:429-487`). `$DF18-$DF1F` belong to UCI. Use only `$DF00-$DF0A`.

## Timing, stall, size, wrap

- The CPU is halted for the whole transfer (no wait loop needed; the status is valid on the next instruction). A raster/CIA IRQ falling inside it fires late. Menu freeze pauses a running transfer.
- Measured 2026-11-13 on Ultimate 64 Elite fw 3.15a and C64U fw 1.2.1, PAL, 16 MB REU; rerun: c64://ultimate/hardware#rerun or c64://ultimate/bench. The rate depends on the CPU turbo setting (1 byte per microsecond holds only at 1-3 MHz). Bytes per microsecond, stash / fetch, screen blanked: 1 MHz 0.99 / 0.99, 2 MHz 1.97 / 1.97, 3 MHz 2.96 / 2.93. Top speed: U64 48 MHz 5.1 / 3.6, C64U 64 MHz 7.8 / 4.3. Not monotonic: U64 4 MHz fetch 2.0 and 6 MHz stash 3.0; C64U 10 MHz stash 4.9 against 7.7 at 8 MHz. Floors from 6 MHz up: U64 3.0 / 2.6, C64U 4.9 / 2.9.
- With the screen on and badlines the measured rate is 5 % lower; none with `$D031` bit 7 set. Each transfer has a fixed overhead of 3 to 15 PHI2 ticks (1-byte transfers: 15 at 1 MHz, 3 at top speed).
- At 64 MHz an unrolled `sta abs` fill (4 cycles per byte at 63 CPU cycles per microsecond) stores 15.75 bytes per microsecond, twice the REU stash rate of 7.8: fill memory with the CPU at top speed.
- **512 KB wrap:** without the extended registers the REU address bits 23-19 stay at the value written to `$DF06` for the whole transfer while bits 18-0 count (`reu.vhd:137-140`), so a transfer that crosses a 512 KB boundary (`$080000` multiple) wraps inside that block. VICE does the same. Rule: split every DMA so `(addr & $07FFFF) + len <= $080000`; length 0 means 64 KB. Extended builds count all 24 bits and mask them to the configured size.
- **Size detection** (no UCI command reports it): fetch the byte at REU offset 0, stash back `a^$A5`, fetch again (no REU if it does not hold; restore it). Then for s = 64 KB, 128 KB, ... 8 MB: save bytes at 0 and s, write `a^$A5` at 0 and `a^$5A` at s; if offset 0 now holds the second value the REU aliases at s, so size = s. Restore the bytes. No wrap up to 8 MB means 16 MB. Also verify a magic header and block checksums after loading: a missing or stale REU returns valid-looking stale data without error.
- **`$FF00` trigger** (b4 = 0): set the command, change `$01` (e.g. to `$34` for RAM under I/O), then store to `$FF00`. With `$01` = `$34` the trigger fetched 256 bytes into RAM under I/O (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20). A CPU copy of `$D000-$D0FF`, taken with `$01` = `$34`, matched the stashed bytes; the last byte was `$00` because the test had cleared that source byte before the stash. The VIC registers `$D000-$D02E` kept their values except the raster, light pen and collision registers, which the VIC updates itself. A bounce buffer in normal RAM, copied with the CPU, does not depend on the trigger. DMA writes to colour RAM (`$D800`) need I/O mapped in.
- Turbo: the REU gateware of 2026-08-28 (`g_no_dma_delay`, "no initial delay on U64/U64E2, because of Turbo Mode", commit 59594060b) stops the CPU in the cycle of the `$DF01` write; the earlier gateware inserted one cycle in which the CPU ran on at turbo speed. Rule for every core: disable interrupts from the first register write to the trigger, follow `sta $DF01` with `nop nop`, and put no instruction there that depends on the transfer. Core 1.50 contains this change (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20): with `U64 Turbo Registers` and CPU Speed 48, a 1-byte fetch followed directly by `lda $C000 / sta $C001` left `$C001` different from `$C000` in 0 of 3000 runs (3 runs of 1000).

## Recipes (assemble with ca65 and 64tass; the first one ran in VICE 3.10 x64sc with `-reu -reusize 128`)

Load a level from the REU into `$4000` (8192 bytes at REU offset `$010000`): write every register first, `$DF01` last.
```
load_level:
        php
        sei
        lda #$00
        sta $DF02         ; C64 address lo
        lda #$40
        sta $DF03         ; C64 address hi: $4000
        lda #$00
        sta $DF04         ; REU address lo
        sta $DF05         ; REU address mid
        sta $DF07         ; length lo
        sta $DF09         ; no REU interrupt
        sta $DF0A         ; both addresses count up
        lda #$01
        sta $DF06         ; REU bank (64 KB units): offset $010000
        lda #$20
        sta $DF08         ; length hi: $2000 bytes
        lda #$91          ; fetch, execute now, no autoload
        sta $DF01         ; MUST be the last register write
        nop
        nop
        plp
        rts
```
For several levels keep one table row per level (REU lo/mid/bank, length lo/hi, indexed by level number) and load `$DF04-$DF08` with `lda tab,x`. The shipped data must not cross a 512 KB boundary and must be at most 64 KB per call (length 0 = 64 KB). Stash is `$90`, swap `$92`, verify `$93`.

Detect an enabled REU (carry set = present; REU byte 0 is restored). A disabled REU does not answer, so this is also the "enabled" check. For the size see "Size detection".
```
reu_present:
        lda #$91
        jsr one           ; tmp = REU[0]
        lda tmp
        sta orig
        eor #$a5
        sta tmp
        lda #$90
        jsr one           ; REU[0] = orig xor $a5
        lda orig
        sta tmp           ; a missing REU leaves tmp = orig, which cannot pass the test
        lda #$91
        jsr one           ; tmp = REU[0] again
        lda tmp
        eor #$a5
        cmp orig          ; equal = the byte came back from REU memory
        php
        lda orig
        sta tmp
        lda #$90
        jsr one           ; restore REU[0]
        plp
        beq yes
        clc
        rts
yes:    sec
        rts
one:    php               ; 1-byte DMA between zero-page byte tmp and REU offset 0
        sei
        ldx #tmp          ; tmp, orig: two free zero-page bytes
        stx $DF02
        ldx #0
        stx $DF03
        stx $DF04
        stx $DF05
        stx $DF06
        stx $DF08
        stx $DF09
        stx $DF0A
        inx
        stx $DF07
        sta $DF01         ; A = command
        nop
        nop
        plp
        rts
```
- In C compilers (Oscar64 reordered stores to constant I/O addresses once) write the register sequence as one inline-assembly block, and re-read the first byte of a fetched buffer through a volatile pointer.

## Getting data into the REU

| Path | Works from host? | Notes |
|---|---|---|
| UCI DOS LOAD_REU (`01 21`, open file first) | by a running program | recommended for shipped games; file to REU without the C64; one command moves up to 16 MB minus the start; see c64://ultimate/uci |
| Menu: file browser, `.reu` file, load into REU | no (menu) | whole file to offset 0 |
| `REU Preload` (config) | partly | **boot only** (see below) |
| Stash stub + `machine:writemem` | yes | slow but scriptable |
| `runners:modplay` (PUT file / POST body) | yes | loads a MOD into REU offset 0 and plays it; overwrites the REU; needs the sampler |
| UCI control LOAD_REU `04 08 <3+ filler bytes>` | by a running program | loads the file named in `REU Preload Image` at `REU Preload Offset` (needs `RAM Expansion Unit` Enabled; `REU Preload` can be Disabled): the run-time way to repeat the preload; reply 4-byte LE count + text; `04 09` saves the REU back to that file (old file kept as `.bu`); see c64://ultimate/uci |

- There is no REST endpoint that writes REU memory. `machine:writemem`/`readmem` cover only C64 `$0000-$FFFF` (DMA on the cartridge bus, CPU stalls briefly).
- **Preload runs once at firmware boot** (`software/io/c64/reu_preloader.cc:14-80`). It is armed only if `REU Preload` is `Enabled` when the firmware starts; it waits for the volume of `REU Preload Image` to appear, then 25 ticks of the 200 Hz RTOS clock (125 ms), loads `min(file size, REU Size - offset)` bytes and ends its task. `machine:reset`, C64 reboot and `run_prg` do not reload it; setting it by REST after boot does not arm it; a power cycle or menu reboot does. To repeat it without reboot use UCI Control `04 08`. The image need not equal the REU size (VICE `-reuimage` does require exactly that size).
- **Stash stub pattern:** a small resident PRG with a mailbox (REU address, C64 address, length, command, trigger byte written last). The host writes a 16 KB chunk to C64 RAM with `machine:writemem`, fills the mailbox, trigger last; the stub stashes it and clears the trigger; the host polls the trigger, then verifies by fetching back. Hash chunks to skip unchanged ones (the REU survives resets).
- `.reu` files are raw REU dumps without header. The menu action "Save REU Memory" writes `REU Size` bytes (`software/io/c64/c64_subsys.cc:296-315`). DOS LOAD_REU/SAVE_REU address a 16 MB REU.
- Image layout: header (magic, version, block table of id/flags/24-bit offset/length), per-block checksums checked at boot.

## Patterns for games

- **Level/map streaming:** keep tile maps in the REU page-aligned; once per frame, after the raster IRQ passed the visible area, fetch one 256-byte column or row into an off-screen buffer. Measured on a C64U at 64 MHz: one 256-byte fetch per frame for 500 frames, no glitches.
- **Charset/sprite swap into a VIC bank** between frames: fetch the new 2 KB charset or sprite blocks into the inactive part of the VIC bank, then flip `$D018`/`$DD00` in the next IRQ. Fetching 2,048 bytes takes 2.07 ms at 1 MHz (0.99 B/us), 0.57 ms at 48 MHz and 0.48 ms at 64 MHz (measured fetch rates above).
- **Bitmap/screen swap:** 8000 + 1000 + 1000 bytes take 10.1 ms at 1 MHz (half a PAL frame), 2.8 ms at 48 MHz, 2.3 ms at 64 MHz: start after the bottom IRQ, flip in the next top IRQ, or hide it under a fade. Colour RAM needs I/O mapped in.
- **Digi samples (design pattern):** 4-bit samples in the REU, a 256-byte ring in RAM, a CIA timer IRQ that writes one sample to `$D418` per tick (8000 Hz = CIA timer value 122 on PAL, 985,248 Hz / 8000 - 1), and a 64-byte fetch each time 64 samples were consumed. Let the IRQ own the REU or wrap access in `sei`. `$D418` bits 4-7 are filter/voice-3 bits: write the whole value. Alternative: the Ultimate Audio sampler (`$DF20-$DFFF`, `Map Ultimate Audio $DF20-DFFF`) plays from REU without the CPU; register map and REU addressing in c64://ultimate/hardware (Ultimate Audio sampler).
- A raster IRQ and the main loop must not both program the REU: one owner, or `sei`/`cli` around main-loop use. Overlays: architecture section 5C.

## Pitfalls (most often violated)

1. REU is disabled by default; a stale or absent REU returns valid-looking data: check presence, magic, checksum at boot.
2. `$DF01` is the last register write; no compiler reordering; clear `$DF0A` fix bits after use.
3. Split DMAs at 512 KB boundaries; length 0 means 64 KB; autoload restores base values (use no-autoload for consecutive blocks).
4. Reading `$DF00` clears flags and IRQ; `$FF00` mode leaves a pending command until `$FF00` is written.
5. VICE charges DMA at 1 cycle per byte (VICE 3.10, measured) and an image must equal the configured size; test streaming budgets on hardware.
6. `RAM Expansion Unit` = `GeoRAM Mode` replaces the REU: a 256-byte window at `$DE00-$DEFF`; writes to even addresses in `$DF80-$DFFE` select the 256-byte page inside a 16 KB block (bits 5-0), writes to odd addresses `$DF81-$DFFF` select the 16 KB block (bits 7-6 of the even register extend the block number past 4 MB); both are masked to `REU Size` (`fpga/cart_slot/vhdl_source/all_carts_v5.vhd:644-653`).

## Not verified

| Claim | What would settle it |
|---|---|
| C64U: `$DF0C-$DF0F` present or absent | `GET /v1/machine:readmem?address=DF0C&length=4` on a C64U with the REU enabled (C64U only) |

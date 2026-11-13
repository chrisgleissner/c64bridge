# Ultimate turbo benchmark (CPU budget, badlines, sprites, I/O, REU DMA)

**Summary:** Three c64bridge-assembler programs measure CPU cycles per frame, badline and sprite cost, I/O speed and REU DMA rate at every turbo index. Results (2026-11-13, Ultimate 64 Elite fw 3.15a and C64U fw 1.2.1) are in `results/summary.md`; game budgets derived from them are in c64://gamedev/architecture.
**Read when:** you need a measured figure's source, want to rerun or extend the benchmark, or must decode a result block. For game budgets read architecture, not this file.

Measures how many CPU cycles a game really gets per frame on an Ultimate 64 or C64 Ultimate at each turbo setting, and how
fast REU DMA runs. The programs are written for the c64bridge assembler (`c64_program` op `upload_run_asm`): one call, no
toolchain. Measured results are in `results/` (`summary.md`, one JSON file per device and date). The knowledge resources
c64://ultimate/hardware, c64://ultimate/reu, c64://ultimate/upic and c64://gamedev/architecture quote them.

Raw per-point JSON results are in the GitHub repository under data/ultimate/bench/results/; the npm package ships only results/summary.md.

Files: `turbo-cpu.asm`, `turbo-reu.asm`, `turbo-window.asm` (this directory), host script `scripts/turbo-bench.mjs`
(`npm run bench:turbo`).

## Programs

| Program | What it measures | Typical run time |
| --- | --- | --- |
| `turbo-cpu.asm` | Effective CPU throughput per speed index x 4 display conditions x 4 loads x 3 repetitions | 6 min for everything, 20 s for one speed |
| `turbo-reu.asm` | REU stash and fetch of 32 KB, 16 KB and 1 byte per speed index, screen on and blanked | 40 s for all 16 indexes |
| `turbo-window.asm` | How long after program start a `$D031` speed request needs to take effect (forced 1 MHz window after reset) | about 15 s |

Display conditions (`COND_MASK` bit): 0 screen on with badlines, 1 screen blanked (`$D011` bit 4 clear), 2 screen on plus
8 double-height sprites, 3 blanked plus 8 sprites. Loads (`VAR_MASK` bit): 0 RAM reads, 1 `sta $D020`, 2 `lda $D012`,
3 `lda $DC05` (CIA). Each loop pass is 48 cycles at 1 MHz: six times (one 4-cycle access plus two NOPs), so half of
the cycles are the chosen access. The unrolled loop is aligned to a page (a taken branch across a page costs one extra
cycle; this showed up as a 1.85 percent error in the first VICE validation run and is the reason for `.align 256`).

## Method

* Interrupts off (`sei`, CIA and VIC interrupt sources masked), `$01 = $35`, KERNAL and BASIC banked out.
* The clock is CIA2 timer A (PHI2 ticks) chained to timer B, 32 bits. PHI2 does not change with CPU speed, so the tick
  count is wall time in 1 MHz cycles.
* Each run synchronises to a raster line, starts the timers, executes a fixed number of passes `N = 29 x speed in MHz`
  (about 20 PAL frames, 0.4 s), and stops the timers. The speed is written through `$D031` (index | `BADBIT`).
  Start line differs per repetition (`$F8`, `$60`, `$A0`) so a phase effect against the badline pattern would show as spread.
* `$D031` is written repeatedly until a probe loop runs faster than 1 MHz (the firmware ignores the register for a
  while after a reset). Attempts per index are in the header (`$FF` = never took effect).
* Three frame-length measurements (raster line `$F8` to `$F8`) are stored. They must read 19656 (PAL) or 17095 (NTSC)
  plus or minus 7 and prove the timebase and synchronisation.
* Interference check: if the repetitions of a point differ by more than 0.78 percent the point gets flag 1. Reading
  C64 memory over REST pauses the CPU; a read during a run shows up here. The reported value is the median of the repetitions.

## Parameters (top of each `.asm`; change the `.equ` values, then upload the whole file)

`turbo-cpu.asm` / `turbo-reu.asm`: `IDX_MASK_LO`, `IDX_MASK_HI` (bit n = speed index n), `COND_MASK`, `VAR_MASK`
(cpu only), `NREP` (1-3), `USE_D031` (1: program writes `$D031`; 0: leave the speed alone, for Manual and TurboEnable
modes), `BADBIT` (`$00` or `$80`, ORed into the `$D031` value), `D030_WRITE`/`D030_VALUE` (write `$D030` once, for the
TurboEnable-bit mode), `SPEED_TABLE` (1 = Ultimate 64 table up to 48 MHz, 2 = C64U/U64E2 table up to 64 MHz),
`NOMINAL_M` (speed in MHz assumed when `USE_D031 = 0`; it only scales the run length and the cycle conversion).
`turbo-window.asm`: `TARGET_IDX`, `BADBIT`, `MAX_ATTEMPTS`.

Speed index to MHz (from `software/u64/u64_config.cc`): Ultimate 64 (Elite): 1 2 3 4 5 6 8 10 12 14 16 20 24 32 40 48.
C64U / Ultimate 64 Elite II: 1 2 3 4 6 8 10 12 14 16 20 24 32 40 48 64. Turbo Control values in the firmware: Off,
Manual, "U64 Turbo Registers" (named per device), "TurboEnable Bit". The device's own allowed values must be read
first (`c64_config get`), the names above are from firmware source only. In the firmware `$D031` bit 7 corresponds
to the "Badline Timing" bit of the speed preference register; its polarity as seen from software is not documented,
so measure idx 0 with screen on for `BADBIT = $00` and `$80` and compare.

## Result block (one `c64_memory` read: address `$C000`, length 3840, `format` hex)

All values are bytes. The block is cleared at program start. `$C005` becomes `$A5` when everything is finished.

| Offset (from `$C000`) | Size | Content |
| --- | --- | --- |
| `$00` | 4 | magic `54 55 52 42` ("TURB") |
| `$04` | 1 | format version (1) |
| `$05` | 1 | done flag: `$00` running, `$A5` finished |
| `$06` | 1 | program id: 1 cpu, 2 reu, 3 window |
| `$07` | 1 | speed index currently being measured (progress) |
| `$08`-`$12` | | echo of the parameters: idx mask lo, hi, cond mask, var mask, nrep, use_d031, badbit, d030_write, d030_value, speed_table, nominal_m (at `$12`) |
| `$13` | 1 | `$D031` read before any write (`$FF` when Turbo Control is Off or on VICE) |
| `$14` | 1 | border colour at start (restored at the end) |
| `$15` | 1 | REU present (reu program) |
| `$16`-`$17` | 2 | idle heartbeat counter (changes after done) |
| `$18`-`$23` | 12 | three frame-length records (4 raw timer bytes each) |
| `$20`, `$21` | | window program only: attempts made, first fast attempt (`$FF` = never) |
| `$30`-`$3F` | 16 | per speed index: attempts needed until the speed took effect (`$FF` never, 0 not run) |
| `$40`-`$4F` | 16 | per speed index: `$D031` read back after the speed took effect |
| `$60`-`$6F` | 16 | per speed index: speed in MHz assumed for that index |
| `$100`-`$1FF` | 256 | cpu: interference flag per point, index = idx x 16 + cond x 4 + load |
| `$200`-`$2FF` | 256 | cpu: spread of the repetitions in units of 256 ticks (saturated at `$FF`) |
| `$300`-`$EFF` | | records (below) |

A "raw timer record" is 4 bytes: A low, A high, B low, B high of the CIA2 counters, which started at `$FFFF`:
`ticks = (0xFFFF - B) x 65536 + (0xFFFF - A)` (PHI2 cycles). Because of the counting convention the frame length reads
1 more than the nominal value for a perfectly aligned run (19657 against 19656).

* cpu records: record address = `$C300 + idx x 192 + cond x 48 + load x 12 + rep x 4`. All-zero bytes where a point
  was not selected by a mask.
* reu records: address = `$C300 + idx x 144 + cond x 72 + rep x 24 + transfer x 4`, cond 0 screen on, 1 blanked,
  transfer 0 stash 32 KB, 1 stash 16 KB, 2 stash 1 byte, 3 fetch 32 KB, 4 fetch 16 KB, 5 fetch 1 byte.
* window records: attempt k (0-based) at `$C300 + 8k`: probe timer record (4 bytes, probe ticks below 65536 means the
  probe ran faster than 1 MHz), then the free-running wall clock since program start (4 bytes, same encoding, ticks).

### Formulas

* CPU, per point: `multiple = N x 13575 / ticks`, N = 29 x MHz. `13575` is the number of CPU cycles (at nominal timing)
  of one outer pass: `256 x (48 + 2 + 3) - 1 + 5 + 3`. Take the median over the repetitions.
* `effective 1 MHz-equivalent cycles per frame = multiple x frame_ticks` (frame_ticks 19656 PAL, 17095 NTSC; use the
  measured median from the header). Per raster line: divide by 312 (PAL) or 263 (NTSC). `multiple` is the delivered
  speed as a multiple of PHI2, for example 46.99 for the 48 MHz setting.
* Cycles lost compared with a blanked screen at the same speed: `(multiple_blank - multiple_on) x frame_ticks`.
* REU: `bytes per PHI2 tick = (32768 - 16384) / (ticks_32K - ticks_16K)` (removes start-up overhead); the 1-byte
  transfer shows that overhead (14 ticks on VICE). 1.0 means one byte per 1 MHz cycle.
* Window: the first attempt with `probe_ticks < 65536` marks the speed taking effect; its wall-clock stamp is the time
  after program start (convert ticks to ms with 985.248 PAL, 1022.7 NTSC).

`scripts/turbo-bench.mjs --decode <file>` implements exactly this for a raw 3840-byte block.

## Rerun recipe for an LLM using only c64bridge MCP tools

Do not read C64 memory while a program runs: a read pauses the CPU and distorts the run. Wait the computed time first.
Never call `c64_config` ops `save_flash`, `load_flash` or `reset_defaults`, and never `c64_system` `reboot`, `poweroff` or
`power_cycle` during the benchmark. On a shared device hold its device lock for the whole session.

1. `c64_select_backend {"op":"select","backend":"c64u"}` (the configured host decides which Ultimate it is; `"vice"` for
   VICE). Read `c64://platform/status` to confirm.
2. Hardware only. Remember the original settings:
   `c64_config {"op":"get","category":"U64 Specific Settings"}` (all items of the category; save the reply). Note the allowed
   values with `{"op":"get","category":"U64 Specific Settings","item":"Turbo Control"}`, and the same for `"CPU Speed"` and
   `"Badline Timing"`. For the REU program check `{"op":"get","category":"C64 and Cartridge Settings","item":"RAM Expansion Unit"}`
   is `Enabled` (also save its category).
3. Hardware only. Set what the experiment needs, for the registers mode:
   `c64_config {"op":"set","category":"U64 Specific Settings","item":"Turbo Control","value":"<registers value>"}`
   (`U64 Turbo Registers` on the devices measured here). VICE has no turbo: use `USE_D031 = 0`, `NOMINAL_M = 1`,
   `IDX_MASK_LO = 1`, `IDX_MASK_HI = 0`; for the REU program enable the REU first with
   `c64_vice {"op":"resource_set","name":"REU","value":1}` and `{"op":"resource_set","name":"REUsize","value":16384}`.
4. Edit the parameter block of the chosen `.asm`, then
   `c64_program {"op":"upload_run_asm","program":"<full source text>"}` (leave `verify` unset: verification reads the screen).
   The program takes over the machine and does not return to BASIC.
5. Wait the computed time (below) with the client's own wait (shell `sleep`), with no C64 call in between. Seconds:
   cpu `0.56 x nIdx x nCond x nVar x nRep + nIdx x (0.2 + 0.07 x nCond) + 4`;
   reu `nIdx x (0.3 x nCond x nRep + 0.3) + 4`; window `0.12 x MAX_ATTEMPTS + 3`. Add 10 percent. Add about 20 s for every
   speed index that never takes effect (150 attempts x 0.12 s).
6. Read once: `c64_memory {"op":"read","address":"$C000","length":3840,"format":"hex"}`. Byte `$05` must be `A5`. If not,
   wait 20 s and read again, but treat earlier points as suspect (the interference flags tell).
7. Decode with the table and formulas above.
8. Restore every changed item with `c64_config {"op":"set","category":...,"item":...,"value":<value recorded in step 2>}`,
   then `get` the category again and compare it with the saved reply. The measurement program restores `$D031`, `$D030`,
   `$D011`, `$D015` and the border itself.

Interpretation checks: the frame-length records must read 19656 or 19657 (PAL) or 17095 or 17096 (NTSC). At 1 MHz with the
screen blanked every load must give multiple 1.0000. With the screen on at 1 MHz and `$D031` bit 7 clear, about 25 badlines
x 43 cycles are lost (about 1,080 per PAL frame). A point with an interference flag, a spread above 0.5 percent or status
`$FF` is rerun once and reported, not dropped.

Speed-mode notes: in `Manual` and `TurboEnable Bit` mode set `USE_D031 = 0` and `NOMINAL_M` to the configured speed. The
program has no liveness probe in that mode, so the first repetition runs inside the 1 MHz window after the reset; it shows
as an interference flag on the first point and the median of three repetitions is not affected. Insert a delay or discard
that point when it matters.

## Host script (humans)

```
npm run build                      # the script imports dist/tools/translation/assembler.js (or run it with tsx/bun)
node scripts/turbo-bench.mjs --host <ip> --probe --out out/dev          # prints Turbo Control, CPU Speed, Badline Timing
node scripts/turbo-bench.mjs --host <ip> --suite quick --out out/dev    # about 1.5 min
node scripts/turbo-bench.mjs --host <ip> --suite full  --out out/dev    # about 15 min
node scripts/turbo-bench.mjs --collect out/dev --device "Ultimate 64" --date YYYY-MM-DD \
     --results-out data/ultimate/bench/results/ultimate-64-YYYY-MM-DD.json > summary-part.md
node scripts/turbo-bench.mjs --decode out/dev/cpu-regs-all.bin          # decode one raw result block
```

The script reads the category before it changes anything, sets Turbo Control (and enables the REU if it is off), runs the
programs, restores every changed item in a `finally` block and compares the categories before and after (`RESTORE VERIFIED`
or `RESTORE DIFF`). It never writes flash, resets power or reboots. It reads C64 memory once per run, after the computed time.
On a shared device run one invocation for the whole sequence and do not let another user's program or flash overlap. Set `C64U_PASSWORD` when network protection is enabled. Options:
`--set NAME=VALUE` (parameter override), `--cfg Item=Value`, `--program cpu|reu|window`, `--assemble-only`, `--no-restore`.


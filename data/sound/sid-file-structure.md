# SID File Structure (PSID/RSID) — Concise Overview

This guide summarizes the High Voltage SID Collection (HVSC) "PSID file format" header used by classic SID tunes. A SID file consists of:

- A header containing metadata and playback parameters
- The actual 6502 machine code and data that the player runs on the C64

You can play a SID file on a connected device with the MCP tool `c64_sound` and `op: "play_sid_file"`.

## Quick start: play a SID via MCP

- Tool: `c64_sound`
- Arguments: `{ "op": "play_sid_file", "path": "/flash/music/Example.sid", "songnr": 1 }` (optional `songnr`)

Refer to `doc/c64u/c64-rest-api.md` for the underlying device endpoint and options.

## Header layout (common fields)

Offsets are from the start of the file. All multi-byte fields are big-endian.

- +00 — magic (4 bytes): ASCII `PSID` or `RSID`
  - `PSID`: C64-compatible files (player-friendly subset); `RSID`: more strict C64 requirements (no BASIC SYS stubs, tighter hardware expectations)
- +04 — version (uint16): 1..4
  - Higher versions extend the header with more fields (see below)
- +06 — dataOffset (uint16): byte offset where the code/data block begins
  - Typically static per version; points to the start of the machine code region
- +08 — loadAddress (uint16): target RAM address for the data block
  - If 0, the first two bytes of the data block contain the load address
- +0A — initAddress (uint16): address to call once at start
  - Accumulator selects the sub-song number when calling init
  - If 0, use `loadAddress` as the init routine address
- +0C — playAddress (uint16): address to call repeatedly to advance playback
  - Usually invoked by the IRQ handler at 50/60 Hz
  - If 0, the code is expected to install its own ISR during init
- +0E — songs (uint16): number of available sub-songs (>= 1)
- +10 — startSong (uint16): default sub-song to start with (1-based)
- +12 — speed (uint32): per-song timing bits (bit i = song i)
  - Bit = 0: use vertical blank (VIC raster; PAL/NTSC rate)
  - Bit = 1: use CIA1 timer-driven playback (~60 Hz)

For version 1, the header ends here and the data begins at `+76` (decimal) unless `dataOffset` states otherwise.

## Extended header (versions 2–4)

These versions append more detail for environment and chip configuration.

- +76 — flags (uint32): bitfield
  - b0: 0 = built-in player, 1 = Compute! player
  - b1: 0 = C64-compatible PSID, 1 = PlaySID-specific/C64 BASIC
  - b2–b3 (video): `01`=PAL, `10`=NTSC, `11`=Both, `00`=Unknown
  - b4–b5 (primary SID model): `00`=unknown, `01`=6581, `10`=8580, `11`=both
  - b6–b7 (second SID model): same encoding (v3+)
  - b8–b9 (third SID model): same encoding (v4)
  - Remaining bits reserved (set to 0)
- +78 — startPage (uint8): high byte of a free memory page for a music driver; `0` means free outside data block, `0xFF` means none
- +79 — pageLength (uint8): number of contiguous pages available starting at `startPage`
- +7A — secondSIDAddress (uint8): `0x2x` → second SID at `$D2x0`, etc. (v3+)
- +7B — thirdSIDAddress (uint8): third SID address like above (v4)
- +7C — data start (beginning of machine code and data)

Notes:

- Version number loosely correlates with multi-SID usage: v2 single-SID, v3 dual-SID, v4 triple-SID.
- PAL vs NTSC differences and SID model (6581/8580) materially affect sound; consult `flags`.

## Timing and interrupts

- `speed` determines whether playback uses VBlank (VIC raster IRQ) or CIA1 timer.
- In RSID, VIC raster is generally not to be assumed; rely on the player-installed timing per header hints.

## Song length database (Songlengths.md5)

SID files do not embed duration. HVSC ships a `Songlengths.md5` database mapping each file’s MD5 to a track length:

- Format: INI-like: a header line `[database]`, then repeated groups of a commented filename line (starts with `;`) and a line with `MD5 = mm:ss[.ms]`.
- To obtain a length: compute MD5 of the full SID file (header + data), look up the matching entry, parse minutes/seconds (and optional milliseconds).

## Practical playback flow

1) Read header (verify `PSID`/`RSID`).
2) Resolve `dataOffset` and `loadAddress`; if `loadAddress=0`, fetch it from first two data bytes.
3) Load data to RAM and call `initAddress` (or `loadAddress` if `initAddress=0`), passing the desired sub-song in `A`.
4) Repeatedly call `playAddress` (or let the player’s ISR drive it) at the cadence implied by `speed`.
5) Select sub-songs via re-invoking `init` with accumulator set to song number.

## Related API and tools

- Play from device filesystem: `c64_sound` with `op: "play_sid_file"` (see generated `mcp/tools.json` and `mcp/schemas/c64_sound.schema.json`)
- Low-level SID register programming: see `data/sound/sid-spec.md`

References for further reading: HVSC PSID v2NG file format (spec), community resources, and project notes from implementations like SIDman.

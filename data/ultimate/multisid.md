# Ultimate Devices: Multi-SID Control for Games

**Summary:** A C64 Ultimate (C64U) has two UltiSIDs (FPGA SIDs) that split into up to 8 SIDs, plus two SID sockets. A game places them with a `.cfg` and UCI `LOAD_CONFIG`, writes only to mapped windows and verifies each with ENV3. 
**Limit:** the commonly quoted 8 SIDs / 24 voices (official MultiSID guide, 1541u-documentation.readthedocs.io/en/latest/config/multi_sid.html) counts the two UltiSIDs split 1/4 only, and is the limit with empty sockets. The decoder has four independent slots (UltiSID 1, UltiSID 2, Socket 1, Socket 2; source: `get_sid_addresses`, base/mask/split per slot), so a real SID or replacement in each socket adds one SID each: 10 / 30 (device: ENV3 identity matrix over all ten windows, two ARMSID, C64U 1.2.1). Dual-SID chips with `Ext DualSID Range Split`: up to 12 / 36 (source only, unverified). The older Ultimate 64 manual says 4 SIDs / 12 voices (unsplit).
**Read when:** a modern C64U/Ultimate game uses more than one SID, sets SID addresses or stereo at run time, or must work with empty sockets, one or two real SIDs or SID replacements (ARMSID, ARM2SID, FPGASID, SwinSID); not on a stock C64 or in VICE.

Marks: "device" = measured on a C64U 1.2.1, PAL, 2026-11-13; "source" = public firmware repository GideonZ/1541ultimate (`software/u64/u64_config.cc`, `software/io/command_interface/control_target.cc`). FPGA internals are not public.

## Owner configurations and settings

All use `Auto Address Mirroring=Disabled`. Counts: SIDs / voices.

| Owner | SIDs | Settings (store `SID Addressing`) |
|---|---|---|
| UltiSIDs only | 8 / 24 | `UltiSID Range Split=1/4 (A7,A8)`, `UltiSID 1 Address=$D400`, `UltiSID 2 Address=$D420`, both sockets `Unmapped` |
| plus one socket SID | 9 / 27 | add `SID Socket 1 Address=$D440` |
| plus two socket SIDs | 10 / 30 | add `SID Socket 2 Address=$D460` (device: verified with two ARMSID) |
| dual-SID chips in sockets | up to 12 / 36 | as above plus `Ext DualSID Range Split=A9`; second SIDs at `$D640`, `$D660` (source; not verified, no dual device) |

Windows (32 bytes each, registers `$00-$1C`): UltiSID 1 parts `$D400, $D480, $D500, $D580`; UltiSID 2 parts `$D420, $D4A0, $D520, $D5A0`; Socket 1 `$D440`; Socket 2 `$D460`. The default is all four decoders at `$D400` with mirroring on, so every chip hears every write.

## Address rules

- Four decoders (Socket 1, Socket 2, UltiSID 1, UltiSID 2), each a 32-byte window. Legal addresses: `Unmapped`, `$D400`-`$D7E0` and `$DE00`-`$DFE0` in steps of `$20` (49 labels). Keep SIDs out of `$DE00-$DFFF` (REU, UCI).
- `UltiSID Range Split` (shared by both UltiSIDs): `Off`, `1/2 (A5)`, `1/2 (A6)`, `1/2 (A7)`, `1/2 (A8)`, `1/4 (A5,A6)`, `1/4 (A5,A8)`, `1/4 (A7,A8)`. The split bits are cleared from the base, then every combination is a part. With UltiSID 1 `$D400` and 2 `$D420`: A6 gives `$D400,$D440`/`$D420,$D460`; A7 `$D400,$D480`/`$D420,$D4A0`; A8 `$D400,$D500`/`$D420,$D520`; (A7,A8) all eight. Splits that contain A5 make UltiSID 2 overlap UltiSID 1 at these addresses: do not use.
- `Ext DualSID Range Split` (sockets): `Off`, `A5` to `A9`; the bit is removed from both socket decoders and drives the chip's address-select line. A9 is the only choice that keeps the 10-SID map free of overlaps.
- Two decoders at one address both receive the write (no priority).
- `Auto Address Mirroring`: after the split bits are removed, an address bit A5-A9 becomes "don't care" if all mapped decoders agree on it, so the map repeats. The 10-SID map repeats at plus `$200`; with both sockets `Unmapped` it repeats at plus `$40` and `$200`. `Disabled` leaves exactly the listed windows (device).
- Write or read of an unmapped (undecoded) address in `$D400-$D7FF`: the maintainers' research on an Ultimate 64 Elite (fw 3.15) found that a 6510 access never completes (CPU stalls until reset) and a REST or DMA access hangs the Ultimate. Not tested on the C64U (needs a power cycle to recover): assume it hangs. Touch only mapped windows, never probe candidate addresses, and no REST `readmem` of the whole I/O area with a split map.
- The freezer writes `$D41F`, `$D43F`, `$D51F` on return: keep `$D400`, `$D420`, `$D500` decoded (the 10-SID map does).

## Recipe: 3 independent SIDs, sockets empty, SID 2 hard right

1. Host or install time: UCI enabled (`C64 and Cartridge Settings / Command Interface=Enabled`).
2. Write this `.cfg` (to `/Temp/g.cfg` via DOS target, or ship it) and send `04 50 /Temp/g.cfg` (LOAD_CONFIG below):
   `[SID Addressing]` `Auto Address Mirroring=Disabled`, `UltiSID Range Split=1/4 (A7,A8)`, `UltiSID 1 Address=$D400`, `UltiSID 2 Address=$D420`, `SID Socket 1 Address=Unmapped`, `SID Socket 2 Address=Unmapped`, `Ext DualSID Range Split=Off`; `[Audio Mixer]` `Pan UltiSID 1=Left 5`, `Pan UltiSID 2=Right 5`.
3. Eight windows are live (map under Owner configurations). Use SID A `$D400`, SID B `$D500` (UltiSID 1, left), SID C `$D420` (UltiSID 2, hard right); never touch unmapped addresses. This split keeps `$D500` decoded for the freezer.
4. Per SID write registers `$00-$18` at its base (voice 1 `$00-$06`, voice 2 `$07-$0D`, voice 3 `$0E-$14`, filter `$15-$17`, `$18` = volume/filter mode). Set `$D418` of each window separately.
5. Verify with the ENV3 test (Detection) on the three windows; on failure play everything on `$D400`.
Pan is per UltiSID, not per part: parts of one UltiSID cannot be panned apart. To pan SID 2 hard right at run time, send a `.cfg` with only `[Audio Mixer]` `Pan UltiSID 2=Right 5` (only listed items change).

## Mixer, pan and the audio stream

- Store `Audio Mixer`: ten channels; the SID ones are UltiSID 1, UltiSID 2, Socket 1, Socket 2 with `Vol UltiSid 1`/`Vol UltiSid 2`/`Vol Socket 1`/`Vol Socket 2` and `Pan UltiSID 1`/`Pan UltiSID 2`/`Pan Socket 1`/`Pan Socket 2` (source spelling; names and values match case-insensitively, outer spaces ignored); `Vol Master`. Pan is `Left 5`..`Left 1`, `Center`, `Right 1`..`Right 5`. Defaults: UltiSIDs `Center`, Socket 1 `Left 3`, Socket 2 `Right 3`.
- All parts of an UltiSID share its volume and pan. Per-part level uses `$D418` of that part: linear, independent of every other part (device: volume 8 gives 0.53, 4 gives 0.27 of volume 15; other parts unchanged). Amplitude panning between a left part and a right part works by the level ratio (device).
- Stereo separation (device): with `Pan UltiSID 1=Left 5` and `Pan UltiSID 2=Right 5` an UltiSID 1 part is absent on the right channel (more than 95 dB down) and an UltiSID 2 part on the left.
- The UDP audio stream (`PUT /v1/streams/audio:start`, 192 stereo S16 frames per packet, 47982.89 Hz PAL) is the final mixer output, all parts and sockets (device); use it to test from the host.
- Level (device, sawtooth, volume 15): one voice about 0.24 of full scale; 12 voices on one pan side 0.92; 24 clip. Keep per pan side the sum of (volume/15 times sustain/15) at or below about 10 (saw).

## Run-time control from the C64

- UCI is off by default: `C64 and Cartridge Settings / Command Interface=Enabled` is required; read `$DF1D` for `$C9`. Registers `$DF1C-$DF1F` (see c64://ultimate/uci). The game cannot enable UCI itself.
- `LOAD_CONFIG` (target 4, command `$50`, message `04 50 <path>`) applies a `.cfg` and effectuates the changed stores at once while the program runs. Device: works on 1.2.1 with `/Temp/name.cfg` (put there by FTP; a game writes it via the DOS target). The reply data is the parse log; a store the device lacks gives `Line N: Store name '...' not found; section ignored.` and status `00,OK`.
- Labels equal the REST names; example: Recipe above.
- Registers cannot be written by the 6510; there is no UCI command to read a setting. A `.cfg` with the same name as a PRG, CRT or disk is applied when started from the file browser.
- Restore: make a restore `.cfg` at install time from the host (`GET /v1/configs/<store>` for `SID Addressing`, `Audio Mixer`, ...) and `LOAD_CONFIG` it on exit after silencing the chips (device: restores exactly the listed items).
- Flash: changes live in RAM; they are saved only by `configs:save_to_flash` or the menu's save prompt, so a later menu visit can persist the game's map (source).
- Host: `PUT /v1/configs/<store>/<item>?value=...` (RAM only) or `c64_config`.

## Detection

- `GET_HWINFO` (command `$28`) device 0 returns the product string (device: `C64 Ultimate`); device 1 returns a count then 5 bytes per decoder: UltiSID 1, UltiSID 2, then each enabled socket. Entry: address low, address high, `$00`, `$00`, type (source: 2, or 3 when the mask is not `$FE` (split or mirrored), for UltiSIDs; 4 or 5 for sockets; `+128` is set on every entry. For a dual chip bytes 3-4 hold the second SID's address). A socket is listed only if `SID Socket 1/2` (store `SID Sockets Configuration`) is `Enabled`. Device: 10-SID map gives `04 00D4.. 20D4.. 40D4.. 60D4..`. Parts, second SIDs and the chip type are not listed. REST `SID Sockets Configuration` gives `SID Detected Socket 1/2` (None, 6581, 8580, ARMSID, ARM2SID, FPGASID, SwinSID Ultimate, PDsid, SIDKick ...) for a host installer.
- ENV3 test (device: 10 windows by 10, both from the 6510 and by REST, gives the identity matrix): silence all; at window i set voice 3 to triangle or saw at a high frequency, attack 0, sustain 15, gate on, volume 15; wait two frames; read `$1C` of every mapped window: window i gives `$FF`, all others `$00`. Close the gate afterwards. Do not use OSC3 `$1B` (keeps changing). Any other window that also reads `$FF` means an overlap: fall back to a smaller map.
- Test only mapped windows. Without UCI (no `$C9`), play one SID at `$D400`.
- Device: REST `writemem` to the Socket 1 window was sometimes also heard on Socket 2 (6510 writes were clean): check both sockets' ENV3 before REST sound tests.

## Differences in sound

- UltiSID: filter curve per UltiSID (`8580 Lo`, `8580 Hi`, `6581`, `6581 Alt`, `U2 Low`, `U2 Mid`, `U2 High`), `Filter Resonance` `Low`/`High`, `Combined Waveforms` `6581`/`8580`, `Digis Level`, set in store `UltiSID Configuration`; both UltiSIDs can differ. Use single waveforms and curve-tolerant filters.
- Sockets hold chips with their own filter, DC and noise; the two ARMSID differed ten times in volume click and two times in triangle level (device).
- A `$D418` volume step clicks: about 900 (UltiSID) to 1400 (ARMSID) of 32767 per step; 0 to 15 is 0.4 to 0.6 of full scale (device). Step by one at most, only on silent chips.
- Same-frequency unison: two UltiSID parts add to 0.71 of the sum; UltiSID against ARMSID gave 0.32 (triangle), 0.74 (saw), 0.99 (pulse) (device). Do not rely on unison for level; detune slightly. The same 440 Hz on four chips panned apart gave a moving, spacious beating field by ear (device): stereo movement without modulation.
- Not measured: ADSR delay bug, filter range of split parts, cost of socket writes (behind the 1 MHz bridge, source). Plan for note starts up to two frames late.

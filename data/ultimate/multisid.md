# Ultimate Devices: Multi-SID Control for Games

**Summary:** A C64 Ultimate (C64U) has two UltiSIDs (FPGA SIDs) that split into 8 independent SIDs, plus two SID sockets: 8 to 10 SIDs (24 to 30 voices), up to 12 with dual-SID chips. A game places them with a `.cfg` and UCI `LOAD_CONFIG`, writes only to mapped windows and verifies each with ENV3. Verified on a C64U, firmware 1.2.1 (two UltiSID, two ARMSID).
**Read when:** a modern C64U/Ultimate game uses more than one SID, sets SID addresses or stereo at run time, or must work with empty sockets, one or two real SIDs or SID replacements (ARMSID, ARM2SID, FPGASID, SwinSID); not on a stock C64 or in VICE.

Marks: "device" = measured on a C64U 1.2.1, PAL, 2026-11-13; "source" = public firmware repository GideonZ/1541ultimate (master of 2026-10-31, `software/u64/u64_config.cc`, `software/io/command_interface/control_target.cc`) only. The FPGA is closed source, so internal behaviour is source or device only.

## Owner configurations and settings

All use `Auto Address Mirroring=Disabled`. Counts: SIDs / voices.

| Owner | SIDs | Settings (store `SID Addressing`) |
|---|---|---|
| UltiSIDs only | 8 / 24 | `UltiSID Range Split=1/4 (A7,A8)`, `UltiSID 1 Address=$D400`, `UltiSID 2 Address=$D420`, `SID Socket 1 Address=Unmapped`, `SID Socket 2 Address=Unmapped` |
| plus one socket SID | 9 / 27 | add `SID Socket 1 Address=$D440` |
| plus two socket SIDs | 10 / 30 | add `SID Socket 2 Address=$D460` (device: verified with two ARMSID) |
| dual-SID chips in sockets | up to 12 / 36 | as above plus `Ext DualSID Range Split=A9`; second SIDs at `$D640`, `$D660` (source; not verified, no dual device) |

Windows (32 bytes each, registers `$00-$1C`): UltiSID 1 parts `$D400, $D480, $D500, $D580`; UltiSID 2 parts `$D420, $D4A0, $D520, $D5A0`; Socket 1 `$D440`; Socket 2 `$D460`. Always `Ext DualSID Range Split=Off` except for dual chips. The default is all four decoders at `$D400` with mirroring on, so every chip hears every write.

## Address rules

- Four decoders (Socket 1, Socket 2, UltiSID 1, UltiSID 2), each a 32-byte window. Legal addresses: `Unmapped`, `$D400`-`$D7E0` and `$DE00`-`$DFE0` in steps of `$20` (49 labels). Keep SIDs out of `$DE00-$DFFF` (UCI at `$DF1C`, REU at `$DF00`).
- `UltiSID Range Split` (shared by both UltiSIDs): `Off`, `1/2 (A5)`, `1/2 (A6)`, `1/2 (A7)`, `1/2 (A8)`, `1/4 (A5,A6)`, `1/4 (A5,A8)`, `1/4 (A7,A8)`. The split bits are cleared from the base, then every combination is a part. With UltiSID 1 `$D400` and UltiSID 2 `$D420`: A6 gives `$D400,$D440` / `$D420,$D460`; A7 `$D400,$D480` / `$D420,$D4A0`; A8 `$D400,$D500` / `$D420,$D520`; (A7,A8) the eight above. Splits that contain A5 make UltiSID 2 overlap UltiSID 1 at these addresses: do not use.
- `Ext DualSID Range Split` (sockets): `Off`, `A5` to `A9`; the bit is removed from both socket decoders and drives the chip's address-select line. A9 is the only choice that keeps the 10-SID map free of overlaps.
- Collisions: two decoders at one address both receive the write (both chips play); there is no priority.
- `Auto Address Mirroring`: after the split bits are removed, an address bit A5-A9 becomes "don't care" if all mapped decoders agree on it, so the map repeats. The 10-SID map repeats at plus `$200`; with both sockets `Unmapped` it repeats at plus `$40` and `$200`. `Disabled` leaves exactly the listed windows (device).
- Undecoded addresses in `$D400-$D7FF`: the maintainers' research on an Ultimate 64 Elite (fw 3.15) found that a 6510 access never completes (CPU stalls until reset) and a REST or DMA access hangs the Ultimate. Not tested on the C64U (needs a power cycle to recover): assume it hangs. Touch only mapped windows, never probe candidate addresses, and no REST `readmem` of the whole I/O area with a split map.
- The freezer (menu) writes `$D41F`, `$D43F`, `$D51F` when it returns: keep `$D400`, `$D420` and `$D500` windows decoded (the map above does).

## Mixer, pan and the audio stream

- Store `Audio Mixer`: ten channels; the SID ones are UltiSID 1, UltiSID 2, Socket 1, Socket 2 with `Vol <name>` and `Pan <name>`; `Vol Master`. Pan is `Left 5`..`Left 1`, `Center`, `Right 1`..`Right 5`. Defaults: UltiSIDs `Center`, Socket 1 `Left 3`, Socket 2 `Right 3`.
- All parts of an UltiSID share its volume and pan. Per-part level uses `$D418` of that part: linear, independent of every other part (device: volume 8 gives 0.53, 4 gives 0.27 of volume 15; others unchanged to within 1 percent). Amplitude panning between a left part and a right part works by the level ratio (device).
- Stereo separation (device): with `Pan UltiSID 1=Left 5` and `Pan UltiSID 2=Right 5` an UltiSID 1 part is absent on the right channel (more than 95 dB down) and an UltiSID 2 part on the left.
- The UDP audio stream (`PUT /v1/streams/audio:start`, 192 stereo S16 frames per packet, 47982.89 Hz PAL) is the final mixer output: all eight parts and both sockets, with their pan and volume (device). Use it to test sound from the host.
- Level (device, sawtooth, volume 15, mixer 0 dB): one voice about 0.24 of full scale on the loud side; 12 voices on one pan side about 0.92; 24 UltiSID voices clip. Keep the sum of (volume/15 times sustain/15) per pan side at or below about 10 for saw sounds.

## Run-time control from the C64

- UCI is off by default: `C64 and Cartridge Settings / Command Interface=Enabled` is required; read `$DF1D` for `$C9`. Registers `$DF1C-$DF1F` (see c64://ultimate/uci). The game cannot enable UCI itself.
- `LOAD_CONFIG` (target 4, command `$50`, message `04 50 <path> 00`) applies a `.cfg` and effectuates the changed stores at once while the program runs. Device: present in firmware 1.2.1; the path form `/Temp/name.cfg` worked for a file put there by FTP (a game writes it with the DOS target, or uses a file that exists). The reply data is the parse log; a store the device lacks gives `Line N: Store name '...' not found; section ignored.` and status `00,OK`.
- Example file (labels equal the REST names):

        [SID Addressing]
        Auto Address Mirroring=Disabled
        UltiSID Range Split=1/4 (A7,A8)
        UltiSID 1 Address=$D400
        UltiSID 2 Address=$D420
        SID Socket 1 Address=$D440
        SID Socket 2 Address=$D460
        Ext DualSID Range Split=Off
        [Audio Mixer]
        Pan UltiSID 1=Left 5
        Pan UltiSID 2=Right 5

- Registers cannot be written by the 6510; there is no UCI command to read a setting. A `.cfg` with the same name as a PRG, CRT or disk is applied when started from the file browser.
- Restore: no read command exists, so create a restore `.cfg` at install time from the host (`GET /v1/configs/SID Addressing`, `SID Sockets Configuration`, `UltiSID Configuration`, `Audio Mixer`) and `LOAD_CONFIG` it on exit, after silencing the chips (device: restores exactly the items in the file).
- Flash: changes live in RAM and are saved only by `configs:save_to_flash`, the menu's save, or "Save changes to Flash?" when the user leaves the configuration menu. The game's map can be saved by a later menu visit; a crash leaves it in RAM until reset or power cycle without a save (source; not verifiable without a reboot).
- Host tools: `PUT /v1/configs/<store>/<item>?value=...` (RAM only), `POST /v1/configs` for several items; `c64_config` does the same.

## Detection

- `GET_HWINFO` (command `$28`) device 0 returns the product string (device: `C64 Ultimate`); device 1 returns a count then 5 bytes per decoder: UltiSID 1, UltiSID 2, then each enabled socket. Entry: address low, address high, `$00`, `$00`, type (2, or 3 when the mask is not `$FE` (split or mirrored), plus 128, for UltiSIDs; 4 or 5 for sockets). Device: 10-SID map gives `04 00D4.. 20D4.. 40D4.. 60D4..`. Parts, second SIDs and the chip type are not listed. REST `SID Sockets Configuration` gives `SID Detected Socket 1/2` (None, 6581, 8580, ARMSID, ARM2SID, FPGASID, SwinSID Ultimate, PDsid, SIDKick ...) for a host installer.
- ENV3 test (device: 10 windows by 10, both from the 6510 and by REST, gives the identity matrix): silence all; at window i set voice 3 to triangle or saw at a high frequency, attack 0, sustain 15, gate on, volume 15; wait two frames; read `$1C` of every mapped window: window i gives `$FF`, all others `$00`. Close the gate afterwards. OSC3 `$1B` keeps changing after the gate closes and is not a presence test. Any other window that also reads `$FF` means an overlap: fall back to a smaller map.
- Test only mapped windows. Without UCI, play as one SID at `$D400`.
- Observation (device): REST `writemem` to the Socket 1 window was, in several runs with the audio stream running, also heard on Socket 2 (6510 writes were clean in the 10 by 10 test). Check both sockets' ENV3 before trusting REST-based sound tests.

## Differences in sound

- UltiSID: filter curve per UltiSID (`8580 Lo`, `8580 Hi`, `6581`, `6581 Alt`, `U2 Low`, `U2 Mid`, `U2 High`), `Filter Resonance` `Low`/`High`, `Combined Waveforms` `6581`/`8580`, `Digis Level`, set in store `UltiSID Configuration`; both UltiSIDs can differ. Use single waveforms and filters that sound right across curves.
- Sockets are real or emulated chips with their own filter, DC and noise; device: the two ARMSID differ by about ten times in master-volume click and by two times in the level of the same triangle.
- Master volume ($D418) steps click: one step about 900 units (UltiSID) to 1400 (ARMSID in one socket) of 32767, 0 to 15 about 0.4 to 0.6 of full scale on the loud side (device). Step volume by one at most, only on silent chips.
- Same-frequency unison on two chips: two UltiSID parts add to 0.71 of the sum for triangle, saw and pulse; an UltiSID against an ARMSID gave 0.32 (triangle), 0.74 (saw) and 0.99 (pulse), repeatably (device). Do not rely on unison for level; detune slightly. For width instead: the same 440 Hz tri/saw/pulse on voice 1 of four chips panned apart (Left 3, Center, Left 3, Right 3) gave a slowly moving, spacious beating field, judged atmospheric by ear (device): stereo movement without modulation.
- Not measured: ADSR delay bug on UltiSID and ARMSID, filter range of split parts, cost of socket writes (sockets sit behind the 1 MHz bridge, source). Plan for note starts up to two frames late.

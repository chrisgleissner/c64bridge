# C64 and SID music formats: survey for SIDWave import and export

Status: research, 2026-11-27. No code or repository was changed. Sources were cloned read-only into `~/.c64bridge/sidwave-standalone/research-src/` (one directory per repository) and read; nothing downloaded was executed. The only program built and run was `sidid.c` (BSD-3, from the local DeepSID checkout), compiled from source in the scratchpad.

Out of scope here because other work packages already cover them: Standard MIDI File, MusicXML, WAV and stems, JSON event export, GoatTracker 1.x and 2 (`.sng`), Furnace `.fur`. PSID/RSID read and write already exist.

## Summary

### Findings

1. **Almost all C64 music that exists is stored as `.sid` files containing a packed player and its data, not as editor project files.** In HVSC release 83 (59,886 tunes, local copy), SIDId identifies the player of 97.7 % of the tunes. The five largest players are DMC (17.9 %), GoatTracker 2 (12.3 %), Music Assembler (10.7 %), Future Composer (6.8 %) and JCH NewPlayer (6.1 %). SID Factory II, SID-Wizard, CheeseCutter and DefleMask together account for about 3.4 % of the tunes. HVSC share therefore favours import from `.sid` over import of native project files for all historic players. The HVSC shares are history, not current use: SID Factory II and SID-Wizard are the actively used editors today.
2. **There are three different kinds of import, with different cost and fidelity.**
   - Kind A: a native editor project file with a documented or source-defined layout (SID-Wizard `.swm`, SID Factory II `.sf2`, CheeseCutter `.ct`, DefleMask `.dmf`, Sidplayer `.mus`). Static parsing, exact for what the SIDWave language can express.
   - Kind B: a `.sid` whose player is recognised and whose tables can be located (DMC, Music Assembler, Future Composer, JCH NewPlayer, Soundmonitor). Needs a per-player and often per-build parser. The init routine usually has to run in a 6502 emulator to find the real addresses.
   - Kind C: the register trace of any tune. This is the existing S5 reconstruction pipeline, approximate by construction.
   Recommendation: kind C is the baseline for every historic player. Kind B lifts are added only where they recover pattern and order-list structure that the trace reconstruction cannot recover reliably, and only for the top players.
3. **Export (writing a file that the original tool loads) is only realistic for the four actively maintained or open tools: SID-Wizard, SID Factory II, CheeseCutter and (spec only) DefleMask, plus Sidplayer MUS.** Their players ship with the project (SF2 driver `.prg` files, SID-Wizard 64tass source, CheeseCutter ACME player source), so the exported file can be verified at ladder level T0/T1 by running the shipped player on the export and comparing register traces with the SIDWave compile of the same score. None of the closed historic editors (DMC, Music Assembler, JCH Editor, Soundmonitor, Future Composer, Voicetracker, Rock Monitor, Odin) can be driven headless; their player code is not redistributable, so export is rejected for them.
4. **Format-level answers to the specific questions.**
   - VGM does not support SID. Spec v1.71 text contains no SID or MOS 6581 chip (grepped); the chip list in libvgm has no SID device. VGM Rips lists the 6581/8580 as unsupported chips, with the existing `.sid` format given as the reason (read only through a search-result snippet, because the page blocked automated fetches).
   - ChiptuneSAK has no `.ksid` format. Its formats are PSID import, MIDI, GoatTracker 2, ML64 (Unknown Realm text format), LilyPond, C128 BASIC, and its internal "chirp" / "mchirp" / "rchirp" representations. Last commit 2022-01-24, MIT.
   - VICE `-sounddev dump` writes one text line per SID write, `"%d %d %d\n"` (cycle delta, register address, value) (read from `sounddump.c`). desidulate parses exactly this.
   - `.vsf` is a whole-machine snapshot, not a music format.
   - There is no canonical MML dialect for the C64. The only C64-capable MML compiler found is XPMCK (stale since 2016/2019); gakuon says in its README that it does not work.

### Recommended work packages (details in the last section)

| WP | Content | Direction | Expected fidelity | Size |
|---|---|---|---|---|
| W1 | VICE register dump and siddump text tables as inputs to S5; VICE-dump text as an export | import (trace), export | exact (VICE dump), approximate (siddump) | S |
| W2 | SID-Wizard `.swm` / `.swi` / `.sws` | import and export | exact for the expressible subset | M |
| W3 | SID Factory II `.sf2`, driver 11.xx first, then 11.05 multi-SID, 12 to 16, NP20 | import and export | exact for driver 11, approximate for others | L |
| W4 | CheeseCutter 2.x `.ct` | import and export | exact for the expressible subset | M |
| W5 | Kind B lifts from `.sid`: DMC, Music Assembler, Future Composer, JCH NewPlayer, Soundmonitor | import only | exact where the build is recognised, else fall back to kind C | XL (one player at a time) |
| W6 | DefleMask `.dmf` (C64 systems) | import and export | exact for the SID-specific data, approximate for FM-style macros | M |
| W7 | Sidplayer `.mus` / `.str` (Compute's) | import and export | export approximate (subset), import exact | S |
| W8 | MOD / XM / IT import | import only | lossy | M |
| W9 | Small text outputs: BASIC DATA, assembler source include, ABC import | mixed | exact (BASIC, assembler), approximate (ABC) | S each |

Rejected: DMC / Music Assembler / Future Composer / JCH / Soundmonitor / Voicetracker / Rock Monitor export; VGM; VSF; SidTracker64 native format; Mssiah / Prophet64; MML as a first-class format; MOD/XM export; LilyPond; CheeseCutter 3. Reasons are in the table at the end.

### Open items

1. **Licence of reused material (needs a decision before W3 and W4).** SID Factory II (`COPYING` is GPL v2 text; no per-file "or later" notice found; GitHub shows no SPDX licence) and CheeseCutter (GPL-2.0) may be GPL-2.0-only. SIDWave is GPL-2.0-or-later with a Player Exception. Copying code from either would pin the combined work to GPL-2.0-only. Plan: implement from the format as read in source (clean-room style, no copied code). The SF2 driver `.prg` files and the CheeseCutter player are GPL-2 binaries or source that would be embedded in exported `.sf2` / `.ct` files. Whether that fits the Player Exception wording must be checked.
2. **Which SID Factory II drivers to support, and whether SF2 file layout can be recovered from source alone.** There is no standalone `.sf2` specification in the repository (only `driver_info.h/.cpp` and `user_manual.pdf`, which I did not read). Driver assembly sources are not in the main repository (`sf2driver11_05_multisid.a` is mentioned in `DEVELOPMENT.md` but is not present). Ask the maintainer (Chordian) or look at the driver repositories before committing to W3 beyond driver 11.
3. **SIDWave language extensions** (to confirm against the current language spec, which I only skimmed): free tuning / exact frequency values; groove (funk) tempo and per-row tempo programs (SID-Wizard, SF2, CheeseCutter all have them); per-instrument vibrato and pulse programs in a shared table form; digi sample playback via `$D418` (the compiler README lists CIA2 `samples:` as not supported in a PRG build); more than 3 voices per SID file for 4-channel MOD and XM material (voice reduction policy, not a language change). Details per format below.
4. **Accuracy claims of the anarkiwi parser family are unverified.** See "Prior art that cannot be taken at face value".
5. **Not verified:** see the last section.

## Evidence base and method

- HVSC: local `C64Music` release 83, 59,886 `.sid` files. I compiled `sidid.c` (V1.09, Cadaver, BSD-3) from `~/dev/c64/sid/deepsid/utility/sidid_100/` and ran it with that directory's `sidid.cfg` (2,249 lines) over the collection. SIDId reports the first matching signature in file order; players listed in parentheses in `sidid.nfo` have no signature (for example Voicetracker, Rock Monitor), so they are counted under the player whose code they use or as unidentified. Result: 59,886 files, 1,367 unidentified (2.28 %), 618 distinct labels.
- Independent cross-check: `anarkiwi/hvsc-tracker-catalog` (commit 2026-11-02, Apache-2.0) ran SIDId (its own Python port) over a newer HVSC (61,157 files) and reports 97.8 % identified, 647 players, and source availability per player. Its counts agree with mine within about 1 %.
- Format facts come from source code or documents in the repositories listed per section. Where only a search snippet or a summarising fetch was available, the text says so.
- SIDId caveat: signatures are byte patterns of player code. Counts measure the player, not the editor. A tune made with SID Factory II is counted as "SidFactory_II/Laxity" only when it uses a Laxity-derived driver. Counts for loose signatures (DMC in particular) may include tunes that other players would also match; first match wins.

## Popularity: HVSC players by tune count (release 83)

| Rank | SIDId label | Tunes | Share | Editor or format source |
|---:|---|---:|---:|---|
| 1 | DMC (Demo Music Creator, Brian / Graffity, 1991) | 10,710 | 17.9 % | editor binary only |
| 2 | GoatTracker 2.x | 7,362 | 12.3 % | out of scope (in progress) |
| 3 | Music Assembler (Dutch USA-Team, 1989; Triad fixes 1991-94) | 6,388 | 10.7 % | binary only |
| 4 | MoN / Future Composer (player Charles Deenen, editor Juha Granberg) | 4,069 | 6.8 % | editor binary; player reverse-engineered in `realdmx/c64_6581_sid_players` (MIT) |
| 5 | JCH NewPlayer (many versions) | 3,676 | 6.1 % | editor binary |
| 6 | Soundmonitor (Chris Hülsbeck, 64'er Oct 1986) | 3,494 | 5.8 % | magazine type-in listing |
| 7 | GoatTracker 1.x | 1,384 | 2.3 % | out of scope |
| 8 | unidentified | 1,367 | 2.3 % | |
| 9 | HardTrack Composer | 1,169 | 2.0 % | binary only |
| 10 | Master Composer (Paul Kleimeyer) | 1,075 | 1.8 % | binary only |
| 11 | SID-Wizard 1.x (Hermit) | 1,030 | 1.7 % | source, WTF licence |
| 12 | SID Duzz'It (Geir Tjelta, GRG) | 979 | 1.6 % | binary only |
| 13 | SoedeSoft | 948 | 1.6 % | binary only |
| 14 | Digitalizer 2.x (digi) | 680 | 1.1 % | |
| 15 | RoMuzak 6.x | 591 | 1.0 % | |
| 16 | BASIC program | 520 | 0.9 % | |
| 17 | GMC / Superiors (Brian) | 441 | 0.7 % | |
| 18 | X-Ample | 387 | 0.6 % | |
| 19 | SidFactory II / Laxity | 338 | 0.6 % | open source (GPL v2) |
| 20 | CheeseCutter 2.x | 304 | 0.5 % | open source (GPL) |
| 21 | Laxity NewPlayer V21 | 302 | 0.5 % | |
| 22 | Loadstar Songsmith | 300 | 0.5 % | |
| 23 | Electrosound | 295 | 0.5 % | |
| 24 | Ubik's Musik | 292 | 0.5 % | |
| 25 | Rob Hubbard (composer routine) | 288 | 0.5 % | RE source (MIT) |

Further labels relevant to the question: SidTracker64 257 (0.43 %, iOS, closed); DefleMask v1.2 237 + v2 72 + v1 1 = 310 (0.52 %, closed, spec public); OdinTracker 163 (source zip, no licence stated); DefMon 107 (binary only); NinjaTracker 2.x 95 + 1.x 18; JCH Protracker 94; JCH OldPlayer 32; SidWinder 113; Sidplayer 14; Cyberlogic SoundStudio 197; Music Shop 182; Reflextracker 137; Vibrants/Laxity editor 179; Music Processor 65; Music Construction Set 19. Cumulative: top 5 = 53.8 %, top 6 = 59.6 %, top 25 = 80.8 %.

Current-use evidence (not HVSC): GitHub stars, 2026-11-27: SID Factory II 188 (pushed 2026-11-26; release 20260314 has 231 asset downloads on GitHub, which undercounts the author's blog downloads), CheeseCutter 158 (pushed 2026-03-29, SDL2 port merged 2026/3), libsidplayfp 111, leafo/goattracker2 56, siddump 51, XPMCK fork 27, ChiptuneSAK 22, desidulate 19, SID-Wizard fork 5 (the canonical SID-Wizard source is on SourceForge: 1.7 listed 2021-01-02, the source tree reads as 1.97). Star counts are weak evidence of use.

## Formats and tools

For each: what it is, popularity, spec and licence, import, export, verification, risks.

### SID Factory II (`.sf2`)

- **What.** Cross-platform editor (Chordian, with Laxity and JCH), reSID based, build 20231002 made driver 11.05 the default. An `.sf2` file is a C64 memory image (PRG with load address) holding a 6502 driver and the music data at driver-defined addresses. The first word at the top address must be `0x1337`; header blocks follow (descriptor, driver common addresses, tables with types and layouts, instrument descriptor, music data pointers, table colour / insert-delete / action rules, instrument data descriptor). Editor-only data (comments, hardware preferences, stereo panning) is reached through a pointer at `$0FFB` (`driver_info.h`, `driver_info.cpp`).
- **Drivers in the repository** (`SIDFactoryII/drivers/`): 11.00, 11.01, 11.02, 11.03, 11.04, 11.04.01, 11.05, 11.05 2/3/4-SID, 12.00 "The Barber", 12.00.01, 13.00 "The Hubbard Experience" (emulates Rob Hubbard), 13.00.01, 14.00 "The Experiment", 14.00.01, 15.00 / 15.01 / 15.02 "Tiny mark I", 16.00 / 16.01 / 16.01.01 "Tiny mark II", and `sf2driver_np20_00` (JCH NewPlayer 20). Per-driver notes: `dist/documentation/notes_driver11..16.txt` list instrument bytes, command set, wave-table encoding and known bugs. Driver 11.05: instruments have AD, SR, flags (hard restart, filter, oscillator reset, pulse reset skip, HR table index), filter / pulse / wave table indexes; commands slide, vibrato, portamento, arpeggio, ADSR, filter, wave, pulse, tempo programs, main volume, note delay; HR table of 8 rows.
- **Popularity.** 338 + 40 HVSC tunes (Laxity-derived), the most active new-tune tracker with source; no HVSC-wide share yet. Community conversions of its source tunes are the main use.
- **Licence.** `SIDFactoryII/COPYING` is GPL v2; no per-file notice seen. The embedded USBSID-Pico driver is GPL-3.0-or-later (`DEVELOPMENT.md`).
- **Spec.** No standalone specification. The loader source and the driver notes are the specification. The editor reads `.sf2`, converts MOD, GoatTracker 2 `.sng`, CheeseCutter `.ct` and JCH `NP20.gX` (a 64 KB memory image, loaded with `sf2driver_np20_00.prg`) through its F10 converter (`dist/documentation/converter.txt`; GT conversion cannot represent several GT features, listed there), and exports `.sid` / `.prg` with a packer (`packer.cpp`) and SID v5 headers.
- **Import.** Static parse of the header blocks, order lists, sequences and tables gives the song as the driver sees it. The meaning of each table byte is driver-specific, so each driver needs a small decoder. Driver 11.xx has the fullest documentation. Exact for notes, durations, instruments and table programs that SIDWave can express; commands without a SIDWave equivalent (fret slide, `Tf` demo value) are reported.
- **Export.** Possible by choosing driver 11.05 (or a later 11.x), writing the driver image unchanged and filling tables and sequences; the editor then loads and plays the file. SIDWave features beyond the driver's command set need a mapping table with losses stated (for example sync/ring beyond what instrument flags express).
- **Verification.** No headless mode in the editor (SDL GUI; `xvfb-run` exists locally but there is no scriptable export). The shipped driver binary is the oracle: run its init and update routines on the exported image (same approach the editor uses in `DriverUtils::GetSongLengthInMilliseconds`) and compare register traces with the SIDWave compile at T0/T1, and F-diff for any residual difference. Cross-check imports against the HVSC tunes that SF2 exported.
- **Risks.** Driver-specific semantics and the licence question above. Many pointers inside the image: parser must range-check every pointer and every table index. Multiple SIDs: SID n at `$D400 + n * $20` in the multi-SID drivers.
- **Language extensions.** Per-row tempo tables are present in the driver 11 tempo table; groove can be expressed there. Hard-restart tables per instrument.

### SID-Wizard (`.swm`, `.swi`, `.sws`, `.swp`)

- **What.** Native C64 tracker by Hermit Software (Mihaly Horvath). Files: `.swm` module, `.swi` instrument, `.sws` stereo module, `.swp` packed player data with relative pointers, `.swt`. SID-Wizard 1.7 is listed on SourceForge (2021); the source tree (`anarkiwi/sid-wizard`, a port of 1.97) carries 1.9 manuals.
- **Popularity.** 1,030 HVSC tunes (1.7 %) plus 27 from 1RasterTracker (same author).
- **Licence.** `README.txt`: "WTF-licensed", SourceForge: Public Domain. Free to read and reuse; no copyleft problem.
- **Spec.** `native/sources/SWM-spec.src` is a machine-readable specification used by both the 64tass and the C sources: header of 64 bytes starting `SWM1`, frame speed, mute switches, counts of sequences / patterns / instruments / chords / tempo programs, driver type, tuning type (440 Hz, 432 Hz, just intonation), author field; then sequences (order lists), patterns, instruments (fixed 16 bytes plus tables), chord table, tempo table. Limits: 8 subtunes, 100 patterns, 37 instruments, chords of up to 32 bytes. `SWMconvert.c` (C, same repository) converts SWM to and from XM and MIDI, SWM to SWS, and `swm2sng` / `sng2swm` convert to and from GoatTracker 2. The module format is documented as compatible across versions.
- **Import.** Static, exact for what the language expresses. Funk tempo, chords and legato commands need mappings.
- **Export.** Writing an `.swm` is practical because the spec and a working writer (`pysidwizard`, Apache-2.0, claims byte-exact round trip; unverified by me) exist. SID-Wizard itself runs only on a C64 (or VICE).
- **Verification.** The SID-Maker / SWP player sources (64tass) are in the repository; building them needs 64tass and the repository's tooling (not tested here). Run the player on the export in SIDWave's engine and compare at T0/T1. `SWMconvert` (C, builds on Linux) gives a second, independent XM/MIDI view of the same module. Headless SID-Wizard under VICE is possible (`anarkiwi/sidwizard-driver` exists; not examined).
- **Risks.** The format limits (37 instruments, 100 patterns) force splitting or refusal for larger scores. 4-SID variants and stereo `.sws`.
- **Desidulate** can export SID-Wizard instruments (`ssf2swi.py`) from a register dump, which can serve as an independent instrument-level check of `.swi` handling.

### CheeseCutter (`.ct`)

- **What.** D-language editor by Abaddon (Timo Taipalus), version 2; GPL (`theyamo/CheeseCutter`). 2.x is still maintained (SDL2 port merged 2026-03). CheeseCutter 3 (`codeberg.org/tta/cheesecutter3`) is unfinished: "many things unfinished", no export, zipped-JSON save format; not a target.
- **Popularity.** 304 HVSC tunes (0.5 %).
- **File format.** `CC2` magic followed by a zlib stream. The inflated data is a 64 KB C64 memory image with the player at `$0DFE`, then trailing fields (version, clock, multiplier, SID model, speeds for 32 subtunes, highlight, title / author / release, instrument labels). `Song.open` in `src/ct/base.d` refuses versions below 6 and stereo files (version 128 and above), and caps the inflated size at 167,832 bytes. There is no prose specification; `base.d` is the specification.
- **Tools.** `ct2util` (man page `doc/ct2util.1`): `prg` and `sid` export with relocation (`-r`), default subtune, single-subtune export, zero-page relocation; `dump` to assembler source (beta); `import` data from another song without overwriting the player; `init` a new `.ct` from a player binary. The D toolchain is needed to build it (`ldc2` / `dmd` not installed locally).
- **Import.** Static. Sequences are rows of 4-byte events; 0xBF ends a sequence; instruments, wave / pulse / filter tables, chord table. Exact for the expressible subset. SF2's converter drops A/D/S/R sequence commands and imports only the subtune that was in focus; SIDWave should import all subtunes.
- **Export.** Possible via `ct2util init` semantics: take the shipped player image and fill the data areas.
- **Verification.** Best of the four: `ct2util sid` / `prg` headless on Linux produces the editor's own packed output. Differential test: SIDWave score, export `.ct`, `ct2util sid`, compare register traces with the SIDWave compile at T0/T1. Requires building `ct2util` locally (not done here).
- **Risks.** Zlib decompression bomb: enforce the same output cap as the original and a ratio limit. Player version differences (`ver`). GPL-2.0 (possibly only): do not copy code.

### JCH NewPlayer and JCH Editor

- **What.** Jens-Christian Huus's player family and editor. 3,676 HVSC tunes for NewPlayer plus 94 JCH Protracker and 32 OldPlayer. The editor is binary-only (csdb 14037). The editor workfile is a 64 KB image named `NP20.gX` (as consumed by SF2's converter, `converter_jch.cpp`), which is the one JCH file format with a known public consumer.
- **Versions.** The HVSC population spans at least V0x, V1 to V20 builds (`anarkiwi/pyjch`, `docs/versions.md`, which says about 2,000 tunes belong to the "wavetable family" and that V20 is the largest bucket; I did not verify these counts).
- **Import.** Kind B from `.sid`: per-version table location by code idiom. Not static from the header alone; relocation and packing occur. SF2's NP20 driver and converter show the V20 data layout is public in source form (converter reads it); that part is GPL-2.
- **Export.** Reject for JCH Editor files (no spec, no headless tool, player not redistributable). Indirectly available: SF2 `sf2driver_np20_00` is a JCH NP20 driver, so W3 can target it for a JCH-style player.
- **Verification.** Differential against the tune's own player run in the 6502 emulator (T0).

### DMC (Demo Music Creator) and GMC

- **What.** DMC, Balazs Farkas (Brian) / Graffity, 1991, the most common HVSC player (10,710 tunes, 17.9 %), with GMC (Game Music Creator, same author, 441). DMC V4 and V6 variants exist (15 tunes SIDId labels as V6).
- **Spec and licence.** None published. Editor binary only; `anarkiwi/pydmcsid` (Apache-2.0, last pushed 2026-11-23) reads `.sid` / `.prg` by locating table bases from player-code operands and says it reproduces the player frame for frame (`song.byte_exact()`); unverified by me.
- **Import.** Kind B, plus kind C fallback. Highest value: largest share of any single player.
- **Export.** Reject: closed editor and player, no headless tool.
- **Risks.** Many builds and relocations; DMC player variants share a loose signature.

### Music Assembler, Voicetracker, Rock Monitor

- **What.** Music Assembler (MC and OPM, Dutch USA-Team, V1.0 February 1989, Triad fixes V1.1-V1.4 1991-94): 6,388 tunes, 10.7 %. Voicetracker (Polonus, 1991) is an editor on the Music Assembler player (`sidid.nfo`); Rock Monitor V2 to V5 (OPM, 1987-88) are earlier players by the same author (listed in `sidid.nfo` without signatures, so their tunes are not counted separately).
- **Native files.** The editor saves `S.` song and `P.` preset files; `anarkiwi/pymusicassembler` claims read, write and apply for both, and a Lark grammar of what the player reads (Apache-2.0). Unverified by me.
- **Import.** Kind B; the largest remaining structured population after DMC.
- **Export.** Reject for `S.` files initially: loading one in the real editor needs a C64 and the closed program; no headless check.

### Future Composer (C64: MoN / Deenen player, FCS editor)

- 4,069 tunes (6.8 %). Do not confuse with Amiga Future Composer (`.fc`), which is a different player and format. The C64 editor is binary only; the player has a reverse-engineered MIT-licensed source in `realdmx/c64_6581_sid_players` (last push 2023-06-24). `anarkiwi/pyfuturecomposer` finds table addresses from player operands per build.
- Import: kind B. Export: reject.

### Soundmonitor (Chris Hülsbeck)

- 3,494 tunes (5.8 %). Published as a type-in listing in 64'er, October 1986 (csdb 59929); the player is relocatable and recognised by a register fingerprint. Source is the magazine listing, so a clean spec can be derived from it, but the listing was not read here.
- Import: kind B. Export: reject (no headless check; low value).

### Other trackers named in the request

| Tool | HVSC tunes | Verified state | Import | Export |
|---|---:|---|---|---|
| NinjaTracker 2.04 (Cadaver) | 95 (+18 for 1.x) | Release zip `ninjatr204.zip` (downloaded to `research-src/dl-ninjatr204/`, read only) bundles editor and player source in DASM; readme says "Customization is allowed and encouraged", no licence text. `gt2nt2` converts GoatTracker 2 songs to it. The saved song layout is the editor's memory layout in `src/`. | later (native file, small) | reject (no headless oracle, tiny audience) |
| Odin Tracker 1.13 (Zed, 2000-01) | 163 | Full source zip on zimmers.net (`OdinTracker113src.zip`, read only), DASM, no licence stated. | via `.sid` only | reject |
| SidWinder (Taki) | 113 | Source zip on zimmers.net; unread. | via `.sid` only | reject |
| defMON | 107 | Binary only; `anarkiwi/pydefmon` (Apache-2.0) reads and writes. | via `.sid` only | reject |
| SidTracker64 (iOS, Pernod) | 257 | Closed, no public format documentation. | via `.sid` only | reject |
| Cyberlogic Sound Studio, Reflextracker, Music Shop, Vibrants/Laxity editor, Master Composer, HardTrack, SID Duzz'It, X-Ample, SoedeSoft | 65 to 1,169 each | Binary only. | kind C only | reject |
| Mssiah, Prophet64 | 42, 4 | Hardware / commercial. | via `.sid` only | reject |
| Hively / AHX | not C64 | excluded by the brief | | |

### DefleMask (`.dmf`) with C64 systems

- **What.** Commercial multi-system tracker (Delek); closed source. HVSC identifies 310 tunes by its exported player. The DMF specification is public (`https://www.deflemask.com/DMF_SPECS.txt`, 6.6 KB, read): a zlib-compressed stream starting `.DelekDefleMask.`, file version 24 for DefleMask v1.0.0; systems byte 0x07 is C64 (SID 8580) and 0x47 C64 (SID 6581), 3 channels; per-instrument C64 data: waveform enables, ADSR, pulse width, ring, sync, plus the generic macro blocks; pattern rows; samples.
- **Licence.** None stated for the spec document.
- **Import.** Static, exact for SID-specific fields, approximate for generic macro features (volume, arpeggio, duty and wavetable macros; note effects) depending on SIDWave's language. Verify newer file versions: the spec I read is for v24; later DefleMask releases may write newer versions (not verified).
- **Export.** Possible from the spec.
- **Verification.** The editor cannot be driven headless (not verified whether a Linux build exists). Furnace imports `.dmf` and has a C64 chip, so a `.dmf` written by SIDWave could be loaded in Furnace and rendered; Furnace's SID emulation and driver are not libsidplayfp, so this would be an approximate cross-check. Not tested.
- **Risks.** zlib bomb; every count field in the stream is untrusted.

### Compute!'s Sidplayer (`.mus`, `.str`, `.wds`)

- **What.** 1984-85 SID music system from Compute!'s Music System for the C64 and C128 (Craig Chamberlain). Voice data for three voices; stereo uses a second `.str` file. 14 HVSC tunes use a Sidplayer player by SIDId; the PSID header has an explicit flag (bit 0 of `flags`: "Compute!'s Sidplayer MUS data, music player must be merged", from `DOCUMENTS/SID_file_format.txt`), and libsidplayfp loads `.mus` and `.str` natively with embedded players (`src/sidtune/MUS.cpp`, `sidplayer1.a65`, `sidplayer2.a65`, GPL-2.0 or later).
- **Spec.** The only layout found is `https://ist.uwaterloo.ca/~schepers/formats/SIDPLAY.TXT`: load address, three 2-byte lengths, then per voice a stream of two-byte commands ended by `01 4F`, then up to 5 text lines of 32 characters ended by `00`. That document does not describe note, duration or command encoding. The type-in listing (All About the Commodore 64 Vol. 2) and the player source in libsidplayfp are the real specification; I did not read the listing.
- **Import and export.** Small format, exact on import. Export is approximate: the player supports a fixed set of waveform instruments and no tables.
- **Verification.** Strong: libsidplayfp plays the file with its own MUS player. SIDWave already uses libsidplayfp, so the trace is a T0 oracle.
- **Risks.** Low. Lyrics (`.wds`) are text and can be ignored with a warning.

### MOD / XM / IT

- **Paths seen.** SF2's built-in MOD converter (4 to 3 channels, selectable dropped channel, arpeggio / slide / vibrato mapped, instruments mapped to a triangle wave only); SID-Wizard `SWMconvert` (XM and MIDI both directions, with "wave-arp" tables written as samples in XM export); ChiptuneSAK lists MOD as proposed.
- **Spec.** MOD, XM, IT are documented. libopenmpt is the usual implementation (BSD-3-Clause; licence line not re-verified here). The common failing is samples: a C64 has three voices and no sampled instruments.
- **Fidelity.** Lossy. Import should produce a voice allocation report and a note-only score.

### Text, dump and data representations

| Representation | Verified state | Verdict |
|---|---|---|
| siddump (Cadaver, V1.11, BSD-3) text table | Runs the SID's init and play code on its own 6502 core and prints per frame: frame number or time, per voice frequency (hex), note name with absolute note value, waveform, ADSR, pulse (hex), then filter cutoff, control, type, volume; optional CPU-cycle and raster columns. Values are printed only when they change, notes are derived from frequency, and the frame is the unit. The writes inside a frame, the hard-restart order and sub-frame timing are lost. | Import to S5 as an approximate trace; not an export target. |
| VICE `-sounddev dump` | `"%d %d %d\n"`: clock delta, register, value (`sounddump.c`); a machine state line is written at the start. | Exact register-write trace. Import for S5; export for use with desidulate. |
| desidulate (Josh Bailey, MIT) | Consumes the VICE dump; transcribes SID Sound Fragments (per gate-on events) into Pandas frames, MIDI and WAV, and SID-Wizard `.swi`. Last push 2026-05-19. Output is analysis data, not an interchange format. | Use as a comparison tool. |
| ChiptuneSAK (MIT) | Python, alpha, last commit 2022-01-24. No `.ksid`. Importers: MIDI, PSID/some RSID, GoatTracker 2 and stereo. Exporters: MIDI, LilyPond, C128 BASIC, GoatTracker 2 and stereo, ML64. Documentation on readthedocs. | Do not depend on it. |
| ML64 | Unknown Realm "bard tier" text format. Defined in ChiptuneSAK (`ml64.py`). | Reject: single-project format. |
| BASIC DATA statements | HVSC counts 520 tunes whose player is a BASIC program (0.9 %), Jim Butterfield style programs 48. ChiptuneSAK exports a C128 BASIC music program. | Export only (W9). No import: arbitrary BASIC. |
| Assembler source (KickAssembler / ACME / 64tass) | No convention exists for music data beyond a PSID header and `.binary` includes of a `.sid` (a 64tass example skips the header with offset `$7E`). `ct2util dump` writes assembler source (beta). I did not verify whether KickAssembler can write PSID files directly. | Export an include file of player and tables as optional. No import. |
| MML | XPMCK (Mic; fork by bazz1tv; last pushes 2016 and 2019) has C64 as one target, Euphoria-based compiler. gakuon: pre-alpha, "doesn't work". mmml, MMLlib and others are not C64. No shared dialect. | Reject as a first-class format. |
| ABC notation | Standard v2.1 (December 2011, Chris Walshaw) defines tunes, voices (`V:`), decorations, file structure. Licence of the text not stated on the page. A multi-voice ABC to SIDWave import is straightforward; pitch and rhythm only. | Low priority import (W9). |
| VGM | v1.71 text has no SID; VGM Rips lists the 6581 / 8580 as unsupported (snippet only). | Reject. |
| VICE `.vsf` | Whole-machine snapshot; SID registers are one module. | Reject. |
| ASID (MIDI SysEx stream of SID writes) | Used live by SF2 (`Playback.ASID.*` options) and Vessel. A transport, not a file. | Optional live output later; out of scope here. |
| SID dumps from sidplayfp / `sidtrace` | `anarkiwi/sidtrace` (instrumented sidplayfp, no licence tag) is used as an oracle by the parser family. | Equivalent to SIDWave's own trace. |

## Prior art that cannot be taken at face value

`anarkiwi` (Josh Bailey) published a family of Apache-2.0 Python packages in November 2026: `pysidtracker` (shared base with a 6502 emulator and a "playspec" player), `pygoattracker`, `pysidwizard`, `pydmcsid`, `pymusicassembler`, `pyfuturecomposer`, `pyjch`, `pysoundmonitor`, `pydefmon`, `unitracker` (a player-agnostic tracker document with lifters for GoatTracker 2, SID-Wizard, defMON and Music Assembler), `unitracker-player`, `hvsc-tracker-catalog` and `sidtrace`. They claim frame-exact register output against a sidplayfp oracle on HVSC tunes. This is the closest existing work to W5. It matters in three ways:

- It shows that Kind B lifts have been done for exactly the top historic players, and gives the per-build addressing method (find table addresses from operands of the player code, run init in a 6502 emulator, do not trust the container header).
- Its test methodology (compare against a sidplayfp trace) matches the SIDWave verification ladder, so its code can serve as an independent reference for differential tests.
- I did not run any of it, and all of it is under two months old, with one maintainer. Treat its accuracy claims as hypotheses. Do not make SIDWave depend on it; use it as a comparison tool or learn from its documents (`docs/format.md` in each package).

## Verification strategy per class

- **Imports of files from the tool itself (W2, W3, W4, W6, W7).** Import the file, compile with SIDWave, trace; compare with the trace of the tool's own player running on the original file. Level T0 where SIDWave's player can reproduce the call structure, otherwise T1 with a stated tolerance, plus F-diff for diagnosis. For W2 to W4 the player is available in source or as a shipped binary, so the reference trace needs no GUI.
- **Imports from `.sid` (W5).** The reference is the `.sid` itself on libsidplayfp. Report a per-tune verdict; a valid failing tune stays a failure.
- **Exports (W2, W3, W4, W6, W7).** Export, then run the original player on the export and compare with the SIDWave compile of the same score. For CheeseCutter additionally run `ct2util sid` and compare. For SF2 and SID-Wizard, loading in the real editor is a manual smoke test only.
- **Round trips.** Import then export then import must keep notes, instruments and tables for the expressible subset.
- **Tool availability on Linux, headless.** CheeseCutter `ct2util` yes (needs a D compiler, not installed here). SF2 editor: SDL GUI only, headless needs Xvfb (installed) and a way to drive it; no CLI export seen. SID-Wizard: C64 program; `SWMconvert` is a Linux C program; building the player needs 64tass. DefleMask: unknown. Sidplayer: libsidplayfp.

## Risks

- **Untrusted input.** Compression: `.ct` (zlib, cap 167,832 bytes), `.dmf` (zlib), `.fur` (zlib). Cap inflated size, ratio and time. Every pointer, index and count in `.sf2`, `.swm`, `.ct`, `.dmf` must be range-checked; limits are defined in the sources (SWM spec constants, `MAX_SEQ_NUM`, `TRACK_LIST_LENGTH`). Kind B lifts execute 6502 code from the input: bounded cycle budget, no host I/O, deterministic engine; the existing SIDLite engine fits. Header fields of `.sid` files are not trustworthy (PSID spec and the parser family both say so).
- **Licences.** SF2 and CheeseCutter: GPL-2 (see open item 1). SID-Wizard: WTF / public domain. siddump and SIDId: BSD-3 with attribution. libsidplayfp: GPL-2+. anarkiwi packages: Apache-2.0 (GPL-2+ compatible only one way: Apache-2.0 into GPL-3, not into GPL-2-only code). Closed players (DMC, Music Assembler, Future Composer, JCH, Soundmonitor): never embed their code in exports.
- **Scope creep.** Each Kind B lift is a reverse-engineering task per player build. A fixed time budget and a stop rule (fall back to kind C) are needed.

## Recommendation

### Import, in priority order

1. **W1 (S).** VICE dump and siddump parsers feeding the S5 pipeline. Cheap, enables comparison with desidulate and other tools.
2. **W2 SID-Wizard (M).** Best-specified native format, free licence, player source for verification.
3. **W3 SID Factory II (L).** Most active tracker today; drivers 11.xx first. Gate on open items 1 and 2.
4. **W4 CheeseCutter (M).** Best headless oracle (`ct2util`). Could precede W3 if its verification is more important than its current popularity.
5. **W5 Kind B lifts (XL).** Order by share and ease: Music Assembler (10.7 %), DMC (17.9 %), Future Composer (6.8 %), JCH NewPlayer V20 first (6.1 % overall), Soundmonitor (5.8 %). Each player is a separate pull request with its own verdict table; the fallback is kind C. Then, if wanted: HardTrack Composer, Master Composer, SID Duzz'It, SoedeSoft (each 1.6 % to 2.0 %).
6. **W7 Sidplayer (S)** and **W6 DefleMask (M)**: small, specified, verification partly available.
7. **W8 MOD/XM/IT (M)** and **ABC (S)**: lossy, low priority.

### Export, in priority order

1. W2 SID-Wizard (exact for the expressible subset).
2. W3 SID Factory II, driver 11.05 first, then multi-SID, then the other drivers as demand shows.
3. W4 CheeseCutter.
4. W6 DefleMask, W7 Sidplayer (approximate).
5. W9: BASIC DATA listing, assembler include file, VICE dump text.

### Expectation per format

| Format | Import | Export |
|---|---|---|
| VICE dump | exact (register writes) | exact |
| siddump | approximate (per frame, changes only) | not offered |
| SID-Wizard `.swm` | exact | exact for expressible subset; limits 37 instruments, 100 patterns, 8 subtunes |
| SF2 `.sf2` driver 11 | exact | exact for expressible subset; approximate for features outside the driver's command set |
| SF2 other drivers | approximate to exact, per driver | later |
| CheeseCutter `.ct` | exact | exact for expressible subset |
| DMC, Music Assembler, Future Composer, JCH, Soundmonitor via `.sid` | exact where the build is recognised, else approximate (kind C) | rejected |
| DefleMask `.dmf` | exact for SID fields, approximate otherwise | approximate |
| Sidplayer `.mus` | exact | approximate |
| MOD / XM / IT | lossy | rejected |
| ABC | approximate (pitch and rhythm) | rejected |

### Needing SIDWave language extensions (to confirm against the language spec)

- Free tuning and exact frequency values (432 Hz and just intonation in SID-Wizard; S5 already lists this).
- Groove / funk tempo and tempo programs that change per row (SID-Wizard tempo programs, SF2 tempo table, CheeseCutter speeds).
- Per-instrument chord (arpeggio) tables with speed, if not already covered by arp tables.
- Digi playback (DMC and many older players use `$D418`; the compiler currently refuses `samples:` for PRG builds).
- Voice reduction policy and report for 4-channel sources (MOD, XM, Furnace multichannel): not a language change.

### Rejected, with reasons

| Item | Reason |
|---|---|
| Export for DMC, Music Assembler, Future Composer, JCH, Soundmonitor, Voicetracker, Rock Monitor, Odin, SidWinder, defMON, SidTracker64, Mssiah, Prophet64 | Closed or undocumented formats, no headless oracle, players not redistributable |
| VGM | No SID support in the spec |
| `.vsf` | Machine snapshot, not music |
| CheeseCutter 3 | Unfinished, no export, format "may change in backwards incompatible ways" |
| MML (as a format) | No canonical C64 dialect, only stale tools |
| MOD / XM export | No SIDWave concept maps to samples; SWMconvert already does a lossy version |
| LilyPond, ML64 | No demand shown |
| ChiptuneSAK as a dependency | Alpha, unmaintained since 2022 |

## What I could not verify

- Byte-level encoding of Sidplayer `.mus` notes, durations and commands (only the outer layout was available).
- The `.sf2` layout beyond the header blocks: sequence event encoding and each driver's table semantics (partly in `notes_driver*.txt`, which I read only for drivers 11 to 16 headers; `user_manual.pdf` unread). Whether a separate driver source repository exists.
- Whether SF2 is GPL-2.0-only or -or-later; same for CheeseCutter. The `LICENSE` text for libvgm, libopenmpt and the ABC standard.
- Whether VGM 1.72 or later added SID (I read 1.71); VGM Rips' "unsupported chips" page (blocked, snippet only).
- DefleMask: file versions newer than 24, Linux availability, whether any tool loads `.dmf` headlessly. Furnace's `.dmf` import quality.
- KickAssembler support for writing PSID files.
- Whether SID Duzz'It, HardTrack Composer, Master Composer, SoedeSoft, Music Shop or Soundmonitor have usable native file formats beyond their memory images.
- SIDId limits: first-match counts are approximate; I did not run the `-m` (multi-signature) mode.
- Any claim of the `anarkiwi` parser family (frame-exactness, counts such as "about 2,000 JCH tunes").
- Building and running `ct2util`, `SWMconvert` and the SID-Wizard sources (no D compiler or 64tass installed or tried).
- CSDb download counts, forum activity and DeepSID statistics as popularity evidence (not collected; GitHub stars and HVSC tune counts only).
- SID-Wizard release status: SourceForge lists 1.7 (2021); the repository is 1.97-derived. I did not find an authoritative current-release page.

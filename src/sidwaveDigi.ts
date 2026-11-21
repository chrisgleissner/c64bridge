import { SidwaveValidationError, type SidwaveSamples } from "./sidwave.js";

// Each total includes the 7-cycle hardware entry and KERNAL SEI / JMP ($0318).
// The single track dispatch and lookup are page aligned. The multitrack
// estimates allow a page-cross penalty on every taken branch.
export const DIGI_CPU = {
  high: 100, low: 92, singlePeak: 116, entry: 69, track: 74, refill: 46, margin: 7,
} as const;

export function digiPeriod(clock: number, rate: number, pitch: number): number {
  return Math.round(clock / (rate * 2 ** (pitch / 12)));
}

/** Playback intervals in player calls, including replacements and explicit stops. */
export function digiSpans(samples: SidwaveSamples, fps: number, totalFrames: number, clock: number) {
  const spans: Array<{ chip: number; start: number; end: number }> = [];
  const active = new Map<number, typeof spans[number]>();
  const scheduled = samples.commands.flatMap((command) => command.at.map((frame) => ({ command, frame })));
  // End old playback first at a coincident start/stop.
  scheduled.sort((a, b) => a.frame - b.frame || Number(!!a.command.name) - Number(!!b.command.name));
  for (const { command, frame } of scheduled) {
    for (const chip of command.stopChips ?? [command.chip]) {
      const old = active.get(chip);
      if (old) old.end = Math.min(old.end, frame);
      active.delete(chip);
    }
    if (!command.name) continue;
    const sample = samples.defs.get(command.name)!;
    const period = digiPeriod(clock, samples.rate, command.pitch);
    const end = sample.loop ? totalFrames : Math.min(totalFrames, frame + (sample.sampleCount + 1) * period * fps / clock);
    const span = { chip: command.chip, start: frame, end };
    spans.push(span);
    active.set(command.chip, span);
  }
  return spans;
}

function trackCount(samples: SidwaveSamples): number {
  return new Set(samples.commands.map(({ chip }) => chip)).size;
}

export function digiPeakCycles(samples: SidwaveSamples): number {
  const tracks = trackCount(samples);
  const loops = new Set(samples.commands.filter(({ name }) => name && samples.defs.get(name)!.loop).map(({ chip }) => chip)).size;
  const wide = new Set(samples.commands.filter(({ name }) => name && samples.defs.get(name)!.sampleCount > 65536).map(({ chip }) => chip)).size;
  const normal = tracks === 1 ? DIGI_CPU.singlePeak : DIGI_CPU.entry + tracks * DIGI_CPU.track;
  return normal + loops * DIGI_CPU.refill + wide * 15;
}

export function validateDigiRate(samples: SidwaveSamples, clocks: number[]): void {
  const period = digiPeakCycles(samples) + DIGI_CPU.margin;
  const topPitch = Math.max(...samples.commands.filter(({ name }) => name !== undefined).map(({ pitch }) => pitch));
  if (clocks.some((clock) => digiPeriod(clock, samples.rate, topPitch) < period)) {
    const maximum = Math.min(8000, Math.floor(Math.min(...clocks) / (period - 0.5) / 2 ** (topPitch / 12)));
    throw new SidwaveValidationError("$.samples.rate",
      `the CIA2 timer needs at least ${period} cycles per NMI including margin at pitch ${topPitch}. Maximum rate is ${maximum} Hz for this schedule`);
  }
}

export function digiCyclesPerCall(samples: SidwaveSamples, fps: number, clock: number): number {
  const starts = samples.commands.filter(({ name }) => name !== undefined);
  const ticks = Math.ceil(Math.max(...starts.map(({ pitch }) => clock / digiPeriod(clock, samples.rate, pitch))) / fps) + 1;
  if (trackCount(samples) !== 1 || starts.some(({ name }) => {
    const definition = samples.defs.get(name!)!;
    return definition.loop || definition.sampleCount > 65536;
  })) {
    return ticks * digiPeakCycles(samples);
  }
  // During one score call a track can start at most once. Count one extra
  // high nibble for each of the two possible playback segments, plus the
  // rare branches for page carry, counter underflow and final nibble.
  const high = Math.min(ticks, Math.ceil(ticks / 2) + 1);
  const boundaries = Math.ceil(ticks / 256) + 1;
  return high * DIGI_CPU.high + (ticks - high) * DIGI_CPU.low + boundaries * (7 + 5) + 2 * 16;
}

export function digiDataAsm(samples: SidwaveSamples): string {
  return [...samples.defs.values()].map(({ data }, i) => {
    const rows: string[] = [];
    for (let j = 0; j < data.length; j += 32) {
      rows.push(`  .byte ${data.subarray(j, j + 32).join(",")}`);
    }
    return [`digi_data${i}:`, ...rows].join("\n");
  }).join("\n");
}

export function addDigiPlayer(
  code: string, samples: SidwaveSamples, sids: Array<{ address: number; volume: number }>, clocks: number[],
): string {
  const tracks = [...new Set(samples.commands.map(({ chip }) => chip))];
  const definitions = new Map([...samples.defs.keys()].map((name, i) => [name, i]));
  const baseLatch = clocks.map((clock) => digiPeriod(clock, samples.rate, 0) - 1);
  const pitched = samples.commands.some(({ pitch }) => pitch !== 0);
  const loopingTracks = new Set(samples.commands.filter(({ name }) => name && samples.defs.get(name)!.loop).map(({ chip }) => chip));
  const wideTracks = new Set(samples.commands.filter(({ name }) => name && samples.defs.get(name)!.sampleCount > 65536).map(({ chip }) => chip));
  const single = tracks.length === 1;
  const setPath = (chip: number, path: string) => single ? `  lda #<digi_${path}${chip}
  sta digi_dispatch${chip}+1
` : "";
  const byte = (values: number[]) => values.join(",");
  const modeVolume = (chip: number) => "$" + (sids[chip]!.address + 24).toString(16);

  const starts = samples.commands.map(({ chip, name, pitch, stopChips }, i) => {
    if (name === undefined) return `
digi_start${i}:
${(stopChips ?? [chip]).map((stop) => `${setPath(stop, "next")}  lda #0
  sta digi_active+${stop}
  lda digi_mix+${stop}
  sta ${modeVolume(stop)}`).join("\n")}
  jsr digi_idle
  jmp v_read
`;
    const sample = samples.defs.get(name)!;
    const index = definitions.get(name)!;
    const latch = clocks.map((clock) => digiPeriod(clock, samples.rate, pitch) - 1);
    return `
digi_start${i}:
  ; Hide the old sample until all cursor bytes have been updated.
${setPath(chip, "next")}  lda #0
  sta digi_active+${chip}
${pitch !== 0 || pitched ? `  ldy digi_clock
  lda digi_pitch_lo${i},y
  sta digi_new_lo
  lda digi_pitch_hi${i},y
  jsr digi_tune` : ""}
${loopingTracks.has(chip) ? `  lda #<${sample.loop ? `digi_refill${i}` : `digi_last${chip}`}
  sta digi_finish${chip}+1
  lda #>${sample.loop ? `digi_refill${i}` : `digi_last${chip}`}
  sta digi_finish${chip}+2` : ""}
  jsr digi_cursor${i}
  jmp digi_enable
${sample.loop ? `digi_refill${i}:
  jsr digi_cursor${i}
  jmp digi_next${chip}` : ""}
digi_cursor${i}:
  lda #<digi_data${index}
  sta digi_fetch_operand${chip}+1
  lda #>digi_data${index}
  sta digi_fetch_operand${chip}+2
  lda #${sample.sampleCount & 255}
  sta digi_left_lo${chip}
  lda #${Math.ceil(sample.sampleCount / 256) & 255}
  sta digi_left_hi${chip}
${wideTracks.has(chip) ? `  lda #${Math.ceil(sample.sampleCount / 65536)}
  sta digi_left_top${chip}
` : ""}  lda #1
  sta digi_active+${chip}
${setPath(chip, "fetch")}  rts
${pitched ? `digi_pitch_lo${i}: .byte ${byte(latch.map((n) => n & 255))}
digi_pitch_hi${i}: .byte ${byte(latch.map((n) => n >> 8))}` : ""}
`;
  }).join("");

  const channels = tracks.map((chip) => `
${single ? `digi_dispatch${chip}:
  jmp digi_next${chip}` : `  lda digi_active+${chip}
  beq digi_next${chip}
  bmi digi_restore${chip}
  cmp #2
  beq digi_low${chip}`}
digi_fetch${chip}:
${setPath(chip, "low")}${single ? "  stx digi_restore_x+1" : ""}
digi_fetch_operand${chip}:
  ldx $FFFF
  stx digi_cached${chip}+1
  lda digi_hi_tab,x
${single ? `digi_restore_x:
  ldx #0` : `  inc digi_active+${chip}`}
  jmp digi_write${chip}
digi_low${chip}:
  inc digi_fetch_operand${chip}+1
  bne digi_low_ready${chip}
  inc digi_fetch_operand${chip}+2
digi_low_ready${chip}:
${single ? setPath(chip, "fetch") : `  dec digi_active+${chip}`}
digi_cached${chip}:
  lda #0
  and #$0F
digi_write${chip}:
  ora digi_mode+${chip}
  sta ${modeVolume(chip)}
  dec digi_left_lo${chip}
  bne digi_next${chip}
  dec digi_left_hi${chip}
  bne digi_next${chip}
${wideTracks.has(chip) ? `  dec digi_left_top${chip}
  bne digi_next${chip}
` : ""}${loopingTracks.has(chip) ? `digi_finish${chip}:
  jmp digi_last${chip}` : ""}
digi_last${chip}:
  ; Leave the final nibble audible for a full timer period.
${single ? `  lda #<digi_restore${chip}
  sta digi_dispatch${chip}+1
  jmp digi_next${chip}` : `  lda #$80
  sta digi_active+${chip}
  bne digi_next${chip}`}
digi_restore${chip}:
  lda digi_mix+${chip}
  sta ${modeVolume(chip)}
${setPath(chip, "next")}  lda #0
  sta digi_active+${chip}
${single ? `  sta $DD0E
  sta digi_running` : `  lda #1
  sta digi_check_idle`}
digi_next${chip}:
`).join("");

  const volumeStore = "  ldy #$18\n  sta (sid_io),y";
  const softRelease = code.includes("soft_release:");
  code = code.split(volumeStore).join("  jsr digi_volume")
    .replace("  lda chip_volume,x\n  jsr digi_volume", "  lda chip_volume,x\n" + volumeStore)
    .replace("  txa\n  jsr init_core", "  jsr digi_init\n  txa\n  jsr init_core");
  if (softRelease) {
    // Detach CIA2 before the fade takes ownership of the volume register.
    code = code.replace("soft_release:\n", "soft_release:\n  jsr digi_stop\n")
      .replace(/(  ora soft_mode,x\n)  jsr digi_volume/, (_, mode: string) => mode + volumeStore);
  } else {
    code = code.replace(/finish_song:\n  lda \$01\n  pha\n  lda #\$36\n  sta \$01\n/, "$&  jsr digi_stop\n");
  }
  return code + `
digi_init:
  stx digi_clock
  lda #1
  sta $DD0D
  lda #0
  sta $DD0E
  sta digi_running
  lda $DD0D
  lda $0318
  cmp #<digi_nmi
  bne digi_save_vector
  lda $0319
  cmp #>digi_nmi
  beq digi_vector_saved
digi_save_vector:
  lda $0318
  sta digi_chain+1
  lda $0319
  sta digi_chain+2
digi_vector_saved:
${tracks.map((chip) => setPath(chip, "next")).join("")}  lda #<digi_nmi
  sta $0318
  lda #>digi_nmi
  sta $0319
  lda digi_latch_lo,x
  sta $DD04
  sta digi_current_lo
  lda digi_latch_hi,x
  sta $DD05
  sta digi_current_hi
  ldy #${sids.length - 1}
digi_reset:
  lda #0
  sta digi_active,y
  sta digi_mode,y
  ${code.includes("soft_mix:") ? "lda #0" : "lda chip_volume,y"}
  sta digi_mix,y
  dey
  bpl digi_reset
  rts
digi_stop:
  lda #1
  sta $DD0D
  lda #0
  sta $DD0E
  sta digi_running
  lda $DD0D
${tracks.map((chip) => `  lda #0
  sta digi_active+${chip}
  lda digi_mix+${chip}
  sta ${modeVolume(chip)}`).join("\n")}
  lda digi_chain+1
  sta $0318
  lda digi_chain+2
  sta $0319
  rts
c_sample:
  jsr fetch
  tay
  lda digi_start_hi,y
  pha
  lda digi_start_lo,y
  pha
  rts
digi_enable:
  lda digi_running
  bne digi_enabled
  lda #$81
  sta $DD0D
  lda #$11
  sta $DD0E
  sta digi_running
digi_enabled:
  jmp v_read
digi_idle:
${tracks.map((chip, i) => `  ${i ? "ora" : "lda"} digi_active+${chip}`).join("\n")}
  bne digi_idle_return
  sta $DD0E
  sta digi_running
digi_idle_return:
  rts
${pitched ? `digi_tune:
  cmp digi_current_hi
  bne digi_new_latch
  ldy digi_new_lo
  cpy digi_current_lo
  beq digi_tuned
digi_new_latch:
  sta digi_current_hi
  ldy #0
  sty $DD0E
  sty digi_running
  ldy $DD0D
  ldy digi_new_lo
  sty digi_current_lo
  sty $DD04
  sta $DD05
digi_tuned:
  rts` : ""}
digi_volume:
  stx digi_save_x
  ldx chip_index
  sta digi_mix,x
  and #$F0
  sta digi_mode,x
  lda digi_active,x
  bne digi_volume_done
  lda digi_mix,x
  ldy #$18
  sta (sid_io),y
digi_volume_done:
  ldx digi_save_x
  rts
; The KERNAL enters through $FE43 (SEI / JMP ($0318)).
; Keep the single track dispatch and its targets on the same page.
${single ? ".align 256" : ""}
digi_nmi:
  pha
  lda $DD0D
  and #1
  bne digi_timer_nmi
  pla
digi_chain:
  jmp $FE47
digi_timer_nmi:
${single ? "" : "  stx digi_restore_x+1"}
  lda $01
  sta digi_restore_bank+1
  lda #$36
  sta $01
${channels}
${single ? "" : `  lda digi_check_idle
  beq digi_restore_bank
  lda #0
  sta digi_check_idle
  jsr digi_idle`}
digi_restore_bank:
  lda #0
  sta $01
${single ? "" : "digi_restore_x:\n  ldx #0"}
  pla
  rti
${starts}
digi_latch_lo: .byte ${byte(baseLatch.map((n) => n & 255))}
digi_latch_hi: .byte ${byte(baseLatch.map((n) => n >> 8))}
digi_start_lo: .byte ${samples.commands.map((_, i) => `<(digi_start${i}-1)`).join(",")}
digi_start_hi: .byte ${samples.commands.map((_, i) => `>(digi_start${i}-1)`).join(",")}
digi_running: .res 1
${single ? "" : "digi_check_idle: .res 1"}
digi_clock: .res 1
digi_current_lo: .res 1
digi_current_hi: .res 1
digi_new_lo: .res 1
digi_save_x: .res 1
digi_active: .res ${sids.length}
digi_mix: .res ${sids.length}
digi_mode: .res ${sids.length}
${tracks.map((chip) => `digi_left_lo${chip}: .res 1\ndigi_left_hi${chip}: .res 1${wideTracks.has(chip) ? `\ndigi_left_top${chip}: .res 1` : ""}`).join("\n")}
.align 256
digi_hi_tab: .byte ${byte(Array.from({ length: 256 }, (_, i) => i >> 4))}
`;
}

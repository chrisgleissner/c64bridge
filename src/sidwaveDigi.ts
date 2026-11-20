import type { SidwaveSamples } from "./sidwave.js";

/** CIA2 timer A runs in phi2 time, independently of the score IRQ and CPU turbo. */
export const DIGI_CPU = { entry: 54, sample: 39, pageCross: 5, counterWrap: 15 } as const;

export function digiCyclesPerCall(samples: SidwaveSamples, fps: number): number {
  const tracks = new Set(samples.voices.map(({ chip }) => chip)).size;
  const ticks = Math.ceil(samples.rate / fps) + 1;
  // The exceptional cursor/counter paths are possible at a retrigger as
  // well as at a page boundary. The budget includes idle and active ticks.
  return ticks * (DIGI_CPU.entry + tracks * DIGI_CPU.sample) +
    tracks * (Math.ceil(ticks / 256) + 2) * (DIGI_CPU.pageCross + DIGI_CPU.counterWrap) +
    tracks * (16 + 4 * tracks); // volume restoration and optional timer stop
}

export function digiDataAsm(samples: SidwaveSamples): string {
  return samples.voices.map(({ data }, i) => {
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
  const tracks = [...new Set(samples.voices.map(({ chip }) => chip))];
  const latch = clocks.map((clock) => Math.round(clock / samples.rate) - 1);
  const starts = samples.voices.map(({ chip, data }, i) => `
digi_start${i}:
  ; Publish the active flag only after the cursor and counters are ready.
  lda #0
  sta digi_active+${chip}
  lda #<digi_data${i}
  sta digi_fetch${chip}+1
  lda #>digi_data${i}
  sta digi_fetch${chip}+2
  lda #${data.length & 255}
  sta digi_left_lo${chip}
  lda #${((data.length - 1) >> 8) + 1}
  sta digi_left_hi${chip}
  lda #1
  sta digi_active+${chip}
  jmp digi_enable
`).join("");
  const hasOtherActive = (chip: number) => {
    const others = tracks.filter((track) => track !== chip);
    if (!others.length) return "";
    return ["  lda digi_active+" + others[0],
      ...others.slice(1).map((track) => `  ora digi_active+${track}`),
      `  bne digi_next${chip}`].join("\n");
  };
  const channels = tracks.map((chip) => `
  lda digi_active+${chip}
  beq digi_next${chip}
  bmi digi_restore${chip}
digi_fetch${chip}:
  lda $FFFF
  ora digi_mode+${chip}
  sta $${(sids[chip]!.address + 24).toString(16)}
  inc digi_fetch${chip}+1
  bne digi_count${chip}
  inc digi_fetch${chip}+2
digi_count${chip}:
  dec digi_left_lo${chip}
  bne digi_next${chip}
  dec digi_left_hi${chip}
  bne digi_next${chip}
  ; Leave the last nibble on the register for one full timer period.
  lda #$80
  sta digi_active+${chip}
  jmp digi_next${chip}
digi_restore${chip}:
  lda digi_mix+${chip}
  sta $${(sids[chip]!.address + 24).toString(16)}
  lda #0
  sta digi_active+${chip}
${hasOtherActive(chip)}
  sta $DD0E
  sta digi_running
digi_next${chip}:
`).join("");

  // The init/finish code already has I/O mapped. Mixer writes become plain
  // cached bytes while the corresponding NMI voice owns the low nybble.
  const volumeStore = "  ldy #$18\n  sta (sid_io),y";
  code = code.split(volumeStore).join("  jsr digi_volume")
    .replace("  lda chip_volume,x\n  jsr digi_volume", "  lda chip_volume,x\n" + volumeStore)
    .replace("  txa\n  jsr init_core", "  jsr digi_init\n  txa\n  jsr init_core")
    .replace("finish_song:\n", "finish_song:\n  jsr digi_stop\n");
  return code + `
digi_init:
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
  lda #<digi_nmi
  sta $0318
  lda #>digi_nmi
  sta $0319
  lda digi_latch_lo,x
  sta $DD04
  lda digi_latch_hi,x
  sta $DD05
  ldy #${sids.length - 1}
digi_reset:
  lda #0
  sta digi_active,y
  sta digi_mode,y
  lda chip_volume,y
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
; $FE43 runs SEI / JMP ($0318); it hasn't pushed the registers.
; No X, Y or zero-page scratch is clobbered by the handler.
digi_nmi:
  pha
  lda $DD0D
  lsr
  bcs digi_timer_nmi
  jmp digi_other_nmi
digi_timer_nmi:
  lda $01
  pha
  lda #$36
  sta $01
${channels}
  pla
  sta $01
  pla
  rti
digi_other_nmi:
  pla
digi_chain:
  jmp $FE47
${starts}
digi_latch_lo: .byte ${latch.map((n) => n & 255).join(",")}
digi_latch_hi: .byte ${latch.map((n) => n >> 8).join(",")}
digi_start_lo: .byte ${samples.voices.map((_, i) => `<(digi_start${i}-1)`).join(",")}
digi_start_hi: .byte ${samples.voices.map((_, i) => `>(digi_start${i}-1)`).join(",")}
digi_running: .res 1
digi_save_x: .res 1
digi_active: .res ${sids.length}
digi_mix: .res ${sids.length}
digi_mode: .res ${sids.length}
${tracks.map((chip) => `digi_left_lo${chip}: .res 1\ndigi_left_hi${chip}: .res 1`).join("\n")}
`;
}

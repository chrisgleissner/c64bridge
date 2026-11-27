// A small synthesiser that plays a Standard MIDI File for the "before" side of the MIDI conversion demo. It
// covers what harbour_lights.mid uses: a flute-like lead (program 73), a plucked string (program 24) and a few
// General MIDI drums on channel 10. No samples or sound fonts are involved.
const RATE = 44100;

function parse(bytes) {
  const division = bytes.readUInt16BE(12);
  let offset = 14;
  const events = [];
  while (offset < bytes.length) {
    const end = offset + 8 + bytes.readUInt32BE(offset + 4);
    let at = offset + 8;
    let tick = 0;
    let running = 0;
    const vlq = () => {
      let value = 0;
      let byte;
      do {
        byte = bytes[at++];
        value = (value << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      return value;
    };
    while (at < end) {
      tick += vlq();
      let status = bytes[at];
      if (status & 0x80) at += 1;
      else status = running;
      if (status === 0xff) {
        const type = bytes[at++];
        const length = vlq();
        if (type === 0x51) events.push({ tick, tempo: bytes.readUIntBE(at, 3) });
        at += length;
      } else {
        running = status;
        const kind = status & 0xf0;
        const a = bytes[at++];
        const b = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[at++];
        events.push({ tick, kind, channel: status & 15, a, b });
      }
    }
    offset = end;
  }
  return { division, events: events.sort((x, y) => x.tick - y.tick) };
}

/** Mono 16 bit audio of the file. */
export function renderMidi(bytes, { seconds }) {
  const { division, events } = parse(bytes);
  const mix = new Float64Array(Math.round(seconds * RATE));
  let tempo = 500000;
  let tick = 0;
  let time = 0;
  const programs = new Map();
  const open = new Map();
  const notes = [];
  for (const event of events) {
    time += ((event.tick - tick) / division) * (tempo / 1e6);
    tick = event.tick;
    if (event.tempo) tempo = event.tempo;
    else if (event.kind === 0xc0) programs.set(event.channel, event.a);
    else if (event.kind === 0x90 && event.b > 0) {
      const note = { start: time, key: event.a, velocity: event.b / 127, channel: event.channel, program: programs.get(event.channel) ?? 0, end: time + 0.25 };
      open.set(`${event.channel}/${event.a}`, note);
      notes.push(note);
    } else if (event.kind === 0x80 || event.kind === 0x90) {
      const note = open.get(`${event.channel}/${event.a}`);
      if (note) note.end = time;
    }
  }
  let seed = 7;
  const noise = () => {
    seed = (seed * 25173 + 13849) & 0xffff;
    return seed / 32768 - 1;
  };
  const sine = (cycles) => Math.sin(2 * Math.PI * cycles);
  for (const { start, end, key, velocity, channel, program } of notes) {
    const f = 440 * 2 ** ((key - 69) / 12);
    const drum = channel === 9;
    const length = drum ? (key === 49 ? 1.5 : 0.35) : end - start + 0.12;
    let previous = 0;
    let phase = 0;
    for (let i = 0; i < length * RATE; i += 1) {
      const at = Math.round(start * RATE) + i;
      if (at >= mix.length) break;
      const t = i / RATE;
      const release = Math.min(1, Math.max(0, (length - t) / 0.12));
      let value;
      if (drum && key === 36) {
        phase += (48 + 110 * Math.exp(-t * 30)) / RATE;
        value = 0.8 * sine(phase) * Math.exp(-t * 11);
      } else if (drum && key === 38) value = (0.35 * noise() + 0.25 * sine(190 * t)) * Math.exp(-t * 16);
      else if (drum) {
        const n = noise();
        value = 0.18 * (n - previous) * Math.exp(-t * (key === 49 ? 3 : 45));
        previous = n;
      } else if (program === 73) {
        const vibrato = 0.004 * Math.min(1, t * 2) * sine(5.2 * t);
        phase += (f * (1 + vibrato)) / RATE;
        value = 0.34 * (sine(phase) + 0.22 * sine(2 * phase) + 0.08 * sine(3 * phase) + 0.015 * noise()) * Math.min(1, t / 0.04) * release;
      } else {
        value = 0;
        for (let h = 1; h <= 6; h += 1) value += (sine(h * f * t) / h) * Math.exp(-t * (2 + h * 1.5));
        value *= 0.24 * Math.min(1, t / 0.003) * release;
      }
      mix[at] += value * velocity;
    }
  }
  // A short room echo, then scale to leave headroom.
  const delay = Math.round(0.19 * RATE);
  for (let i = delay; i < mix.length; i += 1) mix[i] += 0.18 * mix[i - delay];
  const peak = mix.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
  return { rate: RATE, channels: 1, samples: Int16Array.from(mix, (v) => Math.round((v / peak) * 26000)) };
}

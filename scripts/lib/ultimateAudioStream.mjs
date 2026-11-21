/**
 * Shared helpers for the SIDWAVE scripts: load the c64bridge modules, talk to the Ultimate REST API and record its
 * UDP audio stream (doc/c64u/streams: 2-byte little-endian sequence number, then 192 stereo 16-bit frames).
 */
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VALUES_PER_PACKET = 384;

/**
 * Imports src/<name>.ts for each name. With preferDist, a complete dist build is used instead when one exists.
 * dist can be older than src, so a script that must run the checked-out code passes preferDist: false.
 */
export async function loadModules(names, { preferDist = true } = {}) {
  const dist = preferDist ? [path.join(ROOT, "dist"), path.join(ROOT, "dist", "src")].find((dir) =>
    names.every((name) => fs.existsSync(path.join(dir, `${name}.js`)))) : undefined;
  if (dist) {
    const mods = await Promise.all(names.map((m) => import(pathToFileURL(path.join(dist, `${m}.js`)).href)));
    return Object.assign({}, ...mods);
  }
  if (!globalThis.Bun) {
    const { register } = await import("tsx/esm/api");
    register();
  }
  const src = (m) => import(pathToFileURL(path.join(ROOT, "src", `${m}.ts`)).href);
  return Object.assign({}, ...(await Promise.all(names.map(src))));
}

export function writeWav(file, pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length * 2, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(Math.round(sampleRate), 24); header.writeUInt32LE(Math.round(sampleRate) * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
}

/** Local address the OS would use to reach the device (connect on a UDP socket sends nothing). */
export function localAddressFor(host) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.once("error", reject);
    s.connect(80, host, () => { const { address } = s.address(); s.close(); resolve(address); });
  });
}

export async function rest(base, headers, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/octet-stream" } : {}) }, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || (json?.errors?.length ?? 0) > 0) throw new Error(`${method} ${route} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return json;
}

/**
 * Starts the audio stream to a local UDP port, waits for the first datagram, calls startSong and records `seconds`
 * of interleaved stereo samples, counted from the first datagram or, with fromSongStart, from the moment startSong
 * resolves (the audio before it is kept). Lost datagrams (a gap in the sequence numbers below 1000) are filled with
 * silence so that later audio keeps its timing. The stream is stopped in every case.
 */
export async function recordAudioStream({ base, headers, seconds, sampleRate, startSong, fromSongStart = false }) {
  const local = await localAddressFor(new URL(base).hostname);
  const socket = dgram.createSocket("udp4");
  await new Promise((res, rej) => { socket.once("error", rej); socket.bind(0, "0.0.0.0", res); });
  const port = socket.address().port;
  let wanted = Math.ceil(seconds * sampleRate) * 2;
  const chunks = []; let values = 0; let lastSeq = null; let first = false; let lostPackets = 0;
  let counting = !fromSongStart;
  let onFirst; const firstSeen = new Promise((r) => { onFirst = r; });
  let done; const finished = new Promise((r) => { done = r; });
  socket.on("message", (msg) => {
    // The device sends a 2-byte packet without samples when the stream starts; it carries no audio and
    // its sequence number is not part of the sample sequence.
    if (msg.length <= 2) return;
    const seq = msg.readUInt16LE(0);
    if (lastSeq !== null) {
      const gap = ((seq - lastSeq - 1) & 0xffff);
      if (gap > 0 && gap < 1000) { const z = new Int16Array(gap * VALUES_PER_PACKET); chunks.push(z); values += z.length; lostPackets += gap; }
    }
    lastSeq = seq;
    const n = (msg.length - 2) >> 1;
    const s = new Int16Array(n);
    for (let i = 0; i < n; i += 1) s[i] = msg.readInt16LE(2 + 2 * i);
    chunks.push(s); values += n;
    if (!first) { first = true; onFirst(); }
    if (counting && values >= wanted) done();
  });
  let started = false;
  const timers = [];
  const timeout = (ms, what) => new Promise((_, rej) => { timers.push(setTimeout(() => rej(new Error(what)), ms)); });
  try {
    await rest(base, headers, "PUT", `/v1/streams/audio:start?ip=${encodeURIComponent(`${local}:${port}`)}`);
    started = true;
    await Promise.race([firstSeen, timeout(5000, "no audio datagram within 5 s; check that UDP from the device reaches this host")]);
    await startSong();
    if (fromSongStart) { wanted += values; counting = true; }
    await Promise.race([finished, timeout((seconds + 5) * 1000, "capture timed out")]);
  } finally {
    for (const t of timers) clearTimeout(t);
    socket.close();
    if (started) await rest(base, headers, "PUT", "/v1/streams/audio:stop").catch((e) => console.error(`warning: ${e.message}`));
  }
  const pcm = new Int16Array(Math.min(values, wanted));
  let o = 0;
  for (const c of chunks) { if (o >= pcm.length) break; const k = Math.min(c.length, pcm.length - o); pcm.set(c.subarray(0, k), o); o += k; }
  return { pcm, lostPackets };
}

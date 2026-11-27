#!/usr/bin/env node
// Builds Pulse Guard: `node examples/sidwave-showcase/build.mjs`.
//
// The score is compiled as a SIDWave game build at $4000. Its ACME symbol file and the artwork of art.txt are
// given to the 6502-toolkit assembler as include files. The result is out/pulse_guard.prg (load and RUN),
// out/pulse_guard.labels.json (used by verify.mjs and record.mjs) and out/pulse_guard.build.json (sizes and the
// measured player cycles).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSidwave } from "./lib/sidwave.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const LOAD = 0x0801;
const CHARSET = 0x3000;
const SPRITES = 0x3800;
const MUSIC = 0x4000;

/** Parses art.txt into multicolour sprites and title letters. */
export function parseArt(text) {
  const sprites = [];
  const letters = [];
  let current;
  for (const line of text.split("\n")) {
    const head = /^\[(sprite|logo) (\w+)\]$/.exec(line);
    if (head) {
      current = { kind: head[1], name: head[2], rows: [] };
      (head[1] === "sprite" ? sprites : letters).push(current);
    } else if (current && line !== "" && !line.startsWith("# ")) {
      current.rows.push(line);
    }
  }
  const bytesOf = ({ name, rows }) => {
    if (rows.length > 21 || rows.some((row) => !/^[.123]{12}$/.test(row))) throw new Error(`art.txt: sprite ${name} must be at most 21 rows of 12 characters ".123"`);
    const bytes = [];
    for (let y = 0; y < 21; y += 1) {
      const row = rows[y] ?? "............";
      for (let x = 0; x < 12; x += 4) bytes.push([...row.slice(x, x + 4)].reduce((acc, ch) => (acc << 2) | (ch === "." ? 0 : Number(ch)), 0));
    }
    return [...bytes, 0];
  };
  const letterBytes = ({ name, rows }) => {
    if (rows.length !== 7 || rows.some((row) => !/^[.#]{5}$/.test(row))) throw new Error(`art.txt: letter ${name} must be 7 rows of 5 characters ".#"`);
    return rows.map((row) => [...row].reduce((acc, ch) => (acc << 1) | (ch === "#" ? 1 : 0), 0) << 3);
  };
  const hex = (values) => values.map((v) => `$${v.toString(16).padStart(2, "0")}`).join(",");
  const constants = [
    ...sprites.map((sprite, i) => `spr_${sprite.name} = ${SPRITES / 64 + i}`),
    ...letters.map((letter, i) => `logo_${letter.name} = ${i * 7}`),
  ].join("\n");
  const data = [
    "logo_font:",
    ...letters.map((letter) => `        !byte ${hex(letterBytes(letter))}`),
    "code_end:",
    `        * = $${SPRITES.toString(16)}`,
    ...sprites.map((sprite) => `        !byte ${hex(bytesOf(sprite))}    ; ${sprite.name}`),
    "sprites_end:",
  ].join("\n");
  return { constants, data, sprites: sprites.length };
}

/** Turns every note of every pattern into a rest, so the songs are silent; the effects stay. */
function silentSongs(score) {
  return score.replace(/groove: "([^"]*)"/g, (_, groove) => `groove: "${groove.replace(/[^\s|]+/g, "-")}"`);
}

/**
 * Options: `silentMusic` builds the effects-only variant used by verify.mjs under the file name `name`; `dir` is the
 * folder the three files are written to.
 */
export async function buildGame({ quiet = false, silentMusic = false, name = "pulse_guard", dir = out } = {}) {
  const { parseSidwave, compileSidwave, assemblyToPrgDetailed, version } = await loadSidwave();
  const read = (name) => fs.readFileSync(path.join(here, name), "utf8");
  const score = read("pulse_guard.yaml");
  const source = silentMusic ? silentSongs(score) : score;
  const music = compileSidwave(parseSidwave(source), { target: "game", origin: MUSIC, symbols: ["acme"] });
  const effects = [...music.symbols.acme.matchAll(/^sidwave_fx_(\w+) = \$([0-9A-F]+)/gm)].sort((a, b) => parseInt(a[2], 16) - parseInt(b[2], 16)).map((m) => m[1]);
  const art = parseArt(read("art.txt"));
  const includes = { "music.acme": music.symbols.acme, "art.acme": art.constants, "artdata.acme": art.data };
  const program = assemblyToPrgDetailed(read("pulse_guard.asm"), { fileName: "pulse_guard.asm", resolveInclude: (name) => includes[path.basename(String(name))] });
  const labels = Object.fromEntries(program.symbols);
  if (labels.code_end > CHARSET) throw new Error(`the program ends at $${labels.code_end.toString(16)}, behind the character set at $${CHARSET.toString(16)}`);
  if (labels.sprites_end > MUSIC) throw new Error("the sprites reach into the music");
  if (labels.vars_end - labels.vars > 255) throw new Error("more than 255 bytes of variables");
  const assembledEnd = LOAD + program.prg.length - 2;
  if (program.prg[0] !== (LOAD & 0xff) || program.prg[1] !== LOAD >> 8 || assembledEnd > MUSIC) throw new Error("unexpected program layout");
  const end = MUSIC + music.combined.length;
  const prg = new Uint8Array(2 + end - LOAD);
  prg.set(program.prg, 0);
  prg.set(music.combined, 2 + MUSIC - LOAD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.prg`), prg);
  fs.writeFileSync(path.join(dir, `${name}.labels.json`), `${JSON.stringify(labels, null, 1)}\n`);
  const { cycles } = music;
  const info = {
    sidwave: version,
    prgBytes: prg.length,
    programBytes: labels.code_end - LOAD,
    sprites: art.sprites,
    effects,
    player: { origin: MUSIC, end: end - 1, imageBytes: music.combined.length },
    cycles: { worst: cycles.worst, average: cycles.average, worstWithEffects: cycles.withEffects?.worst, sfxWorst: cycles.withEffects?.sfxWorst, upperBound: cycles.estimatedWorst, songs: cycles.songs },
    warnings: music.warnings,
  };
  fs.writeFileSync(path.join(dir, `${name}.build.json`), `${JSON.stringify(info, null, 2)}\n`);
  if (!quiet) {
    console.log(`out/pulse_guard.prg: ${prg.length} bytes (program ${info.programBytes}, player and music ${info.player.imageBytes} at $${MUSIC.toString(16)})`);
    console.log(`player cycles per call (SIDWave emulator): worst ${cycles.worst}, average ${Math.round(cycles.average)}, worst with effects ${info.cycles.worstWithEffects}, sfx call ${info.cycles.sfxWorst}`);
  }
  return { prg, labels, info, file: path.join(dir, `${name}.prg`) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildGame();

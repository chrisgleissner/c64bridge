import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../src/tools/registry/index.js";
import { soundModuleGroup } from "../src/tools/registry/sound.js";
import { sidwaveOperationEffects, sidwaveOperations } from "../src/tools/sidwaveOperations.js";
import { createLogger } from "./meta/helpers.mjs";

const READ = ["formats", "inspect", "validate", "lint", "analyze_music", "compare", "sid_info"];
const WRITE = ["convert", "format", "compile", "transform", "retarget", "reconstruct", "compose", "complete"];

const EXAMPLES = path.resolve("data/sound/examples");
const SHORT = path.join(EXAMPLES, "fuer_elise.yaml");
const SCORE = `song: { title: Ops Test, mode: PAL, tempo: 120 }
voices:
  - id: 1
    waveform: triangle
    patterns:
      main: { notes: [C4, E4, G4] }
timeline:
  - { bars: 1, layers: { v1: main } }
`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-sidwave-ops-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
const at = (name) => path.join(work, name);
const write = (name, content) => { fs.writeFileSync(at(name), content); return at(name); };

/** A machine that reports its clock at $02A6 and, for hardware, its SID configuration. */
function machine({ platform = "vice", clock = 1, config = {} } = {}) {
  const progress = [];
  return {
    progress,
    client: {
      async readMemoryRaw(address) { assert.equal(address, 0x02a6); return new Uint8Array([clock]); },
      async configGet(category) {
        if (!config[category]) throw new Error(`no category ${category}`);
        return { [category]: config[category] };
      },
    },
    platform: { id: platform, features: [], limitedFeatures: [] },
    rag: {},
    logger: createLogger(),
    setPlatform() {},
    reportProgress: (completed, total, message) => progress.push({ completed, total, message }),
  };
}

async function sound(args, ctx = machine()) {
  const result = await toolRegistry.invoke("c64_sound", args, ctx);
  return { result, data: result.structuredContent?.data, error: result.metadata?.error, text: result.content[0].text };
}

async function ok(args, ctx) {
  const { result, data, text } = await sound(args, ctx);
  assert.notEqual(result.isError, true, `${args.op} failed: ${text}`);
  return data;
}

async function rejected(args, pattern, ctx) {
  const { result, text } = await sound(args, ctx);
  assert.equal(result.isError, true, `${args.op} should fail`);
  assert.match(text, pattern);
  return result;
}

test("SIDWave operations are published with schemas and effects", () => {
  assert.deepEqual(Object.keys(sidwaveOperationEffects).sort(), [...READ, ...WRITE].sort());
  for (const op of READ) assert.equal(sidwaveOperationEffects[op], "read", op);
  for (const op of WRITE) assert.equal(sidwaveOperationEffects[op], "write", op);
  const descriptor = soundModuleGroup.describeTools().find((tool) => tool.name === "c64_sound");
  const published = descriptor.inputSchema.properties.op.enum;
  for (const { op, schema } of sidwaveOperations) {
    assert.ok(published.includes(op), `${op} is published`);
    assert.equal(schema.additionalProperties, false, `${op} rejects unknown arguments`);
    assert.equal(schema.properties.op.const, op);
    assert.ok(schema.description.length > 5, op);
    assert.equal(descriptor.metadata.operationEffects[op], sidwaveOperationEffects[op], op);
  }
  // Existing operations keep their names.
  for (const op of ["generate", "compile_play", "play_preset", "pipeline", "analyze", "record_analyze"]) assert.ok(published.includes(op), op);
});

test("read-only access allows the read operations and blocks the writing ones", async () => {
  const previous = process.env.C64BRIDGE_ACCESS;
  process.env.C64BRIDGE_ACCESS = "read-only";
  try {
    assert.ok((await ok({ op: "formats" })).formats.length > 5);
    assert.equal((await ok({ op: "validate", sidwave: SCORE })).valid, true);
    for (const op of WRITE) {
      await assert.rejects(() => toolRegistry.invoke("c64_sound", { op }, machine()).then((result) => {
        if (result.isError) throw new Error(result.content[0].text);
        return result;
      }), /blocked/, op);
    }
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
});

test("host paths outside the allowed directories are rejected for inputs and outputs", async () => {
  const outside = path.join(path.parse(work).root, "etc", "hostname");
  for (const args of [
    { op: "inspect", inputPath: outside },
    { op: "validate", inputPath: outside },
    { op: "sid_info", inputPath: outside },
    { op: "reconstruct", inputPath: outside },
    { op: "compare", sidwave: SCORE, comparePath: outside },
    { op: "compile", sidwave: SCORE, outputPath: "/etc/c64bridge-test.prg" },
    { op: "compile", sidwave: SCORE, output: "game", origin: 0x8000, outputDir: "/etc/c64bridge-test" },
    { op: "convert", sidwave: SCORE, outputPath: "/etc/c64bridge-test.mid" },
    { op: "sid_info", inputPath: SHORT, hvscDir: "/etc" },
  ]) {
    await rejected(args, /outside the allowed directories/);
  }
  const digi = fs.readFileSync(path.join(EXAMPLES, "digi_groove.yaml"), "utf8");
  const sample = digi.replace(/^ {4}kick: .*$/m, '    kick: { file: "/etc/hostname" }');
  assert.notEqual(sample, digi);
  // A score's sample file is confined like any other host input.
  for (const op of ["validate", "compile"]) {
    const { result, text } = await sound({ op, sidwave: sample });
    assert.match(text, /outside the allowed directories/, op);
    if (op === "compile") assert.equal(result.isError, true);
  }
});

test("an input is named exactly once and a missing file is a validation error", async () => {
  await rejected({ op: "validate" }, /exactly one of inputPath and sidwave/);
  await rejected({ op: "validate", sidwave: SCORE, inputPath: SHORT }, /exactly one/);
  await rejected({ op: "validate", inputPath: at("missing.yaml") }, /not found/i);
  await rejected({ op: "validate", sidwave: SCORE, bogus: 1 }, /Unexpected property "bogus"/);
});

test("formats lists every format and describes one", async () => {
  const { formats } = await ok({ op: "formats" });
  const ids = formats.map((format) => format.id);
  for (const id of ["sidwave", "sid", "midi", "wav"]) assert.ok(ids.includes(id), id);
  assert.equal((await ok({ op: "formats", from: "mid" })).format.id, "midi");
  await rejected({ op: "formats", from: "nope" }, /Unknown format/);
});

test("inspect detects a score", async () => {
  const data = await ok({ op: "inspect", inputPath: SHORT });
  assert.equal(data.format, "sidwave");
  assert.equal(data.readable, true);
  await rejected({ op: "inspect", inputPath: write("noise.bin", Buffer.from([1, 2, 3, 4, 5])) }, /detect|format|ambig/i);
});

test("validate reports the path of an invalid score without failing the call", async () => {
  const valid = await ok({ op: "validate", sidwave: SCORE });
  assert.deepEqual([valid.valid, valid.title, valid.voices, valid.sids], [true, "Ops Test", 1, 1]);
  const invalid = await ok({ op: "validate", sidwave: SCORE.replace("v1: main", "v1: other") });
  assert.equal(invalid.valid, false);
  assert.match(invalid.message, /other/);
  assert.equal(typeof invalid.path, "string");
});

test("lint returns findings", async () => {
  const data = await ok({ op: "lint", inputPath: SHORT });
  assert.equal(typeof data.actionable, "number");
  assert.ok(Array.isArray(data.findings));
});

test("format writes canonical text and never replaces a file without overwrite", async () => {
  const first = await ok({ op: "format", sidwave: SCORE, outputPath: at("formatted.yaml"), includeScore: true });
  assert.equal(fs.readFileSync(first.outputPath, "utf8"), first.sidwave);
  await rejected({ op: "format", sidwave: SCORE, outputPath: at("formatted.yaml") }, /exists; pass overwrite/);
  const again = await ok({ op: "format", inputPath: first.outputPath, outputPath: first.outputPath, overwrite: true });
  assert.equal(again.changed, false);
});

test("an operation without outputPath writes a new file below the artifacts directory", async () => {
  const data = await ok({ op: "compile", sidwave: SCORE });
  try {
    assert.match(data.outputPath, /artifacts[/\\]sidwave[/\\]score-[0-9a-f]{8}\.prg$/);
    assert.equal(fs.statSync(data.outputPath).size, data.bytes);
  } finally {
    fs.rmSync(data.outputPath, { force: true });
  }
});

test("compile writes PRG and SID files and reports the active backend", async () => {
  const prg = await ok({ op: "compile", inputPath: SHORT, outputPath: at("fuer.prg") });
  assert.equal(prg.format, "prg");
  assert.equal(prg.backend, "vice");
  assert.equal(fs.readFileSync(at("fuer.prg")).readUInt16LE(0), prg.loadAddress);
  const sid = await ok({ op: "compile", inputPath: SHORT, output: "sid", outputPath: at("fuer.sid") });
  assert.equal(fs.readFileSync(sid.outputPath).subarray(0, 4).toString(), "PSID");
  // A copy: a regression here would overwrite the file.
  const own = write("own.yaml", SCORE);
  await rejected({ op: "compile", inputPath: own, outputPath: own, overwrite: true }, /input file/);
  await rejected({ op: "convert", inputPath: own, to: "sidwave", outputPath: own, overwrite: true }, /input file/);
  assert.equal(fs.readFileSync(own, "utf8"), SCORE);
});

test("compile forDevice warns when the machine's clock or SID model differs", async () => {
  const config = {
    "SID Addressing": { "UltiSID 1 Address": "Unmapped", "UltiSID 2 Address": "Unmapped", "SID Socket 1 Address": "$D400", "SID Socket 2 Address": "Unmapped" },
    "SID Sockets Configuration": { "SID Socket 1": "Enabled", "SID Detected Socket 1": { current: "6581" }, "SID Socket 2": "Disabled" },
  };
  const data = await ok({ op: "compile", inputPath: path.join(EXAMPLES, "stereo_echo.yaml"), forDevice: true, outputPath: at("device.prg") }, machine({ platform: "c64u", clock: 0, config }));
  assert.deepEqual([data.device.system, data.device.sidModel], ["NTSC", "6581"]);
  assert.ok(data.warnings.some((warning) => /PAL but the machine is NTSC/.test(warning)), data.warnings.join("\n"));
  assert.ok(data.warnings.some((warning) => /declares 8580.*6581/.test(warning)), data.warnings.join("\n"));
  // An UltiSID that also answers at $D400 leaves the model unknown.
  const shared = { ...config, "SID Addressing": { ...config["SID Addressing"], "UltiSID 1 Address": "$D400" } };
  const mixed = await ok({ op: "compile", sidwave: SCORE, forDevice: true, outputPath: at("mixed.prg") }, machine({ platform: "c64u", config: shared }));
  assert.equal(mixed.device.sidModel, undefined);
});

test("compile builds the game target with symbols and the register contract", async () => {
  const data = await ok({
    op: "compile", inputPath: path.join(EXAMPLES, "game_songs.yaml"), output: "game", origin: 0x8000,
    symbols: ["acme", "json"], outputDir: at("game"),
  });
  assert.equal(data.contract.entryPoints.init, 0x8000);
  assert.equal(data.contract.entryPoints.play, 0x8003);
  assert.deepEqual(data.files.map((file) => path.basename(file.outputPath)).sort(), ["game_songs.acme", "game_songs.bin", "game_songs.symbols.json"]);
  assert.equal(typeof data.cycles.worst, "number");
  assert.ok(data.contract.songs.length > 1);
  await rejected({ op: "compile", sidwave: SCORE, output: "game", outputDir: at("game2") }, /origin/);
  await rejected({ op: "compile", sidwave: SCORE, output: "game", origin: 0x8000, outputPath: at("x.bin") }, /outputDir/);
  await rejected({ op: "compile", inputPath: path.join(EXAMPLES, "game_songs.yaml"), output: "game", origin: 0x8000, symbols: ["acme", "json"], outputDir: at("game") }, /exists/);
});

test("transform applies each action and names a missing parameter", async () => {
  const actions = [
    { action: "transpose", semitones: 2 },
    { action: "set_tempo", bpm: 100 },
    { action: "scale_tempo", factor: 1.25 },
  ];
  for (const args of actions) {
    const data = await ok({ op: "transform", sidwave: SCORE, ...args, includeScore: true, outputPath: at(`${args.action}.yaml`) });
    assert.notEqual(data.sidwave, SCORE, args.action);
    assert.ok(data.report.changed.length > 0, args.action);
  }
  assert.match(fs.readFileSync(at("transpose.yaml"), "utf8"), /D4/);
  await rejected({ op: "transform", sidwave: SCORE, action: "transpose" }, /semitones|Missing required/);
  await rejected({ op: "transform", sidwave: SCORE, action: "reverse" }, /Unknown transform action/);
  await rejected({ op: "transform", sidwave: SCORE, action: "transpose", semitones: 90 }, /Offending note/);
});

test("retarget converts the clock, takes it from the device on request and requires a target", async () => {
  const data = await ok({ op: "retarget", sidwave: SCORE, system: "NTSC", includeScore: true, outputPath: at("ntsc.yaml") });
  assert.equal(data.verdict, "ok");
  assert.match(data.sidwave, /NTSC/);
  const device = await ok({ op: "retarget", sidwave: SCORE, forDevice: true, outputPath: at("device.yaml") }, machine({ clock: 0 }));
  assert.equal(device.requested.clock, "NTSC");
  await rejected({ op: "retarget", sidwave: SCORE }, /Name a target/);
});

test("convert writes the output, reports losses and honours strict", async () => {
  const midi = await ok({ op: "convert", inputPath: SHORT, to: "midi", outputPath: at("fuer.mid"), verify: true });
  assert.equal(midi.written, true);
  assert.equal(fs.readFileSync(midi.outputPath).subarray(0, 4).toString(), "MThd");
  assert.deepEqual([midi.from, midi.to], ["sidwave", "midi"]);
  assert.ok(midi.metrics);
  assert.ok(Array.isArray(midi.losses));
  const back = await ok({ op: "convert", inputPath: midi.outputPath, outputPath: at("fuer-back.sidwave.yaml") });
  assert.equal(back.to, "sidwave");
  assert.equal((await ok({ op: "validate", inputPath: back.outputPath })).valid, true);
  const strict = await ok({ op: "convert", inputPath: path.join(EXAMPLES, "wall_of_sid.yaml"), to: "midi", strict: true, outputPath: at("strict.mid") });
  assert.equal(strict.written, strict.severity !== "lost");
  assert.equal(fs.existsSync(at("strict.mid")), strict.written);
  await rejected({ op: "convert", sidwave: SCORE }, /format|--to|target/i);
});

test("sid_info reads the header, song lengths, STIL and the player", async () => {
  const { createHash } = await import("node:crypto");
  const sid = (await ok({ op: "compile", inputPath: SHORT, output: "sid", outputPath: at("info.sid") })).outputPath;
  const md5 = createHash("md5").update(fs.readFileSync(sid)).digest("hex");
  const hvsc = at("hvsc");
  fs.mkdirSync(path.join(hvsc, "DOCUMENTS"), { recursive: true });
  fs.mkdirSync(path.join(hvsc, "DEMOS"), { recursive: true });
  fs.copyFileSync(sid, path.join(hvsc, "DEMOS", "Info.sid"));
  fs.writeFileSync(path.join(hvsc, "DOCUMENTS", "Songlengths.md5"), `[Database]\n; /DEMOS/Info.sid\n${md5}=1:05\n`);
  fs.writeFileSync(path.join(hvsc, "DOCUMENTS", "STIL.txt"), "/DEMOS/Info.sid\nCOMMENT: A test tune.\n\n");
  const data = await ok({ op: "sid_info", inputPath: path.join(hvsc, "DEMOS", "Info.sid"), hvscDir: hvsc });
  assert.equal(data.magic, "PSID");
  assert.deepEqual(data.songlengths, [65]);
  assert.equal(data.hvscPath, "/DEMOS/Info.sid");
  assert.equal(data.stil.found, true);
  const config = write("sidid.cfg", `Test_Player\n${fs.readFileSync(sid).subarray(0x7e + 20, 0x7e + 28).toString("hex").match(/../g).join(" ")} end\n`);
  assert.equal((await ok({ op: "sid_info", inputPath: sid, sidIdPath: config })).players[0].player, "Test_Player");
  await rejected({ op: "sid_info", inputPath: SHORT }, /SID|magic/i);
});

test("reconstruct recovers a score from a SID with a verdict, progress and a verifiable result", async () => {
  const sid = (await ok({ op: "compile", sidwave: SCORE, output: "sid", outputPath: at("source.sid") })).outputPath;
  const ctx = machine();
  const data = await ok({ op: "reconstruct", inputPath: sid, durationSeconds: 3, outputPath: at("recovered.yaml") }, ctx);
  assert.ok(["strict_exact", "register_state_exact", "differs", "recompile_failed"].includes(data.verdict), data.verdict);
  assert.equal(data.strictExact, data.verdict === "strict_exact");
  assert.equal(data.horizon.seconds, 3);
  assert.equal((await ok({ op: "validate", inputPath: data.outputPath })).valid, true);
  assert.ok(ctx.progress.length >= 2, "progress is reported");
  assert.ok(ctx.progress.every((entry, i) => i === 0 || entry.completed > ctx.progress[i - 1].completed), "progress increases");

  const compared = await ok({ op: "compare", inputPath: sid, comparePath: data.outputPath, durationSeconds: 3, level: "T0" });
  assert.equal(typeof compared.equal, "boolean");
  assert.ok(compared.verification.verdict === "pass" || compared.verification.verdict === "fail");

  const dump = await ok({ op: "convert", inputPath: sid, to: "vice-dump", durationSeconds: 3, outputPath: at("source.dump") });
  const fromTrace = await ok({ op: "reconstruct", inputPath: dump.outputPath, outputPath: at("from-trace.yaml") });
  assert.equal(fromTrace.trace.format, "vice-dump");
  await rejected({ op: "reconstruct", inputPath: SHORT }, /use op convert/);
  await rejected({ op: "reconstruct", inputPath: sid, song: 2 }, /song must be/);
});

test("a cancelled reconstruction stops and writes nothing", async () => {
  const sid = (await ok({ op: "compile", sidwave: SCORE, output: "sid", outputPath: at("cancel.sid") })).outputPath;
  // Pass 1 traces the input; the library records a failure of pass 2 in its report instead of throwing it.
  for (const pass of [1, 2]) {
    const controller = new AbortController();
    const passes = new Set();
    const ctx = {
      ...machine(),
      signal: controller.signal,
      reportProgress: (completed, total, message) => {
        passes.add(message);
        if (message.endsWith(`pass ${pass}`)) controller.abort();
      },
    };
    const output = at(`cancelled-${pass}.yaml`);
    const { result } = await sound({ op: "reconstruct", inputPath: sid, durationSeconds: 120, outputPath: output }, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.metadata.cancelled, true);
    assert.equal(passes.size, pass, `no engine pass runs after the cancelled pass ${pass}`);
    assert.equal(fs.existsSync(output), false);
  }
});

test("compare reports equal scores and the musical differences of different ones", async () => {
  const same = await ok({ op: "compare", sidwave: SCORE, comparePath: write("same.yaml", SCORE), ladder: false, durationSeconds: 2 });
  assert.equal(same.equal, true);
  assert.equal(same.verification, undefined);
  const other = await ok({ op: "compare", sidwave: SCORE, comparePath: write("other.yaml", SCORE.replace("E4", "F4")), ladder: false, durationSeconds: 2 });
  assert.equal(other.equal, false);
  assert.ok(other.musical.changes > 0);
});

test("analyze_music describes a score and a SID", async () => {
  const score = await ok({ op: "analyze_music", inputPath: SHORT, durationSeconds: 3 });
  assert.equal(score.source.kind, "score");
  assert.ok(score.voices.length >= 1);
  assert.ok(score.motifs.length <= 5);
  const sid = (await ok({ op: "compile", sidwave: SCORE, output: "sid", outputPath: at("analyze.sid") })).outputPath;
  const tune = await ok({ op: "analyze_music", inputPath: sid, durationSeconds: 3 });
  assert.equal(tune.source.kind, "sid");
  assert.ok(tune.reconstruction);
});

test("compose writes a valid score that follows the machine's clock", async () => {
  const data = await ok({ op: "compose", style: "funk", seed: 7, outputPath: at("composed.yaml") }, machine({ clock: 0 }));
  assert.deepEqual([data.system, data.style, data.seed], ["NTSC", "funk", 7]);
  assert.ok(data.bars > 0 && data.sections.length > 0);
  const checked = await ok({ op: "validate", inputPath: data.outputPath });
  assert.deepEqual([checked.valid, checked.mode], [true, "NTSC"]);
  const again = await ok({ op: "compose", style: "funk", seed: 7, system: "NTSC", outputPath: at("composed2.yaml") });
  assert.equal(again.sha256, data.sha256);
  await rejected({ op: "compose", profile: "polka" }, /Unknown composer profile/);
});

test("complete continues a score and keeps the original material", async () => {
  const composed = await ok({ op: "compose", seed: 11, system: "PAL", outputPath: at("base.yaml") });
  const data = await ok({ op: "complete", inputPath: composed.outputPath, action: "continue", bars: 4, outputPath: at("continued.yaml") });
  assert.equal(data.addedBars, 4);
  assert.equal(data.protected.identical, true);
  assert.equal((await ok({ op: "validate", inputPath: data.outputPath })).valid, true);
  await rejected({ op: "complete", inputPath: composed.outputPath, action: "rewrite" }, /Unknown complete action/);
});

const VOICE = `voices:
  - id: 1
    waveform: triangle
    patterns:
      main: { notes: [C4, E4] }
timeline:
  - { bars: 1, layers: { v1: main } }
`;
const library = (extra = "") => `sidwave: 1.4
library: { name: lib, version: 1.0.0, licence: CC0-1.0, provenance: { author: a, source: s, created: 2026-01-01 } }
${extra}instruments: { bell: { waveform: pulse } }
`;
const importing = (from) => `sidwave: 1.4
tempo: 120
imports:
  - { as: x, from: ${JSON.stringify(from)} }
${VOICE}`;

test("a score with imports is described, and a changed copy stays next to its libraries", async () => {
  fs.mkdirSync(at("imports"));
  write("imports/lib.yaml", library());
  const score = write("imports/song.sidwave.yaml", importing("lib.yaml"));
  const inspected = await ok({ op: "inspect", inputPath: score });
  assert.deepEqual([inspected.format, inspected.details.voices], ["sidwave", 1]);
  const changed = await ok({ op: "transform", inputPath: score, action: "transpose", semitones: 1 });
  assert.equal(path.dirname(changed.outputPath), fs.realpathSync(at("imports")));
  assert.equal((await ok({ op: "validate", inputPath: changed.outputPath })).valid, true);
});

test("imports may not leave the score directory or read hidden files, directly or through a library", async () => {
  fs.mkdirSync(at("confined/score"), { recursive: true });
  write("confined/outside.yaml", library());
  write("confined/score/.hidden.yaml", library());
  fs.symlinkSync(at("confined/outside.yaml"), at("confined/score/link.yaml"));
  write("confined/score/nested.yaml", library("imports:\n  - { as: y, from: .hidden.yaml }\n"));
  const check = async (from) => sound({ op: "validate", inputPath: write("confined/score/song.yaml", importing(from)) });
  for (const from of ["../outside.yaml", "link.yaml"]) {
    const { data } = await check(from);
    assert.equal(data.valid, false, from);
    assert.match(data.message, /outside the score directory/, from);
  }
  for (const from of [".hidden.yaml", "nested.yaml"]) {
    const { result, text } = await check(from);
    assert.equal(result.isError, true, from);
    assert.match(text, /hidden component/, from);
  }
  await rejected({ op: "inspect", inputPath: at("confined/score/song.yaml") }, /hidden component/);
});

test("pkg: imports and relative names with a colon obey the same host path rules", async () => {
  fs.mkdirSync(at("pkg/score/node_modules/p"), { recursive: true });
  write("pkg/score/node_modules/p/lib.yaml", library());
  write("pkg/score/node_modules/p/.hidden.yaml", library());
  write("pkg/score/.hidden.yaml", library());
  write("pkg/score/server.yaml", library());
  fs.symlinkSync(at("pkg/score/server.yaml"), at("pkg/score/node_modules/p/server.yaml"));
  fs.symlinkSync(at("pkg/score/.hidden.yaml"), at("pkg/score/a:b.yaml"));
  write("pkg/score/nested.yaml", library('imports:\n  - { as: y, from: "pkg:p/.hidden.yaml" }\n'));
  const check = (from) => sound({ op: "validate", inputPath: write("pkg/score/song.yaml", importing(from)) });
  assert.equal((await check("pkg:p/lib.yaml")).data.valid, true);
  const configured = process.env.C64BRIDGE_CONFIG;
  process.env.C64BRIDGE_CONFIG = at("pkg/score/server.yaml");
  try {
    for (const [from, refusal] of [
      ["pkg:p/.hidden.yaml", /hidden component/],
      ["nested.yaml", /hidden component/],
      ["a:b.yaml", /hidden component/],
      ["pkg:p/server.yaml", /server configuration or state file/],
    ]) {
      const { result, text } = await check(from);
      assert.equal(result.isError, true, from);
      assert.match(text, refusal, from);
    }
    // A file outside the allowed roots is refused the same way whether or not it exists.
    for (const from of ["/etc/hostname", "/etc/c64bridge-no-such-file"].map((file) => path.relative(at("pkg/score"), file))) {
      const { result, text } = await check(from);
      assert.equal(result.isError, true, from);
      assert.match(text, /outside the allowed directories/, from);
    }
  } finally {
    if (configured === undefined) delete process.env.C64BRIDGE_CONFIG;
    else process.env.C64BRIDGE_CONFIG = configured;
  }
});

test("an existing output file is refused before any long work, and a game build never replaces its input", async () => {
  const sid = (await ok({ op: "compile", sidwave: SCORE, output: "sid", outputPath: at("early.sid") })).outputPath;
  const taken = write("taken.yaml", "keep");
  const ctx = machine();
  await rejected({ op: "reconstruct", inputPath: sid, durationSeconds: 3, outputPath: taken }, /exists; pass overwrite/, ctx);
  assert.equal(ctx.progress.length, 0, "no engine pass ran");
  assert.equal(fs.readFileSync(taken, "utf8"), "keep");

  fs.mkdirSync(at("self"));
  const input = write("self/level.bin", fs.readFileSync(path.join(EXAMPLES, "game_songs.yaml")));
  await rejected({ op: "compile", inputPath: input, output: "game", origin: 0x8000, outputDir: at("self"), overwrite: true }, /input file/);
  assert.deepEqual(fs.readdirSync(at("self")), ["level.bin"]);
});

test("outputs and imports cannot escape through symbolic links", async () => {
  const outside = fs.mkdtempSync(path.join(process.cwd(), ".sidwave-outside-"));
  const previous = process.cwd();
  fs.mkdirSync(at("links"));
  fs.writeFileSync(path.join(outside, "keep.prg"), "keep");
  fs.symlinkSync(outside, at("links/dir"));
  fs.symlinkSync(path.join(outside, "keep.prg"), at("links/file.prg"));
  fs.symlinkSync(path.join(outside, "keep.prg"), at("links/score.bin"));
  try {
    process.chdir(work);
    for (const args of [
      { op: "compile", sidwave: SCORE, outputPath: at("links/dir/new.prg") },
      { op: "compile", sidwave: SCORE, outputPath: at("links/file.prg"), overwrite: true },
      { op: "compile", sidwave: SCORE, output: "game", origin: 0x8000, outputDir: at("links"), overwrite: true },
      { op: "inspect", inputPath: at("links/file.prg") },
    ]) {
      await rejected(args, /outside the allowed directories/);
    }
    assert.deepEqual(fs.readdirSync(outside), ["keep.prg"]);
    assert.equal(fs.readFileSync(path.join(outside, "keep.prg"), "utf8"), "keep");
  } finally {
    process.chdir(previous);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

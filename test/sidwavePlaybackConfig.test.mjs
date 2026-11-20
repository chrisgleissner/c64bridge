import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { audioModule } from "../src/tools/audio.js";
import { metaModule } from "../src/tools/meta/index.js";

const ADDRESSING = "SID Addressing";
const SOCKETS = "SID Sockets Configuration";
const MIXER = "Audio Mixer";
const ULTISID = "UltiSID Configuration";
const clocks = "Board clock settings";
const score = (sids, options = {}) => ({
  sidwave: 1.2, mode: "PAL", tempo: 120, title: "Setup test", sids,
  voices: [{ id: 1, patterns: { A: { groove: ["C4"] } } }],
  timeline: [{ bars: 1, layers: { v1: "A" } }],
  ...options,
});
const logger = { info() {}, warn() {}, debug() {}, error() {} };
const ok = { success: true };

function hardware(type = "c64u", registers = "U64 Turbo Registers") {
  const calls = [];
  const memory = new Uint8Array(65536);
  const config = {
    [ADDRESSING]: {
      "Auto Address Mirroring": "Enabled", "UltiSID Range Split": "Off", "Ext DualSID Range Split": "A9",
      "UltiSID 1 Address": "$D440", "UltiSID 2 Address": "$D460",
      "SID Socket 1 Address": "$D400", "SID Socket 2 Address": "$D420",
    },
    [SOCKETS]: { "SID Socket 1": "Disabled", "SID Socket 2": "Disabled", "SID Detected Socket 1": "6581", "SID Detected Socket 2": "8580" },
    [MIXER]: { "Pan UltiSID 1": "Center", "Pan UltiSID 2": "Center", "Pan Socket 1": "Center", "Pan Socket 2": "Center" },
    [ULTISID]: { "Digis Level": "Medium" },
    [clocks]: { "Turbo Control": "Manual", "CPU Speed": " 4" },
  };
  const configBaseline = structuredClone(config);
  const facade = {
    type,
    async configsList() { calls.push(["list"]); return { categories: Object.keys(config) }; },
    async configGet(category, item) {
      calls.push(["get", category, item]);
      if (item) {
        return { [category]: { [item]: { current: config[category][item], values: ["Off", "Manual", registers, "TurboEnable Bit"] } } };
      }
      return { [category]: { ...config[category] }, errors: [] };
    },
    async configBatchUpdate(payload) {
      calls.push(["write", structuredClone(payload)]);
      for (const [category, fields] of Object.entries(payload)) Object.assign(config[category], fields);
      return ok;
    },
    async runPrg() { calls.push(["run"]); return ok; },
    async sidplayAttachment() { calls.push(["attachment"]); return ok; },
    async reset() { calls.push(["reset"]); return ok; },
    async readMemory(address, length) { return memory.slice(address, address + length); },
    async writeMemory(address, data) { calls.push(["mem", address]); memory.set(data, address); },
  };
  return { facade, calls, config, configBaseline, memory };
}

function clientFor(facade, others = []) {
  // Exercise the real client transition methods with only in-memory facades.
  const facadePromise = Promise.resolve(facade);
  return Object.assign(Object.create(C64Client.prototype), {
    facadePromise, activeType: facade.type, initPromise: Promise.resolve(),
    allFacades: new Map([[facade.type, facadePromise], ...others.map((other) => [other.type, Promise.resolve(other)])]),
    sidwaveSessions: new Map(), sidwaveQueue: new WeakMap(), pendingSidwave: 0,
    sidControl: new WeakMap(), sidVolume: new WeakMap(), pauseStates: new WeakMap(),
  });
}

const expectedAddressing = (sockets) => ({
  "Auto Address Mirroring": "Disabled", "UltiSID Range Split": "1/4 (A7,A8)",
  "UltiSID 1 Address": "$D400", "UltiSID 2 Address": "$D420",
  "SID Socket 1 Address": sockets >= 1 ? "$D440" : "Unmapped",
  "SID Socket 2 Address": sockets >= 2 ? "$D460" : "Unmapped",
  "Ext DualSID Range Split": "Off",
});

for (const [layout, sockets, backend] of [
  ["ultisid8", 0, "c64u"], ["ultisid8+socket1", 1, "c64u"], ["ultisid8+sockets", 2, "u2"],
]) {
  test(`configure writes the exact ${layout} decoder and socket settings and restores them on stop`, async () => {
    const { facade, memory, calls, config, configBaseline } = hardware(backend);
    const client = clientFor(facade);
    const doc = parseSidwave(score({ layout }));
    const compiled = compileSidwaveToPrg(doc);
    await client.playSidwave(doc, compiled, { configure: true });
    const socketsWrite = sockets === 0 ? {} : { [SOCKETS]: {
      "SID Socket 1": "Enabled", ...(sockets === 2 ? { "SID Socket 2": "Enabled" } : {}),
    } };
    const writes = () => calls.filter(([op]) => op === "write").map(([, payload]) => payload);
    assert.deepEqual(writes(), [{ [ADDRESSING]: expectedAddressing(sockets), ...socketsWrite }]);
    assert.deepEqual(calls.filter(([op]) => op === "get").map(([, name]) => name), [ADDRESSING, SOCKETS, MIXER, ULTISID]);
    assert.equal(calls.at(-1)[0], "run");
    memory.set([compiled.irqAddress & 255, compiled.irqAddress >> 8], 0x0314);
    await client.stopSidwavePlayback();
    assert.deepEqual([...memory.slice(0x0314, 0x0316)], [0x31, 0xea]);
    assert.deepEqual(config, configBaseline);
    assert.equal(writes().length, 2);
    for (const sid of doc.sids) assert.ok(calls.some(([op, address]) => op === "mem" && address === sid.address + 24));
  });
}

for (const [action, replace] of [
  ["replace SIDWAVE", (client, doc, compiled) => client.playSidwave(doc, compiled, { configure: true })],
  ["run_prg", (client, _doc, compiled) => client.runPrg(compiled.prg)],
  ["reset", (client) => client.reset()],
  ["switch", (client) => client.switchBackend("u2")],
  ["silence", (client) => client.sidSilenceAll()],
]) {
  test(`restores the backend snapshot before ${action}`, async () => {
    const { facade, calls, config, configBaseline } = hardware();
    const other = hardware("u2");
    const client = clientFor(facade, [other.facade]);
    const doc = parseSidwave(score({ layout: "ultisid8" }));
    const compiled = compileSidwaveToPrg(doc);
    await client.playSidwave(doc, compiled, { configure: true });
    const first = calls.length;
    await replace(client, doc, compiled);
    const tail = calls.slice(first);
    assert.deepEqual(tail[0], ["write", { [ADDRESSING]: configBaseline[ADDRESSING] }]);
    if (action === "replace SIDWAVE") {
      assert.deepEqual(tail.filter(([op]) => op === "write").at(-1), ["write", { [ADDRESSING]: expectedAddressing(0) }]);
      await client.stopSidwavePlayback();
    }
    if (action === "switch") {
      assert.equal(await client.getActiveBackendType(), "u2");
      assert.deepEqual(other.calls, []);
    }
    assert.deepEqual(config, configBaseline);
  });
}

for (const registers of ["U64 Turbo Registers", "C64U Turbo Registers"]) {
  test(`configure selects the advertised ${registers} label and sets one pan per decoder`, async () => {
    const { facade, calls, config, configBaseline } = hardware("c64u", registers);
    const client = clientFor(facade);
    const doc = parseSidwave(score([
      { id: "a", address: "$D400", pan: "Left 5" }, { id: "b", address: "$D480", pan: "Left 5" },
      { id: "c", address: "$D420", pan: "Right 4" }, { id: "socket", address: "$D440", pan: "Right 3" },
    ], { cpu: "turbo" }));
    await client.playSidwave(doc, compileSidwaveToPrg(doc), { configure: true });
    assert.ok(calls.some(([op, category, item]) => op === "get" && category === clocks && item === "Turbo Control"));
    const [, plan] = calls.find(([op]) => op === "write");
    assert.deepEqual(plan[MIXER], { "Pan UltiSID 1": "Left 5", "Pan UltiSID 2": "Right 4", "Pan Socket 1": "Right 3" });
    assert.deepEqual(plan[clocks], { "Turbo Control": registers });
    await client.stopSidwavePlayback();
    assert.deepEqual(config, configBaseline);
  });
}

test("a partially applied configuration is rolled back when setup fails", async () => {
  const { facade, calls, config, configBaseline } = hardware();
  const client = clientFor(facade);
  const doc = parseSidwave(score({ layout: "ultisid8+socket1" }));
  const write = facade.configBatchUpdate;
  let fail = true;
  facade.configBatchUpdate = async (payload) => {
    await write(payload);
    if (fail) { fail = false; return { success: false }; }
    return ok;
  };
  await assert.rejects(() => client.playSidwave(doc, compileSidwaveToPrg(doc), { configure: true }), /apply SIDWAVE settings/);
  assert.deepEqual(config, configBaseline);
  assert.ok(!calls.some(([op]) => op === "run"));
});

test("VICE probes and sets exact Binary Monitor resources and refuses more than eight SIDs", async () => {
  const calls = [];
  const state = { SidStereo: 1, ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`Sid${2 + i}AddressStart`, 0xd420 + i * 32])) };
  const before = { ...state };
  const facade = {
    type: "vice",
    withMonitor: (fn) => fn({
      async resourceGet(name) { calls.push(["get", name]); return { value: state[name] }; },
      async resourceSet(name, value) { calls.push(["set", name, value]); state[name] = value; },
    }),
    async runPrg() { calls.push(["run"]); return ok; },
    async readMemory() { return new Uint8Array(2); },
  };
  const client = clientFor(facade);
  const doc = parseSidwave(score({ layout: "ultisid8" }));
  await client.playSidwave(doc, compileSidwaveToPrg(doc));
  assert.deepEqual(calls.filter(([op]) => op === "get").map(([, name]) => name), Object.keys(before));
  assert.deepEqual(calls.filter(([op]) => op === "set"), [
    ...doc.sids.slice(1).map(({ address }, i) => ["set", `Sid${2 + i}AddressStart`, address]),
    ["set", "SidStereo", 7],
  ]);
  await client.stopSidwavePlayback();
  assert.deepEqual(state, before);
  const large = parseSidwave(score({ layout: "ultisid8+socket1" }));
  await assert.rejects(() => client.playSidwave(large, compileSidwaveToPrg(large)), /VICE 3.10 supports at most 8 SIDs/);
});

test("compile_play warns about the map and turbo when configure is omitted", async () => {
  const { facade, calls } = hardware();
  const client = clientFor(facade);
  const result = await audioModule.invoke("music_compile_and_play", {
    sidwave: score({ layout: "ultisid8+socket1" }, { cpu: "turbo" }),
  }, { client, logger, platform: { id: "c64u" } });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Auto Address Mirroring=Disabled/);
  assert.match(result.content[0].text, /SID Socket 1 Address=\$D440/);
  assert.match(result.content[0].text, /U64 Turbo Registers.*C64U Turbo Registers/);
  assert.deepEqual(calls, [["run"]]);
});

test("compiled playback, pipeline, preset and generator all forward configure", async () => {
  const setup = [];
  const ctx = {
    client: {
      async playSidwave(doc, _compiled, options) { setup.push([doc.sids.length, options.configure]); return ok; },
      async getActiveBackendType() { return "c64u"; }, getAvailableBackends() { return ["c64u"]; },
      switchBackend() {}, async sidSilenceAll() { return ok; },
      async recordAndAnalyzeAudio() {
        return { analysis: { source: "mock", voices: [], global_metrics: { average_rms: 0.1, max_rms: 0.1 } } };
      },
    },
    setPlatform() {}, logger, platform: { id: "c64u" },
  };
  const doc = score({ layout: "ultisid8" });
  const results = [
    await audioModule.invoke("music_compile_and_play", { sidwave: doc, configure: true }, ctx),
    await metaModule.invoke("music_compile_play_analyze", {
      sidwave: JSON.stringify(doc), configure: true, waitBeforeCaptureMs: 0,
    }, ctx),
    await metaModule.invoke("music_play_preset", { configure: true }, ctx),
    await audioModule.invoke("music_generate", { configure: true, system: "PAL" }, ctx),
  ];
  assert.ok(results.every((result) => !result.isError), JSON.stringify(results.filter((result) => result.isError)));
  assert.deepEqual(setup, [[8, true], [8, true], [1, true], [1, true]]);
});

test("stopping a configured digi PRG detaches its CIA2 NMI before restoring the decoder map", async () => {
  const { facade, calls, memory, config, configBaseline } = hardware();
  const client = clientFor(facade);
  const doc = parseSidwave(score({ layout: "ultisid8" }, { samples: {
    rate: 2000, voices: [{ sid: "sid2", at: [0], hex: "018f" }],
  } }));
  const compiled = compileSidwaveToPrg(doc);
  await client.playSidwave(doc, compiled, { configure: true });
  memory.set([compiled.irqAddress & 255, compiled.irqAddress >> 8], 0x0314);
  memory.set([compiled.digiNmiAddress & 255, compiled.digiNmiAddress >> 8], 0x0318);
  memory.set([0x47, 0xfe], compiled.digiChainAddress + 1);
  const first = calls.length;
  await client.stopSidwavePlayback();
  assert.deepEqual(calls.slice(first, first + 4), [["mem", 0x0314], ["mem", 0xdd0d], ["mem", 0xdd0e], ["mem", 0x0318]]);
  assert.deepEqual([...memory.slice(0x0318, 0x031a)], [0x47, 0xfe]);
  assert.equal(calls.at(-1)[0], "write");
  assert.deepEqual(config, configBaseline);
});

test("parts of one UltiSID cannot request different hardware pans", async () => {
  const { facade, calls } = hardware();
  const client = clientFor(facade);
  const doc = parseSidwave(score([
    { id: "a", address: "$D400", pan: "Left 3" }, { id: "b", address: "$D500", pan: "Right 3" },
  ]));
  await assert.rejects(() => client.playSidwave(doc, compileSidwaveToPrg(doc), { configure: true }), /Conflicting values for Pan UltiSID 1/);
  assert.ok(calls.every(([op]) => op !== "write" && op !== "run"));
});

test("configure refuses a map that needs a socket without a detected chip and writes nothing", async () => {
  const { facade, calls, config } = hardware("c64u");
  config[SOCKETS]["SID Detected Socket 2"] = "None";
  const client = clientFor(facade);
  const doc = parseSidwave(score({ layout: "ultisid8+sockets" }));
  await assert.rejects(client.playSidwave(doc, compileSidwaveToPrg(doc), { configure: true }), /SID socket 2, but no chip is detected/);
  assert.equal(calls.filter(([op]) => op === "write").length, 0);
  assert.equal(calls.filter(([op]) => op === "run").length, 0);
});

test("the socket layout refuses an explicitly empty socket before applying settings", async () => {
  const { facade, calls, config } = hardware();
  const client = clientFor(facade);
  config[SOCKETS]["SID Detected Socket 1"] = "None";
  const doc = parseSidwave(score({ layout: "ultisid8+socket1" }));
  await assert.rejects(() => client.playSidwave(doc, compileSidwaveToPrg(doc), { configure: true }), /SID socket 1, but no chip is detected/);
  assert.ok(calls.every(([op]) => op !== "write" && op !== "run"));
});

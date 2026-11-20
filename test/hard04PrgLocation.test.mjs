import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { C64Client } from "../src/c64Client.js";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });
const text = (res) => res.content.map((c) => c.text ?? "").join("\n");

async function setup(t) {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h4-prg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new C64Client(mock.baseUrl);
  const ctx = { client, logger, platform: platform("c64u"), setPlatform: () => platform("c64u") };
  return { mock, dir, ctx };
}

test("HARD04-001 run_prg and load_prg with location host upload the exact file bytes", async (t) => {
  const { mock, dir, ctx } = await setup(t);
  const file = path.join(dir, "game.prg");
  const bytes = Buffer.from([0x01, 0x08, 0xa9, 0x01, 0x60, 0x00, 0xff]);
  fs.writeFileSync(file, bytes);

  const run = await programRunnersModule.invoke("run_prg", { path: file, location: "host" }, ctx);
  assert.equal(run.isError, undefined, text(run));
  assert.ok(mock.state.requestOrder.includes("POST /v1/runners:run_prg"));
  assert.deepEqual([...mock.state.lastPrg], [...bytes]);
  assert.equal(run.structuredContent.data.location, "host");
  assert.equal(run.structuredContent.data.loadAddress, 0x0801);

  const load = await programRunnersModule.invoke("load_prg", { path: file, location: "host" }, ctx);
  assert.equal(load.isError, undefined, text(load));
  assert.deepEqual([...mock.state.lastLoadedPrg], [...bytes]);
  assert.equal(load.structuredContent.data.location, "host");
  assert.equal(load.structuredContent.data.loadAddress, 0x0801);
});

test("HARD04-001 default location stays a device path and reports it", async () => {
  const paths = [];
  const ctx = {
    client: { async runPrgFile(p) { paths.push(p); return { success: true }; }, async runPrg() { throw new Error("must not upload"); } },
    logger, platform: platform("c64u"), setPlatform: () => platform("c64u"),
  };
  const run = await programRunnersModule.invoke("run_prg", { path: "//USB0/demo.prg" }, ctx);
  assert.equal(run.isError, undefined, text(run));
  assert.equal(run.structuredContent.data.location, "device");
  assert.deepEqual(paths, ["//USB0/demo.prg"]);
});

test("HARD04-001 host files outside the roots or over 65538 bytes are rejected before any request", async (t) => {
  const { mock, dir, ctx } = await setup(t);
  const before = mock.state.requestOrder.length;
  const big = path.join(dir, "big.prg");
  fs.writeFileSync(big, Buffer.alloc(65539, 1));
  const tiny = path.join(dir, "tiny.prg");
  fs.writeFileSync(tiny, Buffer.alloc(1, 1));
  const outsideDir = fs.mkdtempSync("/dev/shm/c64bridge-h4-out-");
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, "x.prg");
  fs.writeFileSync(outside, Buffer.from([1, 8, 0]));
  for (const file of [big, tiny, outside]) {
    for (const op of ["run_prg", "load_prg"]) {
      const res = await programRunnersModule.invoke(op, { path: file, location: "host" }, ctx);
      assert.equal(res.isError, true, `${op} ${file}`);
    }
  }
  assert.equal(mock.state.requestOrder.length, before);
  assert.equal(mock.state.lastPrg, null);
  assert.equal(mock.state.lastLoadedPrg ?? null, null);
});

test("HARD04-001 location device is rejected on VICE", async () => {
  let calls = 0;
  const ctx = {
    client: { async runPrgFile() { calls += 1; return { success: true }; } },
    logger, platform: platform("vice"), setPlatform: () => platform("vice"),
  };
  const res = await programRunnersModule.invoke("run_prg", { path: "/tmp/x.prg", location: "device" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(calls, 0);
  const ok = await programRunnersModule.invoke("run_prg", { path: "/tmp/x.prg", location: "host" }, ctx);
  assert.equal(ok.isError, undefined, text(ok));
  assert.equal(calls, 1);
});

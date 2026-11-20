import test from "#test/runner";
import assert from "#test/assert";
import { viceModuleGroup } from "../src/tools/vice.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createCtx(overrides = {}) {
  return {
    client: {
      async viceResourceGet() {
        return { type: "string", value: "demo" };
      },
      async viceResourceSet() {},
    },
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
    ...overrides,
  };
}

test("c64_vice resource_get returns JSON payload for SidEngine", async () => {
  const calls = [];
  const ctx = createCtx({
    client: {
      async viceResourceGet(name) {
        calls.push(name);
        return { type: "int", value: 1 };
      },
      async viceResourceSet() {},
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "SidEngine" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.name, "SidEngine");
  assert.equal(result.metadata.type, "int");
  assert.deepEqual(result.structuredContent?.data, {
    name: "SidEngine",
    type: "int",
    value: 1,
  });
  assert.deepEqual(calls, ["SidEngine"]);
});

test("c64_vice resource_get supports integer values", async () => {
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "int", value: 2 };
      },
      async viceResourceSet() {},
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "VICIIDoubleSize" },
    ctx,
  );

  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.type, "int");
  assert.deepEqual(result.structuredContent?.data, {
    name: "VICIIDoubleSize",
    type: "int",
    value: 2,
  });
});

test("VICE-12 c64_vice resource_get returns an empty string value instead of an error", async () => {
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "string", value: "" };
      },
      async viceResourceSet() {},
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "MachineVideoStandard" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent?.data, { name: "MachineVideoStandard", type: "string", value: "" });
});

test("c64_vice resource_get rejects unsafe resource names", async () => {
  const ctx = createCtx();

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "Drive8Type" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
  assert.equal(result.metadata.error.path, "$.name");
});

test("c64_vice resource_set writes string resource values", async () => {
  const calls = [];
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "string", value: "demo" };
      },
      async viceResourceSet(name, value) {
        calls.push({ name, value });
      },
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_set", name: "MachineVideoStandard", value: "PAL" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.name, "MachineVideoStandard");
  assert.equal(result.metadata.value, "PAL");
  assert.deepEqual(calls, [{ name: "MachineVideoStandard", value: "PAL" }]);
});

test("c64_vice resource_set rejects non-integer numbers", async () => {
  const ctx = createCtx();

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_set", name: "SidEngine", value: 1.5 },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
  assert.equal(result.metadata.error.path, "$.value");
});

test("c64_vice resource_set writes integer resource values", async () => {
  const calls = [];
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "int", value: 1 };
      },
      async viceResourceSet(name, value) {
        calls.push({ name, value });
      },
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_set", name: "SidEngine", value: 2 },
    ctx,
  );

  assert.equal(result.metadata.success, true);
  assert.deepEqual(calls, [{ name: "SidEngine", value: 2 }]);
});

function typedResourceCtx(type, calls) {
  return createCtx({
    client: {
      async viceResourceGet(name) {
        calls.push({ get: name });
        return { type, value: type === "int" ? 0 : "" };
      },
      async viceResourceSet(name, value) {
        calls.push({ name, value });
      },
    },
  });
}

test("VICE-12 c64_vice resource_set converts the value to the type VICE reports for the resource", async () => {
  const cases = [
    { type: "int", value: "1", sent: 1 },
    { type: "int", value: " -3 ", sent: -3 },
    { type: "int", value: "true", sent: 1 },
    { type: "int", value: "FALSE", sent: 0 },
    { type: "string", value: 50, sent: "50" },
  ];
  for (const { type, value, sent } of cases) {
    const calls = [];
    const result = await viceModuleGroup.invoke(
      "c64_vice",
      { op: "resource_set", name: "WarpMode", value },
      typedResourceCtx(type, calls),
    );
    assert.equal(result.isError, undefined, JSON.stringify({ type, value, result }));
    assert.deepEqual(calls, [{ get: "WarpMode" }, { name: "WarpMode", value: sent }], JSON.stringify({ type, value }));
    assert.equal(result.metadata.type, type);
    assert.equal(result.metadata.value, sent);
    assert.match(result.content[0].text, new RegExp(`WarpMode \\(${type}\\) to ${JSON.stringify(sent)}`));
  }
});

test("VICE-12 c64_vice resource_set refuses a non-integer text for an integer resource without writing", async () => {
  for (const value of ["PAL", "1.5", "0x10", "4294967296"]) {
    const calls = [];
    const result = await viceModuleGroup.invoke(
      "c64_vice",
      { op: "resource_set", name: "WarpMode", value },
      typedResourceCtx("int", calls),
    );
    assert.equal(result.isError, true, value);
    assert.equal(result.metadata.error.kind, "validation");
    assert.equal(result.metadata.error.path, "$.value");
    assert.deepEqual(calls, [{ get: "WarpMode" }], value);
  }
});

test("VICE-12 c64_vice resource_set on the monitor mock stores an integer resource as an integer", async (t) => {
  const { ViceClient } = await import("../src/vice/viceClient.js");
  const { startViceMockServer } = await import("../src/vice/mockServer.js");
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.stop(); });
  const client = new ViceClient();
  t.after(() => client.close());
  await client.connect(server.port);
  const ctx = createCtx({
    client: {
      viceResourceGet: (name) => client.resourceGet(name),
      viceResourceSet: (name, value) => client.resourceSet(name, value),
    },
  });

  const result = await viceModuleGroup.invoke("c64_vice", { op: "resource_set", name: "SidEngine", value: "0" }, ctx);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(await client.resourceGet("SidEngine"), { type: "int", value: 0 });
});

test("c64_vice resource_get rejects invalid resource name syntax", async () => {
  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "sid engine" },
    createCtx(),
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
  assert.equal(result.metadata.error.path, "$.name");
});

test("c64_vice wraps unexpected client errors", async () => {
  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "SidEngine" },
    createCtx({
      client: {
        async viceResourceGet() {
          throw new Error("socket gone");
        },
        async viceResourceSet() {},
      },
    }),
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "unknown");
});

test("c64_vice describes a flattened Claude-compatible input schema", () => {
  const [descriptor] = viceModuleGroup.describeTools();

  assert.deepEqual(descriptor.inputSchema.properties.op.enum, ["resource_get", "resource_set", "snapshot_save", "snapshot_restore", "version"]);
  assert.deepEqual(descriptor.inputSchema.properties.value.type, ["string", "integer"]);
  assert.equal(descriptor.inputSchema.oneOf, undefined);
  assert.equal(descriptor.inputSchema.discriminator, undefined);
});

test("S-04 c64_config on VICE applies the c64_vice resource policy on get, set and batch update", async () => {
  const { ViceBackend } = await import("../src/device.js");
  const backend = Object.create(ViceBackend.prototype);
  const touched = [];
  backend.withClient = async (fn) => fn({
    async resourceGet(item) { touched.push(["get", item]); return { type: "int", value: 1 }; },
    async resourceSet(item, value) { touched.push(["set", item, value]); },
  });

  // Accepted: WarpMode is on the shared list.
  await backend.configGet("VICE", "WarpMode");
  await backend.configSet("VICE", "WarpMode", "true");
  assert.deepEqual(touched, [["get", "WarpMode"], ["get", "WarpMode"], ["set", "WarpMode", 1]]);

  // Rejected on every path, before the client is touched.
  touched.length = 0;
  for (const name of ["FSDevice8Dir", "SoundRecordDeviceArg", "Kernal", "lowercase"]) {
    await assert.rejects(() => backend.configGet("VICE", name), /not allowed/, `get ${name}`);
    await assert.rejects(() => backend.configSet("VICE", name, "x"), /not allowed/, `set ${name}`);
    const batch = await backend.configBatchUpdate({ VICE: { [name]: "x", WarpMode: 0 } });
    assert.equal(batch.success, false);
    assert.equal(batch.details.results.find((entry) => entry.item === `VICE/${name}`).success, false);
    assert.equal(batch.details.results.find((entry) => entry.item === "VICE/WarpMode").success, true);
  }
  assert.ok(!touched.some((entry) => entry[1] !== "WarpMode"), JSON.stringify(touched));
});

test("HARD03-001 host-file VICE resources are refused in every spelling on both tool paths", async () => {
  const { resourceNameProblem } = await import("../src/vice/resourcePolicy.js");
  const { ViceBackend } = await import("../src/device.js");
  const canonical = [
    "SoundRecordDeviceArg", "SoundRecordDeviceName", "SoundDeviceArg", "SoundDeviceName",
    "VICIIPaletteFile", "JoyMapFile", "C64_256Kfilename", "C64_256KImageName",
    "SidFilterFile", "FSDevice8Dir", "C64SoundRecordFile",
  ];
  const spellings = (name) => [name, name.toUpperCase(), name.toLowerCase(), name.replace(/[a-z]/g, (c, i) => (i % 2 ? c.toUpperCase() : c))];
  const backend = Object.create(ViceBackend.prototype);
  const touched = [];
  backend.withClient = async (fn) => fn({
    async resourceGet(item) { touched.push(item); return { type: "int", value: 1 }; },
    async resourceSet(item) { touched.push(item); },
  });
  for (const base of canonical) {
    for (const name of spellings(base)) {
      assert.ok(resourceNameProblem(name), `policy must refuse ${name}`);
      const viaTool = await viceModuleGroup.invoke("c64_vice", { op: "resource_set", name, value: "x" }, createCtx());
      assert.equal(viaTool.isError, true, `c64_vice must refuse ${name}`);
      await assert.rejects(() => backend.configSet("VICE", name, "x"), /not allowed/, `c64_config set ${name}`);
      await assert.rejects(() => backend.configGet("VICE", name), /not allowed/, `c64_config get ${name}`);
    }
  }
  assert.deepEqual(touched, []);
  for (const ok of ["WarpMode", "SidEngine", "WARPMODE", "SoundVolume", "MachineVideoStandard"]) {
    assert.equal(resourceNameProblem(ok), undefined, ok);
  }
});

test("HARD03-001 the VICE monitor mock matches resource names case-insensitively", async (t) => {
  const { ViceClient } = await import("../src/vice/viceClient.js");
  const { startViceMockServer } = await import("../src/vice/mockServer.js");
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.stop(); });
  const client = new ViceClient();
  t.after(() => client.close());
  await client.connect(server.port);

  assert.deepEqual(await client.resourceGet("SIDENGINE"), await client.resourceGet("SidEngine"));
  await client.resourceSet("sidengine", 3);
  assert.equal((await client.resourceGet("SidEngine")).value, 3);
  await assert.rejects(() => client.resourceGet("NoSuchResource"));
});

test("PROGMEM-15 c64_vice examples give SidEngine values only as the VICE manual defines them", () => {
  // VICE 3.10 manual (doc/vice.texi, SidEngine): 0 FastSID, 1 ReSID, 2 Catweasel MKIII, 3 HardSID.
  const [descriptor] = viceModuleGroup.describeTools();
  const examples = JSON.stringify(descriptor.metadata.examples);
  assert.ok(!/resid-fp/i.test(examples), examples);
  assert.ok(!/"op":"resource_set","name":"SidEngine"/.test(examples), examples);
  assert.match(examples, /0 FastSID, 1 ReSID/);
});

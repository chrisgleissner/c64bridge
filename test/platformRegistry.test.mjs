import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";

function createStubLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createSwitchClient(availableBackends = ["c64u", "vice"], activeBackend = "c64u") {
  let active = activeBackend;
  const switches = [];
  return {
    switches,
    getAvailableBackends() {
      return [...availableBackends];
    },
    switchBackend(target) {
      if (!availableBackends.includes(target)) {
        throw new Error(`Backend '${target}' is not configured`);
      }
      switches.push(target);
      active = target;
    },
    async getActiveBackendType() {
      return active;
    },
  };
}

function createCtx(client, setPlatformCalls, platform = "c64u") {
  return {
    client,
    rag: {},
    logger: createStubLogger(),
    platform: { id: platform, features: [], limitedFeatures: [] },
    setPlatform(target) {
      setPlatformCalls.push(target);
      return { id: target, features: [], limitedFeatures: [] };
    },
  };
}

test("HARD01-030 c64_select_backend stops a music_generate song on the old backend before switching", async () => {
  const events = [];
  const setPlatformCalls = [];
  const client = createSwitchClient(["c64u", "vice"], "vice");
  const viceFacade = { type: "vice" };
  client.pinFacade = async () => viceFacade;
  client.runPrg = async (_prg, facade) => { events.push(["run", facade]); return { success: true }; };
  client.stopSidwavePlayback = async (facade) => { events.push(["stop", facade]); };
  const switchBackend = client.switchBackend?.bind(client);
  client.switchBackend = (backend) => { events.push(["switch", backend]); return switchBackend?.(backend); };

  const scheduleResult = await toolRegistry.invoke(
    "c64_sound",
    { op: "generate", root: "C4", pattern: "0,4,7,12,16", steps: 5, tempoMs: 40 },
    createCtx(client, setPlatformCalls, "vice"),
  );
  assert.equal(scheduleResult.isError, undefined, JSON.stringify(scheduleResult));

  await toolRegistry.invoke(
    "c64_select_backend",
    { op: "select", backend: "c64u" },
    createCtx(client, setPlatformCalls, "vice"),
  );

  const kinds = events.map(([kind]) => kind);
  assert.deepEqual(kinds.slice(0, 3), ["run", "stop", "switch"]);
  assert.equal(events[1][1], viceFacade, "the player is stopped on the backend that runs it");
});

test("c64_select_backend switches to an available backend and updates platform state", async () => {
  const client = createSwitchClient(["c64u", "vice"], "c64u");
  const setPlatformCalls = [];

  const result = await toolRegistry.invoke(
    "c64_select_backend",
    { op: "select", backend: "vice" },
    createCtx(client, setPlatformCalls),
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(client.switches, ["vice"]);
  assert.deepEqual(setPlatformCalls, ["vice"]);
  assert.equal(result.structuredContent?.data?.activeBackend, "vice");
  assert.ok(result.structuredContent?.data?.availableTools.includes("c64_select_backend"));
  assert.ok(result.structuredContent?.data?.unavailableTools.includes("c64_printer"));
  assert.ok(result.structuredContent?.data?.unavailableOperations.includes("c64_disk.unmount"));
  assert.ok(!result.structuredContent?.data?.unavailableOperations.includes("c64_memory.read"));
});

test("c64_select_backend returns an error result when the backend is unavailable", async () => {
  const client = createSwitchClient(["c64u"], "c64u");
  const setPlatformCalls = [];

  const result = await toolRegistry.invoke(
    "c64_select_backend",
    { op: "select", backend: "vice" },
    createCtx(client, setPlatformCalls),
  );

  assert.equal(result.isError, true);
  assert.deepEqual(client.switches, []);
  assert.deepEqual(setPlatformCalls, []);
  assert.deepEqual(result.structuredContent?.data?.configuredBackends, ["c64u"]);
  assert.match(result.structuredContent?.data?.message ?? "", /not configured/);
});

test("c64_select_backend supports round-trip backend switching", async () => {
  const client = createSwitchClient(["c64u", "vice"], "c64u");
  const setPlatformCalls = [];
  const ctx = createCtx(client, setPlatformCalls);

  const toVice = await toolRegistry.invoke(
    "c64_select_backend",
    { op: "select", backend: "vice" },
    ctx,
  );
  const toC64u = await toolRegistry.invoke(
    "c64_select_backend",
    { op: "select", backend: "c64u" },
    ctx,
  );

  assert.equal(toVice.isError, undefined);
  assert.equal(toC64u.isError, undefined);
  assert.deepEqual(client.switches, ["vice", "c64u"]);
  assert.deepEqual(setPlatformCalls, ["vice", "c64u"]);
  assert.equal(toC64u.structuredContent?.data?.activeBackend, "c64u");
  assert.ok(toC64u.structuredContent?.data?.usageHint.includes('"vice"'));
});

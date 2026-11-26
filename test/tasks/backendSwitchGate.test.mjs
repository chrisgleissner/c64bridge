import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../../src/tools/registry/index.js";
import { __resetLeasesForTests } from "../../src/tasks/resources.js";
import { submitCall, __resetForTests } from "../../src/tasks/engine.js";
import { deferred, baseCtx } from "./helpers.mjs";

// The fake client calls the beforeSwitch hook the way C64Client.switchBackend does:
// only when the backend actually changes, before the change is applied.
function ctxWithLog() {
  let active = "c64u";
  const switches = [];
  const ctx = baseCtx({
    client: {
      getActiveBackendType: async () => active,
      getSelectedBackendType: () => active,
      pinFacade: async () => ({ type: active }),
      getAvailableBackends: () => ["c64u", "vice"],
      switchBackend: (backend, hook) => {
        if (backend !== active) hook?.(active);
        switches.push(`${active}->${backend}`);
        active = backend;
      },
      renderGreetingScreen: async () => ({ success: true }),
      readScreen: async () => "",
    },
    setPlatform() {},
  });
  return { ctx, switches, active: () => active };
}

function conflictCode(result) {
  return result.metadata?.error?.code ?? result.error?.code;
}

for (const [tool, args] of [
  ["c64_program", { op: "cross_platform_greeting", platforms: ["vice"], verify: false, captureScreenshot: false, restoreActiveBackend: false }],
  ["c64_sound", { op: "play_preset", preset: "title_fanfare", platforms: ["vice"], restoreActiveBackend: false }],
]) {
  test(`${tool} ${args.op} does not switch backends while an unpinned task holds a lease`, async () => {
    __resetLeasesForTests();
    __resetForTests();
    try {
      const { ctx, switches, active } = ctxWithLog();
      await submitCall({ tool: "c64_memory", op: "wait_for_text", ctx, invoke: () => deferred().promise });
      const select = await toolRegistry.invoke("c64_select_backend", { op: "select", backend: "vice" }, ctx).catch((e) => ({ error: e }));
      assert.equal(conflictCode(select), "resource_conflict");
      const result = await toolRegistry.invoke(tool, args, ctx).catch((e) => ({ error: e }));
      const text = JSON.stringify(result.content ?? result.error?.message ?? "");
      assert.ok(result.isError === true || result.error, `expected an error, got ${text}`);
      assert.ok(conflictCode(result) === "resource_conflict" || /resource_conflict|lease/i.test(text), text);
      assert.deepEqual(switches, []);
      assert.equal(active(), "c64u");
    } finally {
      __resetForTests();
    }
  });
}

test("greeting restore is refused when an exclusive task started on the greeting backend, and is reported", async () => {
  __resetLeasesForTests();
  __resetForTests();
  try {
    const { ctx, switches, active } = ctxWithLog();
    const gate = deferred();
    const entered = deferred();
    ctx.client.renderGreetingScreen = async () => {
      entered.resolve();
      await gate.promise;
      return { success: true };
    };
    const greeting = toolRegistry.invoke("c64_program", { op: "cross_platform_greeting", platforms: ["vice"], verify: false, captureScreenshot: false }, ctx);
    await entered.promise;
    const task = await submitCall({ tool: "c64_sound", op: "capture_samples", ctx, invoke: () => deferred().promise });
    gate.resolve();
    const result = await greeting;
    assert.deepEqual(switches, ["c64u->vice"], "restore to c64u must not retarget the exclusive task");
    assert.equal(active(), "vice");
    assert.equal(task.backendId, "vice");
    assert.ok(result.isError === true || JSON.stringify(result.content).includes("restore"), "the failed restore must be reported");
  } finally {
    __resetForTests();
  }
});

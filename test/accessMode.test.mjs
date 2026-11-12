import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { getAccessMode, isEffectAllowed } from "../src/tools/access.js";
import { metaModule } from "../src/tools/meta/index.js";

const EFFECTS = new Set(["read", "write", "destructive"]);

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Client that records every method call and fails it, so that no handler can reach a device.
function createRecordingClient(calls) {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (property === "getActiveBackendType") return async () => "c64u";
      if (property === "getAvailableBackends") return () => ["c64u"];
      return () => {
        calls.push(property);
        throw new Error(`recording client: ${property} is not available`);
      };
    },
  });
}

function createContext(calls = []) {
  return {
    client: createRecordingClient(calls),
    logger: createLogger(),
    rag: {},
    platform: { id: "c64u", features: [], limitedFeatures: [] },
    setPlatform: () => ({ id: "c64u", features: [], limitedFeatures: [] }),
  };
}

async function withAccess(value, fn) {
  const previous = process.env.C64BRIDGE_ACCESS;
  if (value === undefined) delete process.env.C64BRIDGE_ACCESS;
  else process.env.C64BRIDGE_ACCESS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
}

async function captureStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

function groupedOperations() {
  const result = [];
  for (const tool of toolRegistry.list()) {
    const ops = tool.inputSchema?.properties?.op?.enum;
    if (ops) result.push({ tool, ops });
  }
  return result;
}

async function isBlocked(toolName, args) {
  try {
    await toolRegistry.invoke(toolName, args, createContext());
    return false;
  } catch (error) {
    return /is blocked/.test(String(error?.message));
  }
}

test("every tool declares an effect and every operation of a grouped tool has one", () => {
  const tools = toolRegistry.list();
  assert.ok(tools.length >= 15);
  let operations = 0;
  for (const tool of tools) {
    const ops = tool.inputSchema?.properties?.op?.enum;
    if (!ops) {
      assert.ok(EFFECTS.has(tool.metadata.effect), `${tool.name} has no tool-level effect`);
      continue;
    }
    const declared = tool.metadata.operationEffects ?? {};
    for (const op of ops) {
      assert.ok(EFFECTS.has(declared[op]), `${tool.name}.${op} has no effect`);
      operations += 1;
    }
    for (const op of Object.keys(declared)) {
      assert.ok(ops.includes(op), `${tool.name} declares an effect for unknown op ${op}`);
    }
  }
  assert.ok(operations > 100, `checked ${operations} operations`);
});

test("effects of the dangerous operations", () => {
  const effect = (tool, op) => toolRegistry.list().find((entry) => entry.name === tool).metadata.operationEffects[op];
  for (const [tool, op] of [
    ["c64_system", "poweroff"], ["c64_system", "power_cycle"], ["c64_system", "reboot"],
    ["c64_config", "reset_defaults"], ["c64_config", "save_flash"], ["c64_config", "load_flash"],
    ["c64_config", "write_debugreg"], ["c64_drive", "load_rom"], ["c64_disk", "create_image"],
  ]) {
    assert.equal(effect(tool, op), "destructive", `${tool}.${op}`);
  }
  assert.equal(effect("c64_memory", "write"), "write");
  assert.equal(effect("c64_memory", "read"), "read");
  assert.equal(effect("c64_config", "set"), "write");
  assert.equal(effect("c64_select_backend", "select"), "write");
  assert.equal(effect("c64_rag", "basic"), "read");
});

test("each access mode blocks exactly its set of operations", async () => {
  const expectations = { full: [], "no-destructive": ["destructive"], "read-only": ["write", "destructive"] };
  let checked = 0;
  for (const [mode, blockedEffects] of Object.entries(expectations)) {
    await withAccess(mode, async () => {
      for (const { tool, ops } of groupedOperations()) {
        for (const op of ops) {
          const effect = tool.metadata.operationEffects[op];
          const blocked = await isBlocked(tool.name, { op });
          assert.equal(blocked, blockedEffects.includes(effect), `${mode}: ${tool.name}.${op} (${effect}) blocked=${blocked}`);
          checked += 1;
        }
      }
    });
  }
  assert.ok(checked > 300, `checked ${checked} calls`);
});

test("blocked calls name the operation, effect, mode and variable and never reach the client", async () => {
  const calls = [];
  await withAccess("read-only", async () => {
    await assert.rejects(
      () => toolRegistry.invoke("c64_system", { op: "poweroff" }, createContext(calls)),
      (error) => {
        assert.equal(error.kind, "validation");
        assert.match(error.message, /c64_system operation "poweroff" is blocked/);
        assert.match(error.message, /effect "destructive"/);
        assert.match(error.message, /access mode is "read-only"/);
        assert.match(error.message, /C64BRIDGE_ACCESS/);
        return true;
      },
    );
  });
  assert.deepEqual(calls, []);
});

test("an unset or empty variable means full; an unknown value behaves as read-only and warns once", async () => {
  await withAccess(undefined, async () => assert.equal(getAccessMode(), "full"));
  await withAccess("", async () => assert.equal(getAccessMode(), "full"));
  await withAccess("No-Destructive", async () => assert.equal(getAccessMode(), "no-destructive"));
  await withAccess("banana", async () => {
    const output = await captureStderr(async () => {
      assert.equal(getAccessMode(), "read-only");
      assert.equal(getAccessMode(), "read-only");
      assert.equal(await isBlocked("c64_memory", { op: "write" }), true);
      assert.equal(await isBlocked("c64_memory", { op: "read" }), false);
      assert.equal(await isBlocked("c64_system", { op: "poweroff" }), true);
    });
    assert.equal(output.match(/Unknown C64BRIDGE_ACCESS value "banana"/g)?.length, 1);
  });
  assert.equal(isEffectAllowed("no-destructive", "write"), true);
  assert.equal(isEffectAllowed("no-destructive", "destructive"), false);
});

test("config restore with applyToFlash is destructive; without it it is a write", async () => {
  await withAccess("no-destructive", async () => {
    assert.equal(await isBlocked("c64_config", { op: "restore", path: "x.json", applyToFlash: true }), true);
    assert.equal(await isBlocked("c64_config", { op: "restore", path: "x.json" }), false);
    assert.equal(await isBlocked("c64_config", { op: "restore", path: "x.json", applyToFlash: false }), false);
  });
  await withAccess("read-only", async () => {
    assert.equal(await isBlocked("c64_config", { op: "restore", path: "x.json" }), true);
  });
});

test("c64_batch checks every command at dispatch and reports blocked commands as failures", async () => {
  const calls = [];
  await withAccess("read-only", async () => {
    const result = await toolRegistry.invoke("c64_batch", {
      stopOnError: false,
      commands: [
        { tool: "c64_system", args: { op: "poweroff" } },
        { tool: "c64_memory", args: { op: "write", address: "$0400", bytes: "01" } },
        { tool: "c64_rag", args: { op: "basic", q: "print" } },
      ],
    }, createContext(calls));
    assert.equal(result.isError, true);
    const summary = result.structuredContent.data;
    assert.equal(summary.executed, 3);
    assert.match(summary.results[0].error, /c64_system operation "poweroff" is blocked/);
    assert.match(summary.results[1].error, /c64_memory operation "write" is blocked/);
    assert.ok(!/is blocked/.test(summary.results[2].error ?? ""));
  });
  assert.deepEqual(calls, []);

  await withAccess("no-destructive", async () => {
    const result = await toolRegistry.invoke("c64_batch", {
      commands: [{ tool: "c64_system", args: { op: "poweroff" } }],
    }, createContext(calls));
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.data.results[0].error, /effect "destructive"/);
  });
  assert.deepEqual(calls, []);
});

test("start_task takes the effect of its task operation", async () => {
  const system = toolRegistry.list().find((entry) => entry.name === "c64_system");
  assert.ok(system);
  const { systemModuleGroup } = await import("../src/tools/registry/system.js");
  const effectOf = (operation) => systemModuleGroup.effectOf("c64_system", { op: "start_task", name: "t", operation });
  assert.equal(effectOf("read"), "read");
  assert.equal(effectOf("read_memory"), "read");
  assert.equal(effectOf("read_screen"), "read");
  assert.equal(effectOf("write"), "write");
  assert.equal(effectOf("write_memory"), "write");
  assert.equal(effectOf("menu_button"), "write");

  await withAccess("read-only", async () => {
    assert.equal(await isBlocked("c64_system", { op: "start_task", name: "t", operation: "write", arguments: { address: "$0400", bytes: "01" } }), true);
    assert.equal(await isBlocked("c64_system", { op: "start_task", name: "t", operation: "menu_button" }), true);
    assert.equal(await isBlocked("c64_system", { op: "stop_task", name: "t" }), true);
    assert.equal(await isBlocked("c64_system", { op: "list_tasks" }), false);
  });
});

test("the background task module checks the task operation itself", async () => {
  await withAccess("read-only", async () => {
    const result = await metaModule.invoke("start_background_task", {
      name: "access-check", operation: "write", arguments: { address: "$0400", bytes: "01" },
    }, createContext());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /is blocked/);
    assert.match(result.content[0].text, /C64BRIDGE_ACCESS/);
  });
});

test("tool annotations follow the operation effects", () => {
  const byName = new Map(toolRegistry.list().map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("c64_rag").annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  });
  assert.equal(byName.get("c64_system").annotations.destructiveHint, true);
  assert.equal(byName.get("c64_system").annotations.readOnlyHint, false);
  assert.equal(byName.get("c64_memory").annotations.destructiveHint, false);
  assert.equal(byName.get("c64_memory").annotations.readOnlyHint, false);
  assert.equal(byName.get("c64_batch").annotations.readOnlyHint, false);
  assert.equal(byName.get("c64_batch").annotations.destructiveHint, true);
  for (const tool of toolRegistry.list()) {
    const effects = tool.metadata.operationEffects ? Object.values(tool.metadata.operationEffects) : [tool.metadata.effect];
    assert.equal(tool.annotations.readOnlyHint, effects.every((effect) => effect === "read"), tool.name);
    assert.equal(tool.annotations.destructiveHint, effects.includes("destructive"), tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
  }
});

test("operation lines in descriptions carry the effect unless it is read", () => {
  const description = (name) => toolRegistry.list().find((tool) => tool.name === name).inputSchema.description;
  assert.match(description("c64_system"), /\n- poweroff \[c64u, vice\] \[destructive\]: /);
  assert.match(description("c64_system"), /\n- reset \[write\]: /);
  assert.match(description("c64_system"), /\n- list_tasks: /);
  assert.match(description("c64_disk"), /\n- unmount \[c64u, u2\] \[write\]: /);
  assert.match(description("c64_disk"), /\n- create_image \[c64u, u2\] \[destructive\]: /);
});

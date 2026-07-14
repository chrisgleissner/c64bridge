import test from "#test/runner";
import assert from "#test/assert";
import { machineControlModule } from "../src/tools/machineControl.js";
import { getPlatformStatus, setPlatform } from "../src/platform.js";

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createMockClient(overrides = {}) {
  return {
    async reset() { return { success: true, details: { message: "reset ok" } }; },
    async reboot() { return { success: true, details: { message: "reboot ok" } }; },
    async pause() { return { success: true, details: { message: "paused" } }; },
    async resume() { return { success: true, details: { message: "resumed" } }; },
    async poweroff() { return { success: true, details: { message: "powered off" } }; },
    async menuButton() { return { success: true, details: { message: "menu toggled" } }; },
    async readMenuScreen() { return Uint8Array.from([0x41, 0x01, 0x42, 0x02]); },
    ...overrides,
  };
}

const platform = (process.env.C64_MODE ?? "").toLowerCase() === "vice" ? "vice" : "c64u";
const isVice = platform === "vice";
const testC64uOnly = isVice ? test.skip : test;

testC64uOnly("read_menu_screen returns the firmware matrix without guessing its layout", async () => {
  const ctx = { client: createMockClient(), logger: createLogger() };
  const res = await machineControlModule.invoke("read_menu_screen", {}, ctx);
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent?.data.encoding, "base64");
  assert.equal(res.structuredContent?.data.byteLength, 4);
  assert.equal(res.structuredContent?.data.matrix, "QQFCAg==");
});

async function runWithPlatform(target, fn) {
  const original = getPlatformStatus().id;
  try {
    setPlatform(target);
    await fn();
  } finally {
    setPlatform(original);
  }
}

// --- reset_c64 ---

test("reset_c64 succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("reset_c64", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("reset command issued successfully"));
  assert.equal(res.metadata?.success, true);
});

test("reset_c64 handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async reset() { return { success: false, details: { error: "hardware fault" } }; },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("reset_c64", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("reset_c64 handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async reset() { throw new Error("network error"); },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("reset_c64", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

test("reset_c64 handles failure with scalar details", async () => {
  const ctx = {
    client: createMockClient({
      async reset() { return { success: false, details: "simple error" }; },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("reset_c64", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

// --- reboot_c64 ---

test("reboot_c64 succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("reboot_c64", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("reboot command issued successfully"));
  assert.equal(res.metadata?.success, true);
});

test("reboot_c64 handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async reboot() { return { success: false, details: null }; },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("reboot_c64", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("reboot_c64 handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async reboot() { throw new Error("connection refused"); },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("reboot_c64", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- pause ---

testC64uOnly("pause succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("pause", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("execution paused"));
  assert.equal(res.metadata?.success, true);
});

testC64uOnly("pause handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async pause() { return { success: false, details: undefined }; },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("pause", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

testC64uOnly("pause handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async pause() { throw new Error("timeout"); },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("pause", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- resume ---

testC64uOnly("resume succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("resume", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("execution resumed"));
  assert.equal(res.metadata?.success, true);
});

testC64uOnly("resume handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async resume() { return { success: false, details: { code: 500 } }; },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("resume", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

testC64uOnly("resume handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async resume() { throw new Error("hardware error"); },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("resume", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- poweroff ---

test("poweroff succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("poweroff", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Power off command acknowledged"));
  assert.equal(res.metadata?.success, true);
});

test("poweroff handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async poweroff() { return { success: false, details: 123 }; },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("poweroff", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("poweroff handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async poweroff() { throw new Error("communication error"); },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("poweroff", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

if (isVice) {
  test("poweroff succeeds on vice", () =>
    runWithPlatform("vice", async () => {
      const calls = [];
      const ctx = {
        client: createMockClient({
          async poweroff() {
            calls.push("poweroff");
            return { success: true, details: { shutdown: true } };
          },
        }),
        logger: createLogger(),
      };

      const res = await machineControlModule.invoke("poweroff", {}, ctx);
      assert.equal(res.metadata?.success, true);
      assert.deepEqual(calls, ["poweroff"]);
    }));
}

// --- menu_button ---

testC64uOnly("menu_button succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("menu_button", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Menu button command sent"));
  assert.equal(res.metadata?.success, true);
});

testC64uOnly("menu_button handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async menuButton() { return { success: false, details: "disabled" }; },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("menu_button", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

testC64uOnly("menu_button handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async menuButton() { throw new Error("not available"); },
    }),
    logger: createLogger(),
  };
  const res = await machineControlModule.invoke("menu_button", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

if (isVice) {
  test("pause is unsupported on vice", () =>
    runWithPlatform("vice", async () => {
      const ctx = {
        client: createMockClient(),
        logger: createLogger(),
      };

      await assert.rejects(
        () => machineControlModule.invoke("pause", {}, ctx),
        (error) => error?.name === "ToolUnsupportedPlatformError",
      );
    }));

  test("resume is unsupported on vice", () =>
    runWithPlatform("vice", async () => {
      const ctx = {
        client: createMockClient(),
        logger: createLogger(),
      };

      await assert.rejects(
        () => machineControlModule.invoke("resume", {}, ctx),
        (error) => error?.name === "ToolUnsupportedPlatformError",
      );
    }));

  test("menu_button is unsupported on vice", () =>
    runWithPlatform("vice", async () => {
      const ctx = {
        client: createMockClient(),
        logger: createLogger(),
      };

      await assert.rejects(
        () => machineControlModule.invoke("menu_button", {}, ctx),
        (error) => error?.name === "ToolUnsupportedPlatformError",
      );
    }));
}

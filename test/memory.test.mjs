import test from "#test/runner";
import assert from "#test/assert";
import { memoryModule } from "../src/tools/memory.js";

const isVice = (process.env.C64_MODE ?? "").toLowerCase() === "vice";
const testC64uOnly = isVice ? test.skip : test;

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createMockClient(overrides = {}) {
  return {
    async readScreen() { return "READY.\n"; },
    async readMemory(address, length) {
      return {
        success: true,
        data: "$AABBCCDD",
        details: { address: "0400", length: 4 },
      };
    },
    async writeMemory(address, bytes) {
      return {
        success: true,
        details: { address: "0400", length: 2 },
      };
    },
    async pause() { return { success: true }; },
    async resume() { return { success: true }; },
    ...overrides,
  };
}

// --- read_screen ---

test("read_screen returns screen contents", async () => {
  const ctx = {
    client: createMockClient({
      async readScreen() { return "HELLO WORLD"; },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read_screen", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("HELLO WORLD"));
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.screen, "HELLO WORLD");
});

test("read_screen handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async readScreen() { throw new Error("hardware error"); },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read_screen", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- read ---

test("read succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read", { address: "$0400", length: 4 }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Read 4 bytes starting at $0400."));
  assert.equal(res.structuredContent?.type, "json");
  const data = res.structuredContent?.data;
  assert.equal(data.success, true);
  assert.equal(data.hexData, "$AABBCCDD");
  assert.equal(data.address, "$0400");
  assert.equal(data.length, 4);
  assert.ok(data.details);
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.hexData, "$AABBCCDD");
});

test("read uses default length when not provided", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read", { address: "$0400" }, ctx);
  assert.ok(res.content?.[0].text.includes("Read 4 bytes starting at $0400."));
  assert.equal(res.metadata?.success, true);
  assert.equal(res.structuredContent?.data.success, true);
});

test("read handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async readMemory() {
        return { success: false, details: { error: "invalid address" } };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read", { address: "$0400", length: 8 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("read handles failure with scalar details", async () => {
  const ctx = {
    client: createMockClient({
      async readMemory() {
        return { success: false, details: "address out of range" };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read", { address: "$FFFF", length: 2 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("read handles failure with null details", async () => {
  const ctx = {
    client: createMockClient({
      async readMemory() {
        return { success: false, details: null };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read", { address: "$0400", length: 1 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("read handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async readMemory() { throw new Error("network timeout"); },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read", { address: "$0400", length: 8 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

test("read handles response without details", async () => {
  const ctx = {
    client: createMockClient({
      async readMemory() {
        return { success: true, data: "$AA55" };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("read", { address: "$0400", length: 2 }, ctx);
  assert.ok(res.content?.[0].text.includes("Read 2 bytes starting at $0400."));
  const data = res.structuredContent?.data;
  assert.equal(data.success, true);
  assert.equal(data.hexData, "$AA55");
  assert.equal(data.address, "$0400");
  assert.equal(data.length, 2);
  assert.equal(res.metadata?.hexData, "$AA55");
});

// --- write ---

test("write succeeds with valid response", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "$0400", bytes: "$AA55" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Wrote"));
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.bytes, "$AA55");
});

test("write handles numeric address in details", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemory() {
        return { success: true, details: { address: 1024, length: 2 } };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "$0400", bytes: "$AA55" }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.address, "$0400");
});

test("write handles string address without $ prefix", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemory() {
        return { success: true, details: { address: "0400", length: 2 } };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "0400", bytes: "$AA55" }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.ok(res.metadata?.address?.startsWith("$"));
});

test("write handles empty address string in details", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemory() {
        return { success: true, details: { address: "", length: 2 } };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "$0400", bytes: "$AA" }, ctx);
  assert.equal(res.metadata?.success, true);
});

test("write handles failure response", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemory() {
        return { success: false, details: { error: "protected memory" } };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "$D000", bytes: "$FF" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("write handles failure with undefined details", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemory() {
        return { success: false, details: undefined };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "$0400", bytes: "$AA" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("write handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemory() { throw new Error("connection error"); },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "$0400", bytes: "$AA55" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

test("write handles response without length in details", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemory() {
        return { success: true, details: { address: "0400" } };
      },
    }),
    logger: createLogger(),
  };
  const res = await memoryModule.invoke("write", { address: "$0400", bytes: "$AABB" }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.length, null);
});

testC64uOnly("write verifies written bytes when verify flag is set", async () => {
  const events = [];
  const ctx = {
    client: createMockClient({
      async pause() {
        events.push("pause");
        return { success: true };
      },
      async resume() {
        events.push("resume");
        return { success: true };
      },
      readCount: 0,
      async readMemory(address, length) {
        events.push(`read-${length}`);
        this.readCount += 1;
        if (this.readCount === 1) {
          return {
            success: true,
            data: "$0000",
            details: { address: "0400", length: Number(length) },
          };
        }
        return {
          success: true,
          data: "$AABB",
          details: { address: "0400", length: Number(length) },
        };
      },
      async writeMemory(address, bytes) {
        events.push(`write-${bytes}`);
        return {
          success: true,
          details: { address: "0400", length: 2 },
        };
      },
    }),
    logger: createLogger(),
  };

  const res = await memoryModule.invoke("write", { address: "$0400", bytes: "$AABB", verify: true }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.verified, true);
  assert.equal(res.metadata?.verification?.preRead, "$0000");
  assert.equal(res.metadata?.verification?.postRead, "$AABB");
  assert.equal(res.metadata?.verification?.readLength, 2);
  assert.ok(events.includes("pause"));
  assert.ok(events.includes("resume"));
});

testC64uOnly("write aborts when expected bytes mismatch and abortOnMismatch is true", async () => {
  const events = [];
  const ctx = {
    client: createMockClient({
      async pause() {
        events.push("pause");
        return { success: true };
      },
      async resume() {
        events.push("resume");
        return { success: true };
      },
      async readMemory() {
        events.push("read");
        return {
          success: true,
          data: "$0000",
          details: { address: "0400", length: 2 },
        };
      },
    }),
    logger: createLogger(),
  };

  const res = await memoryModule.invoke("write", {
    address: "$0400",
    bytes: "$AABB",
    expected: "$FFFF",
    verify: true,
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  assert.ok(events.includes("pause"));
  assert.ok(events.includes("read"));
  assert.ok(events.includes("resume"));
});

test("write records pre-read mismatches when abortOnMismatch is false", async () => {
  const ctx = {
    client: createMockClient({
      readCount: 0,
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory(address, length) {
        this.readCount += 1;
        if (this.readCount === 1) {
          return {
            success: true,
            data: "$0F0F",
            details: { address: "0400", length: Number(length) },
          };
        }
        return {
          success: true,
          data: "$AABB",
          details: { address: "0400", length: Number(length) },
        };
      },
      async writeMemory(address, bytes) {
        return {
          success: true,
          details: { address: "0400", length: 2 },
        };
      },
    }),
    logger: createLogger(),
  };

  const res = await memoryModule.invoke("write", {
    address: "$0400",
    bytes: "$AABB",
    expected: "$FFFF",
    abortOnMismatch: false,
    verify: true,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.verified, true);
  const mismatches = res.metadata?.verification?.preReadMismatches;
  assert.ok(Array.isArray(mismatches));
  assert.ok(mismatches.length > 0);
});

test("write fails when post-write verification detects differences", async () => {
  const ctx = {
    client: createMockClient({
      readCount: 0,
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory(address, length) {
        this.readCount += 1;
        if (this.readCount === 1) {
          return {
            success: true,
            data: "$0000",
            details: { address: "0400", length: Number(length) },
          };
        }
        return {
          success: true,
          data: "$AA00",
          details: { address: "0400", length: Number(length) },
        };
      },
      async writeMemory(address, bytes) {
        return {
          success: true,
          details: { address: "0400", length: 2 },
        };
      },
    }),
    logger: createLogger(),
  };

  const res = await memoryModule.invoke("write", {
    address: "$0400",
    bytes: "$AABB",
    verify: true,
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

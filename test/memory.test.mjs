import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryModule } from "../src/tools/memory.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { setViceSymbols, clearViceSymbols } from "../src/tools/symbolRegistry.js";

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
    async writeMemoryRaw(address, bytes) {
      return undefined;
    },
    async pause() { return { success: true }; },
    async resume() { return { success: true }; },
    ...overrides,
  };
}

test.afterEach(() => {
  clearViceSymbols();
});

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

test("read formats numeric response addresses as hexadecimal", async () => {
  const ctx = {
    client: createMockClient({
      async readMemory() {
        return {
          success: true,
          data: "$AA",
          details: { address: 1024, length: 1 },
        };
      },
    }),
    logger: createLogger(),
  };

  const res = await memoryModule.invoke("read", { address: "$0400", length: 1 }, ctx);

  assert.equal(res.isError, undefined);
  assert.equal(res.metadata.address, "$0400");
  assert.equal(res.structuredContent?.data.address, "$0400");
});

test("read falls back to the requested address when the response omits one", async () => {
  const ctx = {
    client: createMockClient({
      async readMemory() {
        return {
          success: true,
          data: "$AA",
          details: {},
        };
      },
    }),
    logger: createLogger(),
  };

  const res = await memoryModule.invoke("read", { address: "0400", length: 1 }, ctx);

  assert.equal(res.isError, undefined);
  assert.equal(res.metadata.address, "$0400");
  assert.equal(res.structuredContent?.data.address, "$0400");
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

test("disassemble accepts 0x-prefixed addresses and includes symbol annotations", async () => {
  setViceSymbols([["start", 0x0810]]);
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(address, 0x0810);
        assert.equal(length, 4);
        return Uint8Array.of(0xA9, 0x00, 0x60, 0xEA);
      },
    }),
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "0x0810", length: 4 }, ctx);

  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /start:/);
  assert.match(res.content[0].text, /LDA/);
});

test("disassemble ignores cached VICE symbols on non-VICE backends", async () => {
  setViceSymbols([["stale", 0x0810]]);
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(address, 0x0810);
        assert.equal(length, 4);
        return Uint8Array.of(0xA9, 0x00, 0x60, 0xEA);
      },
    }),
    logger: createLogger(),
    platform: { id: "c64u", features: [], limitedFeatures: [] },
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "$0810", length: 4 }, ctx);

  assert.equal(res.isError, undefined);
  assert.equal(/stale:/i.test(res.content[0].text), false);
});

test("disassemble rejects unknown symbols", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "missing_label", length: 4 }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "validation");
});

test("disassemble accepts decimal addresses", async () => {
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(address, 2064);
        assert.equal(length, 1);
        return Uint8Array.of(0xEA);
      },
    }),
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "2064", length: 1 }, ctx);

  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /NOP/);
});

test("disassemble rejects out-of-range addresses", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "$10000", length: 1 }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "validation");
});

test("disassemble surfaces read failures as unknown errors", async () => {
  const ctx = {
    client: createMockClient({
      async readMemoryRaw() {
        throw new Error("read failed");
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "$0810", length: 1 }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "unknown");
});

test("copy_memory writes raw bytes through the shared client path", async () => {
  const writes = [];
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(address, 0x2000);
        assert.equal(length, 3);
        return Uint8Array.of(0xAA, 0xBB, 0xCC);
      },
      async writeMemoryRaw(address, bytes) {
        writes.push({ address, bytes: Array.from(bytes) });
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "copy_memory", source: "$2000", dest: "$3000", length: 3 }, ctx);

  assert.equal(res.isError, undefined);
  assert.deepEqual(writes, [{ address: 0x3000, bytes: [0xAA, 0xBB, 0xCC] }]);
});

test("copy_memory surfaces raw write failures", async () => {
  const ctx = {
    client: createMockClient({
      async readMemoryRaw() {
        return Uint8Array.of(0xAA, 0xBB);
      },
      async writeMemoryRaw() {
        throw new Error("write failed");
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "copy_memory", source: "$2000", dest: "$3000", length: 2 }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "unknown");
});

test("copy_memory rejects address ranges that wrap past $FFFF", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "copy_memory", source: "$FFFE", dest: "$2000", length: 4 }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "validation");
});

test("fill_memory writes raw repeating bytes through the shared client path", async () => {
  const writes = [];
  const ctx = {
    client: createMockClient({
      async writeMemoryRaw(address, bytes) {
        writes.push({ address, bytes: Array.from(bytes) });
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "fill_memory", address: "$4000", length: 5, pattern: "AA 55" }, ctx);

  assert.equal(res.isError, undefined);
  assert.deepEqual(writes, [{ address: 0x4000, bytes: [0xAA, 0x55, 0xAA, 0x55, 0xAA] }]);
});

test("fill_memory surfaces raw write failures", async () => {
  const ctx = {
    client: createMockClient({
      async writeMemoryRaw() {
        throw new Error("fill failed");
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "fill_memory", address: "$4000", length: 2, pattern: "AA" }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "unknown");
});

test("fill_memory rejects address ranges that wrap past $FFFF", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", { op: "fill_memory", address: "$FFFF", length: 2, pattern: "AA" }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "validation");
});

test("search_memory finds matches and respects maxResults", async () => {
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(address, 0x2000);
        assert.equal(length, 8);
        return Uint8Array.of(0xAA, 0xBB, 0xAA, 0xBB, 0x00, 0xAA, 0xBB, 0xCC);
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", {
    op: "search_memory",
    startAddress: "$2000",
    endAddress: "$2007",
    pattern: "AA BB",
    maxResults: 2,
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.deepEqual(res.structuredContent?.data.matches, ["$2000", "$2002"]);
  assert.equal(res.structuredContent?.data.found, 2);
});

test("search_memory rejects reversed ranges", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", {
    op: "search_memory",
    startAddress: "$2007",
    endAddress: "$2000",
    pattern: "AA",
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "validation");
});

test("compare_memory reports identical buffers", async () => {
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(_address, length) {
        return Uint8Array.of(...new Array(length).fill(0x55));
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", {
    op: "compare_memory",
    address1: "$3000",
    address2: "$3100",
    length: 4,
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent?.data.identical, true);
  assert.equal(res.structuredContent?.data.diffCount, 0);
});

test("compare_memory reports differences and respects maxDiffs", async () => {
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(length, 4);
        return address === 0x3000
          ? Uint8Array.of(0x10, 0x20, 0x30, 0x40)
          : Uint8Array.of(0x10, 0x21, 0x31, 0x40);
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", {
    op: "compare_memory",
    address1: "$3000",
    address2: "$3100",
    length: 4,
    maxDiffs: 1,
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent?.data.identical, false);
  assert.equal(res.structuredContent?.data.diffCount, 1);
  assert.deepEqual(res.structuredContent?.data.diffs, [{
    offset: 1,
    address1: "$3001",
    address2: "$3101",
    value1: "$20",
    value2: "$21",
  }]);
});

test("compare_memory surfaces read failures as unknown errors", async () => {
  const ctx = {
    client: createMockClient({
      async readMemoryRaw() {
        throw new Error("compare failed");
      },
    }),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", {
    op: "compare_memory",
    address1: "$3000",
    address2: "$3100",
    length: 4,
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "unknown");
});

test("save_memory writes a PRG header and payload to disk", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-memory-"));
  const outputPath = path.join(tempDir, "dump.prg");
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(address, 0x2000);
        assert.equal(length, 3);
        return Uint8Array.of(0x11, 0x22, 0x33);
      },
    }),
    logger: createLogger(),
  };

  try {
    const res = await toolRegistry.invoke("c64_memory", { op: "save_memory",
      startAddress: "$2000",
      endAddress: "$2002",
      filePath: outputPath,
    }, ctx);

    assert.equal(res.isError, undefined);
    const written = fs.readFileSync(outputPath);
    assert.deepEqual(Array.from(written), [0x00, 0x20, 0x11, 0x22, 0x33]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("save_memory omits the PRG header when asPrg is false", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-memory-"));
  const outputPath = path.join(tempDir, "dump.bin");
  const ctx = {
    client: createMockClient({
      async readMemoryRaw(address, length) {
        assert.equal(address, 0x2000);
        assert.equal(length, 2);
        return Uint8Array.of(0x11, 0x22);
      },
    }),
    logger: createLogger(),
  };

  try {
    const res = await toolRegistry.invoke("c64_memory", {
      op: "save_memory",
      startAddress: "$2000",
      endAddress: "$2001",
      filePath: outputPath,
      asPrg: false,
    }, ctx);

    assert.equal(res.isError, undefined);
    const written = fs.readFileSync(outputPath);
    assert.deepEqual(Array.from(written), [0x11, 0x22]);
    assert.equal(res.metadata.asPrg, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("save_memory rejects reversed ranges", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };

  const res = await toolRegistry.invoke("c64_memory", {
    op: "save_memory",
    startAddress: "$2002",
    endAddress: "$2000",
    filePath: "/tmp/ignored.bin",
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata.error.kind, "validation");
});

test("save_memory surfaces filesystem write failures", async () => {
  const originalWriteFile = fs.promises.writeFile;
  const ctx = {
    client: createMockClient({
      async readMemoryRaw() {
        return Uint8Array.of(0x11, 0x22);
      },
    }),
    logger: createLogger(),
  };

  fs.promises.writeFile = async () => {
    throw new Error("disk full");
  };

  try {
    const res = await toolRegistry.invoke("c64_memory", {
      op: "save_memory",
      startAddress: "$2000",
      endAddress: "$2001",
      filePath: "/tmp/c64bridge-save-memory-error.bin",
    }, ctx);

    assert.equal(res.isError, true);
    assert.equal(res.metadata.error.kind, "unknown");
  } finally {
    fs.promises.writeFile = originalWriteFile;
  }
});

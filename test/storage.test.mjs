import test from "#test/runner";
import assert from "#test/assert";
import { storageModule } from "../src/tools/storage.js";

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createMockClient(overrides = {}) {
  return {
    async drivesList() {
      return [
        { id: "drive8", power: "on", image: "/tmp/test.d64" },
        { id: "drive9", power: "off", image: null },
      ];
    },
    async driveMount(drive, image, opts) {
      return { success: true, details: { drive, image, ...opts } };
    },
    async driveRemove(drive) {
      return { success: true, details: { drive } };
    },
    async driveReset(drive) {
      return { success: true, details: { drive } };
    },
    async driveOn(drive) {
      return { success: true, details: { drive, power: "on" } };
    },
    async driveOff(drive) {
      return { success: true, details: { drive, power: "off" } };
    },
    async driveLoadRom(drive, path) {
      return { success: true, details: { drive, path } };
    },
    async driveSetMode(drive, mode) {
      return { success: true, details: { drive, mode } };
    },
    async filesInfo(path) {
      return { path, size: 174848, type: "d64" };
    },
    async filesCreateD64(path, opts) {
      return { success: true, details: { path, tracks: opts.tracks ?? 35 } };
    },
    async filesCreateD71(path, opts) {
      return { success: true, details: { path, diskname: opts.diskname } };
    },
    async filesCreateD81(path, opts) {
      return { success: true, details: { path, diskname: opts.diskname } };
    },
    async filesCreateDnp(path, tracks, opts) {
      return { success: true, details: { path, tracks } };
    },
    ...overrides,
  };
}

// --- drives_list ---

test("drives_list returns drive status", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drives_list", {}, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Retrieved drive status"));
  assert.equal(res.metadata?.success, true);
  assert.ok(Array.isArray(res.metadata?.drives));
});

test("drives_list handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async drivesList() { throw new Error("network error"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drives_list", {}, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- drive_mount ---

test("drive_mount succeeds with minimal args", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mount", { drive: "drive8", image: "/tmp/test.d64" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Mounted"));
  assert.equal(res.metadata?.success, true);
});

test("drive_mount succeeds with type and mode", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mount", {
    drive: "drive8",
    image: "/tmp/test.d64",
    type: "d64",
    mode: "readonly",
  }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.type, "d64");
  assert.equal(res.metadata?.mode, "readonly");
});

test("drive_mount handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async driveMount() {
        return { success: false, details: { error: "image not found" } };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mount", { drive: "drive8", image: "/missing.d64" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_mount handles failure with scalar details", async () => {
  const ctx = {
    client: createMockClient({
      async driveMount() {
        return { success: false, details: "invalid path" };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mount", { drive: "drive8", image: "/bad.d64" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_mount handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async driveMount() { throw new Error("timeout"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mount", { drive: "drive8", image: "/tmp/test.d64" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- drive_remove ---

test("drive_remove succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_remove", { drive: "drive8" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Removed"));
  assert.equal(res.metadata?.success, true);
});

test("drive_remove handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async driveRemove() {
        return { success: false, details: null };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_remove", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_remove handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async driveRemove() { throw new Error("hardware fault"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_remove", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- drive_reset ---

test("drive_reset succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_reset", { drive: "drive8" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("reset issued"));
  assert.equal(res.metadata?.success, true);
});

test("drive_reset handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async driveReset() {
        return { success: false, details: undefined };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_reset", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_reset handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async driveReset() { throw new Error("connection error"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_reset", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- drive_on ---

test("drive_on succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_on", { drive: "drive8" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("powered on"));
  assert.equal(res.metadata?.success, true);
});

test("drive_on handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async driveOn() {
        return { success: false, details: "already on" };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_on", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_on handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async driveOn() { throw new Error("power fault"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_on", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- drive_off ---

test("drive_off succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_off", { drive: "drive8" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("powered off"));
  assert.equal(res.metadata?.success, true);
});

test("drive_off handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async driveOff() {
        return { success: false, details: { code: 500 } };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_off", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_off handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async driveOff() { throw new Error("timeout"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_off", { drive: "drive8" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- drive_load_rom ---

test("drive_load_rom succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_load_rom", { drive: "drive8", path: "/roms/1541.rom" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("ROM loaded"));
  assert.equal(res.metadata?.success, true);
});

test("drive_load_rom handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async driveLoadRom() {
        return { success: false, details: null };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_load_rom", { drive: "drive8", path: "/bad.rom" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_load_rom handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async driveLoadRom() { throw new Error("file not found"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_load_rom", { drive: "drive8", path: "/roms/test.rom" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- drive_mode ---

test("drive_mode succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mode", { drive: "drive8", mode: "1541" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("set to"));
  assert.equal(res.metadata?.success, true);
});

test("drive_mode handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async driveSetMode() {
        return { success: false, details: undefined };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mode", { drive: "drive8", mode: "1571" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_mode handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async driveSetMode() { throw new Error("invalid mode"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("drive_mode", { drive: "drive8", mode: "1581" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- file_info ---

test("file_info succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("file_info", { path: "/tmp/test.d64" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Retrieved file info"));
  assert.equal(res.metadata?.success, true);
});

test("file_info handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async filesInfo() {
        throw new Error("not found");
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("file_info", { path: "/missing.d64" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

test("file_info handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async filesInfo() { throw new Error("access denied"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("file_info", { path: "/protected.d64" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- create_d64 ---

test("create_d64 succeeds with minimal args", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d64", { path: "/tmp/new.d64" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Created D64"));
  assert.equal(res.metadata?.success, true);
  // Without a track count the result reports the firmware default instead of null.
  assert.equal(res.structuredContent?.data?.tracks, 35);
});

test("create_d64 succeeds with tracks and diskname", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d64", {
    path: "/tmp/new.d64",
    tracks: 40,
    diskname: "TEST DISK",
  }, ctx);
  assert.equal(res.metadata?.success, true);
});

test("create_d64 handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateD64() {
        return { success: false, details: { error: "disk full" } };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d64", { path: "/tmp/new.d64" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("create_d64 handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateD64() { throw new Error("write error"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d64", { path: "/tmp/new.d64" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- create_d71 ---

test("create_d71 succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d71", { path: "/tmp/new.d71" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Created D71"));
  assert.equal(res.metadata?.success, true);
});

test("create_d71 handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateD71() {
        return { success: false, details: null };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d71", { path: "/tmp/new.d71" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("create_d71 handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateD71() { throw new Error("io error"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d71", { path: "/tmp/new.d71" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- create_d81 ---

test("create_d81 succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d81", { path: "/tmp/new.d81" }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Created D81"));
  assert.equal(res.metadata?.success, true);
});

test("create_d81 handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateD81() {
        return { success: false, details: undefined };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d81", { path: "/tmp/new.d81" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("create_d81 handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateD81() { throw new Error("permission denied"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_d81", { path: "/tmp/new.d81" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

// --- create_dnp ---

test("create_dnp succeeds", async () => {
  const ctx = {
    client: createMockClient(),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_dnp", { path: "/tmp/new.dnp", tracks: 80 }, ctx);
  assert.equal(res.content?.[0].type, "text");
  assert.ok(res.content?.[0].text.includes("Created DNP"));
  assert.equal(res.metadata?.success, true);
});

test("create_dnp handles failure", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateDnp() {
        return { success: false, details: "invalid tracks" };
      },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_dnp", { path: "/tmp/new.dnp", tracks: 80 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("create_dnp handles exception", async () => {
  const ctx = {
    client: createMockClient({
      async filesCreateDnp() { throw new Error("format error"); },
    }),
    logger: createLogger(),
  };
  const res = await storageModule.invoke("create_dnp", { path: "/tmp/new.dnp", tracks: 100 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "unknown");
});

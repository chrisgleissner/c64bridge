import test from "#test/runner";
import assert from "#test/assert";
import {
  getPlatformStatus,
  setPlatform,
  isPlatformSupported,
  describePlatformCapabilities,
  getAllPlatformStatuses,
} from "../src/platform.js";

// Save original env
const originalEnv = process.env.C64_MODE;

test.afterEach(() => {
  // Restore environment after each test
  if (originalEnv !== undefined) {
    process.env.C64_MODE = originalEnv;
  } else {
    delete process.env.C64_MODE;
  }
  // Reset to c64u
  setPlatform("c64u");
});

// --- getPlatformStatus ---

test("getPlatformStatus returns c64u status by default", () => {
  setPlatform("c64u");
  const status = getPlatformStatus();
  assert.equal(status.id, "c64u");
  assert.ok(status.features.includes("ultimate-rest-api"));
  assert.ok(status.features.includes("hardware-execution"));
  assert.equal(status.limitedFeatures.length, 0);
});

test("getPlatformStatus returns vice status when set", () => {
  setPlatform("vice");
  const status = getPlatformStatus();
  assert.equal(status.id, "vice");
  assert.ok(status.features.includes("software-emulation"));
  assert.ok(status.features.includes("drive-management"));
  assert.ok(status.limitedFeatures.includes("no-rest-api"));
  assert.ok(status.limitedFeatures.includes("no-firmware-filesystem"));
  assert.ok(!status.limitedFeatures.includes("no-drive-management"));
});

test("getPlatformStatus reports U2-family REST limitations", () => {
  setPlatform("u2");
  const status = getPlatformStatus();
  assert.equal(status.id, "u2");
  assert.ok(status.features.includes("cartridge-execution"));
  assert.ok(status.limitedFeatures.includes("no-machine-input"));
  assert.ok(status.limitedFeatures.includes("no-streaming"));
});

// --- setPlatform ---

test("setPlatform changes platform to vice", () => {
  const status = setPlatform("vice");
  assert.equal(status.id, "vice");
  assert.ok(status.features.includes("software-emulation"));
});

test("setPlatform changes platform to c64u", () => {
  setPlatform("vice");
  const status = setPlatform("c64u");
  assert.equal(status.id, "c64u");
  assert.ok(status.features.includes("ultimate-rest-api"));
});

test("setPlatform throws on unsupported platform", () => {
  assert.throws(
    () => setPlatform("invalid"),
    /Unsupported platform id/
  );
});

// --- isPlatformSupported ---

test("isPlatformSupported returns true when supported list is empty", () => {
  assert.equal(isPlatformSupported("c64u", []), true);
  assert.equal(isPlatformSupported("vice", []), true);
});

test("isPlatformSupported returns true when supported list is undefined", () => {
  assert.equal(isPlatformSupported("c64u", undefined), true);
  assert.equal(isPlatformSupported("vice", undefined), true);
});

test("isPlatformSupported returns true when platform is in list", () => {
  assert.equal(isPlatformSupported("c64u", ["c64u", "vice"]), true);
  assert.equal(isPlatformSupported("vice", ["c64u", "vice"]), true);
});

test("isPlatformSupported returns false when platform is not in list", () => {
  assert.equal(isPlatformSupported("c64u", ["vice"]), false);
  assert.equal(isPlatformSupported("vice", ["c64u"]), false);
});

// --- describePlatformCapabilities ---

test("describePlatformCapabilities handles empty tools list", () => {
  const desc = describePlatformCapabilities([]);
  assert.ok(desc.platforms.c64u);
  assert.ok(desc.platforms.u2);
  assert.ok(desc.platforms.vice);
  assert.equal(desc.platforms.c64u.tools.length, 0);
  assert.equal(desc.platforms.vice.tools.length, 0);
});

test("describePlatformCapabilities categorizes tools by platform", () => {
  const tools = [
    {
      name: "tool1",
      metadata: { platforms: ["c64u"] },
    },
    {
      name: "tool2",
      metadata: { platforms: ["vice"] },
    },
    {
      name: "tool3",
      metadata: { platforms: ["c64u", "vice"] },
    },
  ];
  
  const desc = describePlatformCapabilities(tools);
  assert.ok(desc.platforms.c64u.tools.includes("tool1"));
  assert.ok(desc.platforms.c64u.tools.includes("tool3"));
  assert.ok(desc.platforms.vice.tools.includes("tool2"));
  assert.ok(desc.platforms.vice.tools.includes("tool3"));
  assert.ok(desc.platforms.c64u.unsupported_tools.includes("tool2"));
  assert.ok(desc.platforms.vice.unsupported_tools.includes("tool1"));
});

test("describePlatformCapabilities uses c64u as default platform", () => {
  const tools = [
    {
      name: "default_tool",
      metadata: {},
    },
  ];
  
  const desc = describePlatformCapabilities(tools);
  assert.ok(desc.platforms.c64u.tools.includes("default_tool"));
  assert.ok(desc.platforms.vice.unsupported_tools.includes("default_tool"));
});

test("describePlatformCapabilities sorts tool lists", () => {
  const tools = [
    { name: "zebra", metadata: { platforms: ["c64u"] } },
    { name: "alpha", metadata: { platforms: ["c64u"] } },
    { name: "beta", metadata: { platforms: ["c64u"] } },
  ];
  
  const desc = describePlatformCapabilities(tools);
  assert.deepEqual(desc.platforms.c64u.tools, ["alpha", "beta", "zebra"]);
});

// --- getAllPlatformStatuses ---

test("getAllPlatformStatuses returns all platforms", () => {
  const statuses = getAllPlatformStatuses();
  assert.equal(statuses.length, 3);
  
  const c64u = statuses.find(s => s.id === "c64u");
  const vice = statuses.find(s => s.id === "vice");
  const u2 = statuses.find(s => s.id === "u2");
  
  assert.ok(c64u);
  assert.ok(vice);
  assert.ok(u2);
  assert.ok(c64u.features.includes("ultimate-rest-api"));
  assert.ok(vice.features.includes("software-emulation"));
});

test("getAllPlatformStatuses includes features and limitations", () => {
  const statuses = getAllPlatformStatuses();
  
  const c64u = statuses.find(s => s.id === "c64u");
  const vice = statuses.find(s => s.id === "vice");
  
  assert.ok(c64u);
  assert.ok(vice);
  assert.ok(c64u.features.length > 0);
  assert.ok(vice.features.includes("runtime-config"));
  assert.ok(vice.limitedFeatures.length > 0);
  assert.equal(c64u.limitedFeatures.length, 0);
});

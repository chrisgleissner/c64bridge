import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { ToolUnsupportedPlatformError } from "../src/tools/errors.js";
import { setPlatform } from "../src/platform.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function ctxFor(active, configured) {
  const client = {};
  if (configured) {
    client.getAvailableBackends = () => configured;
  }
  return { client, rag: {}, logger, platform: { id: active, features: [], limitedFeatures: [] }, setPlatform };
}

async function messageFor(name, args, ctx) {
  try {
    await toolRegistry.invoke(name, args, ctx);
  } catch (error) {
    assert.ok(error instanceof ToolUnsupportedPlatformError);
    return error;
  }
  assert.fail("expected an unsupported platform error");
}

test("unsupported op names the public tool, op, required backends and the configured switch target", async () => {
  const error = await messageFor("c64_disk", { op: "unmount", drive: "a" }, ctxFor("vice", ["vice", "u2"]));
  assert.equal(
    error.message,
    "`c64_disk` op `unmount` requires backend c64u or u2 (active: vice). Use `c64_select_backend` to switch to u2.",
  );
  assert.ok(!/drive_remove|Tool .* is not available/.test(error.message));
});

test("suggestion lists only configured backends that support the op", async () => {
  const error = await messageFor("c64_disk", { op: "unmount", drive: "a" }, ctxFor("vice", ["vice", "c64u", "u2"]));
  assert.match(error.message, /switch to c64u or u2\.$/);
});

test("no switch is suggested when no supporting backend is configured", async () => {
  const error = await messageFor("c64_disk", { op: "unmount", drive: "a" }, ctxFor("vice", ["vice"]));
  assert.equal(
    error.message,
    "`c64_disk` op `unmount` requires backend c64u or u2 (active: vice). None of these backends is configured on this server.",
  );
  assert.ok(!error.message.includes("c64_select_backend"));
});

test("error keeps tool, platform and supported fields", async () => {
  const error = await messageFor("c64_disk", { op: "unmount", drive: "a" }, ctxFor("vice", ["vice"]));
  assert.equal(error.platform, "vice");
  assert.deepEqual(error.supported, ["c64u", "u2"]);
  assert.equal(typeof error.tool, "string");
});

test("legacy constructor without options gives a plain requirement message", () => {
  const error = new ToolUnsupportedPlatformError("capture_frame", "u2", ["c64u", "vice"]);
  assert.equal(error.message, "capture_frame requires backend c64u or vice (active: u2).");
});

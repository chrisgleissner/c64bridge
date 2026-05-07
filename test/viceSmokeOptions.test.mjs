import test from "#test/runner";
import assert from "#test/assert";
import { parseEnvBoolean, resolveViceSmokeOptions } from "../src/vice/smokeOptions.js";

test("parseEnvBoolean recognises documented string booleans", () => {
  assert.equal(parseEnvBoolean("true"), true);
  assert.equal(parseEnvBoolean("false"), false);
  assert.equal(parseEnvBoolean("on"), true);
  assert.equal(parseEnvBoolean("off"), false);
  assert.equal(parseEnvBoolean("maybe"), undefined);
});

test("resolveViceSmokeOptions honours string boolean env values", () => {
  const options = resolveViceSmokeOptions({
    VICE_TEST_TARGET: "vice",
    VICE_VISIBLE: "true",
    VICE_KEEP_OPEN: "false",
    VICE_WARP: "false",
  }, []);

  assert.equal(options.useMock, false);
  assert.equal(options.visible, true);
  assert.equal(options.keepOpen, false);
  assert.equal(options.warp, false);
  assert.equal(options.visibleDemo, false);
});

test("resolveViceSmokeOptions enables a visible demo mode from argv", () => {
  const options = resolveViceSmokeOptions({
    VICE_TEST_TARGET: "vice",
    VICE_VISIBLE: "false",
    VICE_KEEP_OPEN: "false",
    VICE_WARP: "true",
  }, ["--visible-demo"]);

  assert.equal(options.useMock, false);
  assert.equal(options.visibleDemo, true);
  assert.equal(options.visible, true);
  assert.equal(options.keepOpen, true);
  assert.equal(options.warp, false);
});

test("resolveViceSmokeOptions ignores invalid explicit ports and falls back safely", () => {
  const options = resolveViceSmokeOptions({
    VICE_TEST_TARGET: "vice",
    VICE_PORT: "not-a-port",
  }, []);

  assert.equal(options.configuredPort, 6502);
  assert.equal(options.hasExplicitPort, false);
});

test("resolveViceSmokeOptions accepts only valid TCP port numbers as explicit", () => {
  const valid = resolveViceSmokeOptions({ VICE_PORT: "6503" }, []);
  const outOfRange = resolveViceSmokeOptions({ VICE_PORT: "70000" }, []);

  assert.equal(valid.configuredPort, 6503);
  assert.equal(valid.hasExplicitPort, true);
  assert.equal(outOfRange.configuredPort, 6502);
  assert.equal(outOfRange.hasExplicitPort, false);
});
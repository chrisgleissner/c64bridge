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
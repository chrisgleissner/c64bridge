import test from "#test/runner";
import assert from "#test/assert";
import { shouldStartViceMockServer } from "./mcpTestHarness.mjs";

test("mcpTestHarness starts the vice mock by default for vice mock runs", () => {
  assert.equal(shouldStartViceMockServer({ C64_MODE: "vice", VICE_TEST_TARGET: "mock" }), true);
  assert.equal(shouldStartViceMockServer({ C64_MODE: "vice" }), true);
});

test("mcpTestHarness disables the vice mock for explicit real-vice runs", () => {
  assert.equal(shouldStartViceMockServer({ C64_MODE: "vice", VICE_TEST_TARGET: "vice" }), false);
  assert.equal(shouldStartViceMockServer({ C64_MODE: "vice", C64_TEST_ENABLE_VICE_MOCK: "0" }), false);
});

test("mcpTestHarness honours explicit vice mock opt-in outside vice mode", () => {
  assert.equal(shouldStartViceMockServer({ C64_MODE: "c64u", C64_TEST_ENABLE_VICE_MOCK: "1" }), true);
  assert.equal(shouldStartViceMockServer({ C64_MODE: "c64u" }), false);
});
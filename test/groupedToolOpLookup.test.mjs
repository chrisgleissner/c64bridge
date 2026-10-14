import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { ToolValidationError } from "../src/tools/errors.js";
import { getPlatformStatus, setPlatform } from "../src/platform.js";

const originalPlatform = getPlatformStatus().id;

test.after(() => {
  setPlatform(originalPlatform);
});

function createCtx() {
  return {
    client: {},
    rag: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    platform: getPlatformStatus(),
    setPlatform,
  };
}

async function captureOutcome(tool, op) {
  try {
    return { result: await toolRegistry.invoke(tool, { op }, createCtx()) };
  } catch (error) {
    return { error };
  }
}

test("grouped tools treat Object.prototype member names as unknown operations", async () => {
  for (const tool of ["c64_memory", "c64_input", "c64_system"]) {
    const unknown = await captureOutcome(tool, "no_such_op");
    assert.ok(unknown.error instanceof ToolValidationError, `${tool} should reject an unknown op`);

    for (const op of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const outcome = await captureOutcome(tool, op);
      assert.ok(
        outcome.error instanceof ToolValidationError,
        `${tool} op "${op}" should raise ToolValidationError, got ${outcome.error ?? JSON.stringify(outcome.result)}`,
      );
      assert.equal(outcome.error.message, `${tool} does not support op "${op}"`);
    }
  }
});

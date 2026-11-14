import { wireMeta } from "./wireMeta.mjs";
import assert from "#test/assert";

export function assertToolUnsupported(result, toolName, platform) {
  assert.equal(result.isError, true, `${toolName} should mark result as error when unsupported`);
  const error = wireMeta(result)?.error;
  assert.ok(error, `${toolName} should expose error metadata when unsupported`);
  assert.equal(error.kind, "execution", `${toolName} unsupported error kind should be execution`);
  assert.equal(error.code, "unsupported_platform", `${toolName} unsupported error code should be unsupported_platform`);
  const details = error.details ?? {};
  assert.equal(details.tool, toolName, `${toolName} should echo tool name in error details`);
  if (platform) {
    assert.equal(details.platform, platform, `${toolName} should include active platform in error details`);
  }
}

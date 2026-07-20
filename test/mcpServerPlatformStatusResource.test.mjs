import test from "#test/runner";
import assert from "#test/assert";

// mcp-server.ts auto-starts a live server on import unless opted out (it is
// always imported as a side effect by src/index.ts in real deployments, so
// it cannot gate on "am I the entrypoint"). A plain top-level `import` would
// run before this opt-out could be set, so load it dynamically instead.
process.env.C64BRIDGE_SKIP_AUTO_START = "1";
const { renderPlatformStatusMarkdown } = await import("../src/mcp-server.js");

function createFakeClient(overrides = {}) {
  return {
    getAvailableBackends() {
      return ["c64u"];
    },
    async getNativeEndpointCapabilities() {
      return { machineInput: "available", machineMenuScreen: "unknown" };
    },
    ...overrides,
  };
}

test("HARD01-031 renderPlatformStatusMarkdown returns quickly even when the machine:input probe never resolves", async () => {
  const client = createFakeClient({
    async getNativeEndpointCapabilities() {
      // Simulate an unreachable/booting Ultimate: the probe never settles.
      return new Promise(() => {});
    },
  });

  const start = Date.now();
  const markdown = await renderPlatformStatusMarkdown(client);
  const elapsed = Date.now() - start;

  // Must return well inside the 10s facade HTTP timeout; the resource is
  // documented as a cheap, side-effect-free metadata read.
  assert.ok(elapsed < 2_000, `expected a fast bounded response, took ${elapsed}ms`);
  assert.match(markdown, /machine:input.*\*\*unknown\*\*/s);
});

test("renderPlatformStatusMarkdown reports a confirmed capability without waiting for the timeout", async () => {
  const client = createFakeClient();
  const start = Date.now();
  const markdown = await renderPlatformStatusMarkdown(client);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `expected an immediate response, took ${elapsed}ms`);
  assert.match(markdown, /machine:input.*\*\*available\*\*/s);
});

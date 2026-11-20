import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { unknownErrorResult } from "../src/tools/errors.ts";

const platform = { id: "c64u", features: [], limitedFeatures: [] };
const ctx = {
  client: new Proxy({}, { get: (_target, name) => (name === "getAvailableBackends" ? () => ["c64u"] : () => { throw new Error(`no device: ${String(name)}`); }) }),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  rag: {},
  platform,
  setPlatform: () => platform,
};

async function errorText(name, args) {
  try {
    const result = await toolRegistry.invoke(name, args, ctx);
    return result.content[0].text;
  } catch (error) {
    return unknownErrorResult(error).content[0].text;
  }
}

test("WORKFLOW-9 a pattern error states the expected format with an example", async () => {
  const text = await errorText("c64_memory", { op: "write", address: "$0400", bytes: "zz" });
  assert.match(text, /expected format/);
  assert.match(text, /expected format: \/\^/);
  assert.match(text, /example: "\$A9/);
  assert.match(text, /received: "zz"/);
});

test("WORKFLOW-9 an unexpected property names the closest valid one", async () => {
  const text = await errorText("c64_memory", { op: "read", adress: "$0400", length: 1 });
  assert.match(text, /Unexpected property "adress"; did you mean "address"\?/);
  assert.match(text, /allowed: .*address/);
});

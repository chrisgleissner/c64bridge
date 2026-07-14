import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "#test/runner";
import assert from "#test/assert";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const c64u = YAML.parse(readFileSync(path.join(root, "doc/c64u/c64-openapi.yaml"), "utf8"));
const u2 = YAML.parse(readFileSync(path.join(root, "doc/u2/u2-openapi.yaml"), "utf8"));

function operations(spec) {
  return new Set(Object.entries(spec.paths).flatMap(([endpoint, item]) =>
    Object.keys(item)
      .filter((method) => ["get", "post", "put", "delete"].includes(method))
      .map((method) => `${method.toUpperCase()} ${endpoint}`),
  ));
}

test("U2 OpenAPI profile is a strict subset of the C64U/U64 profile", () => {
  const c64uOperations = operations(c64u);
  const u2Operations = operations(u2);
  for (const operation of u2Operations) {
    assert.ok(c64uOperations.has(operation), `${operation} must be available on C64U/U64`);
  }
  assert.ok(c64uOperations.has("POST /v1/machine:input"));
  assert.ok(!u2Operations.has("POST /v1/machine:input"));
  assert.ok(c64uOperations.has("PUT /v1/machine:poweroff"));
  assert.ok(!u2Operations.has("PUT /v1/machine:poweroff"));
  assert.ok(u2Operations.has("GET /v1/machine:menu_screen"));
});

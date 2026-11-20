import test from "#test/runner";
import assert from "#test/assert";
import { createPromptRegistry } from "../src/prompts/registry.ts";
import { ToolValidationError } from "../src/tools/errors.ts";

test("MCP-10 an invalid prompt argument is a validation error (InvalidParams), not an internal error", () => {
  const registry = createPromptRegistry();
  const cases = [
    ["assembly-program", { hardware: "foo" }],
    ["assembly-program", { hardware: 3 }],
    ["graphics-demo", { mode: "vector" }],
    ["game-development", { target: "amiga" }],
    ["game-development", { genre: 5 }],
    ["printer-job", { printerType: "laser" }],
  ];
  for (const [name, args] of cases) {
    assert.throws(() => registry.resolve(name, args), (error) => error instanceof ToolValidationError, `${name} ${JSON.stringify(args)}`);
  }
});

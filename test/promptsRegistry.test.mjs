import test from "#test/runner";
import assert from "#test/assert";
import { createPromptRegistry } from "../src/prompts/registry.js";

const registry = createPromptRegistry();

test("promptRegistry.list returns all prompts", () => {
  const prompts = registry.list();
  assert.ok(Array.isArray(prompts), "should return an array");
  assert.ok(prompts.length > 0, "should have at least one prompt");
  
  for (const entry of prompts) {
    assert.ok(entry.descriptor, "entry should have descriptor");
    assert.ok(entry.descriptor.name, "descriptor should have name");
    assert.ok(entry.descriptor.title, "descriptor should have title");
    assert.ok(entry.descriptor.description, "descriptor should have description");
    assert.ok(Array.isArray(entry.descriptor.requiredResources), "should have requiredResources");
    assert.ok(Array.isArray(entry.descriptor.tools), "should have tools");
  }
});

test("promptRegistry.resolve resolves a basic prompt", () => {
  const result = registry.resolve("basic-program", {});
  assert.ok(result, "should return a result");
  assert.equal(result.name, "basic-program");
  assert.ok(result.description, "should have description");
  assert.ok(Array.isArray(result.messages), "should have messages");
  assert.ok(result.messages.length > 0, "should have at least one message");
  assert.ok(Array.isArray(result.resources), "should have resources");
  assert.ok(Array.isArray(result.tools), "should have tools");
  assert.equal(result.resources.some((resource) => resource.uri === "c64://context/fast-paths"), true);
  assert.equal(result.messages.some((message) => message.content.includes(".github/skills/basic-program/SKILL.md")), true);
  assert.equal(result.messages.some((message) => message.content.includes("c64://docs/vice/binary-monitor-spec")), true);
});

test("promptRegistry.resolve exposes the cross-platform demo prompt", () => {
  const result = registry.resolve("cross-platform-demo", {});
  assert.ok(result, "should return a result");
  assert.equal(result.name, "cross-platform-demo");
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.name, "c64_program");
  assert.equal(result.resources.some((resource) => resource.uri === "c64://context/fast-paths"), true);
  assert.equal(result.messages.some((message) => message.content.includes("c64://docs/vice/binary-monitor-spec")), true);
});

test("promptRegistry.resolve exposes the preset music demo prompt", () => {
  const result = registry.resolve("preset-music-demo", {});
  assert.ok(result, "should return a result");
  assert.equal(result.name, "preset-music-demo");
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.name, "c64_sound");
  assert.equal(result.resources.some((resource) => resource.uri === "c64://context/fast-paths"), true);
  assert.equal(result.messages.some((message) => message.content.includes(".github/skills/sid-music/SKILL.md")), true);
});

test("promptRegistry.resolve throws for unknown prompt", () => {
  assert.throws(
    () => registry.resolve("nonexistent-prompt-xyz", {}),
    (err) => {
      assert.ok(err.message.includes("Unknown prompt"));
      return true;
    }
  );
});

test("promptRegistry.resolve handles assembly-program prompt with hardware argument", () => {
  const result = registry.resolve("assembly-program", { hardware: "sid" });
  assert.ok(result, "should return a result");
  assert.equal(result.name, "assembly-program");
  assert.ok(result.arguments, "should have prepared arguments");
  assert.equal(result.arguments.hardware, "sid");
  assert.ok(Array.isArray(result.messages), "should have messages");
  assert.ok(Array.isArray(result.resources), "should have resources");
  assert.ok(result.resources.length > 0, "should have at least one resource");
  assert.equal(result.messages.some((message) => message.content.includes("hardware is set to `sid`")), true);
});

test("promptRegistry.resolve handles graphics-demo prompt with mode argument", () => {
  const result = registry.resolve("graphics-demo", { mode: "multicolour" });
  assert.ok(result, "should return a result");
  assert.equal(result.name, "graphics-demo");
  assert.ok(result.arguments, "should have prepared arguments");
  assert.equal(result.arguments.mode, "multicolour");
  assert.equal(result.messages.some((message) => message.content.includes("mode is set to `multicolour`")), true);
});

test("promptRegistry.resolve handles printer-job prompt with printerType argument", () => {
  const result = registry.resolve("printer-job", { printerType: "epson" });
  assert.ok(result, "should return a result");
  assert.equal(result.name, "printer-job");
  assert.ok(result.arguments, "should have prepared arguments");
  assert.equal(result.arguments.printerType, "epson");
  assert.equal(result.messages.some((message) => message.content.includes("printerType is set to `epson`")), true);
});

test("promptRegistry.resolve handles workflow prompts", () => {
  // Test a few workflow prompts to ensure they resolve
  const workflows = ["memory-debug", "drive-manager", "cross-platform-demo", "preset-music-demo"];
  
  for (const name of workflows) {
    const result = registry.resolve(name, {});
    assert.ok(result, `${name} should resolve`);
    assert.equal(result.name, name);
    assert.ok(Array.isArray(result.messages), `${name} should have messages`);
    assert.ok(Array.isArray(result.tools), `${name} should have tools`);
    assert.equal(result.messages.some((message) => message.content.includes("single source of truth for execution")), true);
  }
});

test("all prompts have valid tool references", () => {
  const prompts = registry.list();
  
  for (const entry of prompts) {
    // Resolving should not throw if tool references are valid
    assert.doesNotThrow(
      () => registry.resolve(entry.descriptor.name, {}),
      `Prompt ${entry.descriptor.name} should resolve without errors`
    );
  }
});

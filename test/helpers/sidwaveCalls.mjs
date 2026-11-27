// Calls of `c64_sound` in a private work directory, for the SIDWave operation tests.
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../../src/tools/registry/index.js";
import { createLogger } from "../meta/helpers.mjs";

export function workspace(name) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `c64bridge-${name}-`)));
  process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
  const at = (file) => path.join(work, file);
  const write = (file, content) => { fs.writeFileSync(at(file), content); return at(file); };
  return { work, at, write };
}

const context = () => ({
  client: { async readMemoryRaw() { return new Uint8Array([1]); } },
  platform: { id: "vice", features: [], limitedFeatures: [] },
  rag: {},
  logger: createLogger(),
  setPlatform() {},
});

export async function sound(args) {
  const result = await toolRegistry.invoke("c64_sound", args, context());
  return { result, data: result.structuredContent?.data, text: result.content[0].text };
}

export async function ok(args) {
  const { result, data, text } = await sound(args);
  assert.notEqual(result.isError, true, `${args.op} failed: ${text}`);
  return data;
}

export async function rejected(args, pattern) {
  const { result, text } = await sound(args);
  assert.equal(result.isError, true, `${args.op} should fail: ${text}`);
  assert.match(text, pattern);
}

/** The operation is refused in read-only mode, as every operation that writes files must be. */
export async function blockedWhenReadOnly(args) {
  const previous = process.env.C64BRIDGE_ACCESS;
  process.env.C64BRIDGE_ACCESS = "read-only";
  try {
    await assert.rejects(sound(args), /effect "write".*read-only/);
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
}

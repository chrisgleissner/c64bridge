import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { tools as compilationTools } from "../../src/tools/meta/compilation.js";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

test("compile_run_verify_cycle compiles and verifies BASIC", async () => {
  const { dir } = tmpPath("cycle", "basic");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async uploadAndRunBasic() { return { success: true }; },
      async readScreen() { return "HELLO WORLD"; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("compile_run_verify_cycle", {
    sourceType: "basic",
    source: "10 PRINT \"HELLO WORLD\"",
    verifyScreen: "HELLO",
    durationMs: 5,
    outputPath: dir,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.compiled, true);
  assert.equal(data.ran, true);
  assert.equal(data.verified, true);
});

test("compile_run_verify_cycle handles ASM source", async () => {
  const { dir } = tmpPath("cycle", "asm");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async uploadAndRunAsm() { return { success: true }; },
      async readScreen() { return "ASM OUTPUT"; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("compile_run_verify_cycle", {
    sourceType: "asm",
    source: "LDA #$00",
    verifyScreen: "ASM",
    durationMs: 5,
    outputPath: dir,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.compiled, true);
  assert.equal(data.verified, true);
});

test("compile_run_verify_cycle detects verification failure", async () => {
  const { dir } = tmpPath("cycle", "fail");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async uploadAndRunBasic() { return { success: true }; },
      async readScreen() { return "WRONG OUTPUT"; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("compile_run_verify_cycle", {
    sourceType: "basic",
    source: "10 PRINT \"TEST\"",
    verifyScreen: "EXPECTED",
    durationMs: 5,
    outputPath: dir,
  }, ctx);

  assert.equal(res.metadata?.success, false);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.verified, false);
});

test("compile_run_verify_cycle handles SIDWAVE source", async () => {
  const { dir } = tmpPath("cycle", "sidwave");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async musicCompileAndPlay() { return { success: true }; },
      async readScreen() { return "SID PLAYING"; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("compile_run_verify_cycle", {
    sourceType: "sidwave",
    source: "note C4 100",
    durationMs: 5,
    outputPath: dir,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.compiled, true);
});

test("compile_run_verify_cycle succeeds without verification", async () => {
  const { dir } = tmpPath("cycle", "noverify");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async uploadAndRunBasic() { return { success: true }; },
      async readScreen() { return "ANY OUTPUT"; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("compile_run_verify_cycle", {
    sourceType: "basic",
    source: "10 PRINT \"TEST\"",
    durationMs: 5,
    outputPath: dir,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.compiled, true);
});

test("compile_run_verify_cycle handles compile errors", async () => {
  const { dir } = tmpPath("cycle", "error");
  await fs.mkdir(dir, { recursive: true });
  const ctx = {
    client: {
      async uploadAndRunBasic() { throw new Error("compilation failed"); },
      async readScreen() { return "ERROR"; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("compile_run_verify_cycle", {
    sourceType: "basic",
    source: "INVALID BASIC",
    durationMs: 5,
    outputPath: dir,
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("I2 compile cycle bounds duration and cancels without verification reads", async () => {
  const controller = new AbortController();
  const { dir } = tmpPath("cycle", "cancelled");
  let launches = 0;
  let reads = 0;
  const ctx = {
    signal: controller.signal,
    logger: createLogger(),
    client: {
      async uploadAndRunBasic() { launches += 1; controller.abort(); return { success: true }; },
      async readScreen() { reads += 1; return "READY."; },
    },
  };
  const args = { sourceType: "basic", source: "10 END", outputPath: dir };
  assert.equal(compilationTools[0].inputSchema.properties.durationMs.maximum, 600000);
  const invalid = await metaModule.invoke("compile_run_verify_cycle", { ...args, durationMs: 600001 }, ctx);
  assert.equal(invalid.metadata?.error?.kind, "validation");
  const result = await metaModule.invoke("compile_run_verify_cycle", { ...args, durationMs: 600000 }, ctx);
  assert.equal(result.metadata?.cancelled, true);
  assert.equal(launches, 1);
  assert.equal(reads, 0);
  const manifest = JSON.parse(await fs.readFile(`${dir}/manifest.json`, "utf8"));
  assert.equal(manifest.cancelled, true);
  assert.equal(manifest.ran, true);
  const preAborted = await metaModule.invoke("compile_run_verify_cycle", args, ctx);
  assert.equal(preAborted.metadata?.cancelled, true);
  assert.equal(launches, 1);
});

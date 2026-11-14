import test from "#test/runner";
import assert from "#test/assert";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";
import fs from "node:fs/promises";

function createSprite(fillFn) {
  const bytes = new Uint8Array(63);
  const setPixel = (x, y) => {
    if (x < 0 || x > 23 || y < 0 || y > 20) return;
    const byteIndex = Math.floor(x / 8);
    const bitIndex = 7 - (x % 8);
    const index = (y * 3) + byteIndex;
    bytes[index] |= (1 << bitIndex);
  };
  for (let y = 0; y < 21; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      if (fillFn(x, y)) setPixel(x, y);
    }
  }
  return bytes;
}

test("wait_for_screen_text resolves when pattern appears", async () => {
  let calls = 0;
  const ctx = {
    client: {
      async readScreen() { calls += 1; return calls < 2 ? "booting..." : "READY."; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "READY.", timeoutMs: 500, intervalMs: 20 }, ctx);
  assert.equal(res.metadata?.success, true);
  const body = res.structuredContent?.data;
  assert.equal(body?.matched, true);
  assert.ok(body?.elapsedMs >= 0);
});

test("wait_for_screen_text fails on timeout", async () => {
  const ctx = {
    client: { async readScreen() { return "never"; } },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "READY.", timeoutMs: 50, intervalMs: 20 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("extract_sprites_from_ram finds sprites and writes files", async () => {
  const spriteA = createSprite((x, y) => x === y || x === (23 - y));
  const spriteB = createSprite((x, y) => y >= 8 && y <= 12 && x >= 4 && x <= 19);
  const stride = 64;
  const blob = new Uint8Array(stride * 2);
  blob.set(spriteA, 0);
  blob.set(spriteB, stride);
  const hex = Buffer.from(blob).toString("hex").toUpperCase();

  let pauseCalls = 0;
  let resumeCalls = 0;
  let readCalls = 0;

  const out = tmpPath("sprites", "out");
  await fs.rm(out.dir, { recursive: true, force: true });

  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { pauseCalls += 1; return { success: true }; },
      async resume() { resumeCalls += 1; return { success: true }; },
      async readMemory(address, length) {
        readCalls += 1;
        assert.equal(address, "$2000");
        assert.equal(length, String(blob.length));
        return { success: true, data: `$${hex}` };
      },
    },
    logger: createLogger(),
  };

  const result = await metaModule.invoke("extract_sprites_from_ram", {
    address: "$2000",
    length: blob.length,
    stride,
    maxSprites: 4,
    outputDir: out.dir,
  }, ctx);

  assert.equal(result.metadata?.success, true);
  assert.equal(readCalls, 1);
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);

  const payload = result.structuredContent?.data;
  assert.ok(Array.isArray(payload?.sprites));
  assert.equal(payload?.sprites.length, 2);
  const [first, second] = payload.sprites;
  assert.ok(first.boundingBox);
  assert.ok(second.boundingBox);
  assert.ok(first.totalSetBits > 0);
  assert.equal(payload.outputFiles.length, 2);
  for (const file of payload.outputFiles) {
    await fs.access(file.path);
  }
});

test("extract_sprites_from_ram surfaces firmware failures", async () => {
  let pauseCalls = 0;
  let resumeCalls = 0;
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { pauseCalls += 1; return { success: true }; },
      async resume() { resumeCalls += 1; return { success: true }; },
      async readMemory() { return { success: false, details: { reason: "boom" } }; },
    },
    logger: createLogger(),
  };

  const result = await metaModule.invoke("extract_sprites_from_ram", {
    address: "$2000",
    length: 256,
    stride: 64,
  }, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.metadata?.error?.kind, "execution");
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);
});

test("rip_charset_from_ram extracts charset from specific address", async () => {
  // Create a mock charset with some variation
  const charset = new Uint8Array(2048);
  // Fill with pattern that looks like character data
  for (let charIndex = 0; charIndex < 256; charIndex += 1) {
    const offset = charIndex * 8;
    // Create varied patterns for first 128 chars
    if (charIndex < 128) {
      charset[offset] = charIndex % 256;
      charset[offset + 1] = (charIndex * 2) % 256;
      charset[offset + 2] = (charIndex * 3) % 256;
      charset[offset + 3] = 0xFF;
      charset[offset + 4] = (charIndex * 4) % 256;
      charset[offset + 5] = (charIndex * 5) % 256;
      charset[offset + 6] = (charIndex * 6) % 256;
      charset[offset + 7] = 0x00;
    }
  }
  const hex = Buffer.from(charset).toString("hex").toUpperCase();

  let pauseCalls = 0;
  let resumeCalls = 0;
  let readCalls = 0;

  const out = tmpPath("charset", "out");
  await fs.rm(out.dir, { recursive: true, force: true });
  const outputPath = `${out.dir}/charset.bin`;

  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { pauseCalls += 1; return { success: true }; },
      async resume() { resumeCalls += 1; return { success: true }; },
      async readMemory(address, length) {
        readCalls += 1;
        assert.equal(address, "$3000");
        assert.equal(length, "2048");
        return { success: true, data: `$${hex}` };
      },
    },
    logger: createLogger(),
  };

  const result = await metaModule.invoke("rip_charset_from_ram", {
    address: "$3000",
    outputPath,
  }, ctx);

  assert.equal(result.metadata?.success, true);
  assert.equal(readCalls, 1);
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);

  const payload = result.structuredContent?.data;
  assert.equal(payload?.found, true);
  assert.ok(payload?.charset);
  assert.equal(payload?.charset.address, "$3000");
  assert.equal(payload?.charset.sizeBytes, 2048);
  assert.ok(payload?.charset.nonEmptyChars > 0);
  assert.ok(payload?.outputFile);
  assert.equal(payload?.outputFile.path, outputPath);

  // Verify file was written
  await fs.access(outputPath);
  const written = await fs.readFile(outputPath);
  assert.equal(written.length, 2048);
});

test("rip_charset_from_ram reports not found when no valid charset", async () => {
  // Create mostly empty data
  const emptyData = new Uint8Array(2048);
  const hex = Buffer.from(emptyData).toString("hex").toUpperCase();

  let pauseCalls = 0;
  let resumeCalls = 0;

  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { pauseCalls += 1; return { success: true }; },
      async resume() { resumeCalls += 1; return { success: true }; },
      async readMemory() {
        return { success: true, data: `$${hex}` };
      },
    },
    logger: createLogger(),
  };

  const result = await metaModule.invoke("rip_charset_from_ram", {
    address: "$2000",
  }, ctx);

  assert.equal(result.metadata?.success, true);
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);

  const payload = result.structuredContent?.data;
  assert.equal(payload?.found, false);
  assert.ok(payload?.message);
});

test("rip_charset_from_ram scans common locations", async () => {
  // Create a mock charset
  const charset = new Uint8Array(2048);
  for (let charIndex = 0; charIndex < 128; charIndex += 1) {
    const offset = charIndex * 8;
    charset[offset] = charIndex % 256;
    charset[offset + 1] = (charIndex * 2) % 256;
    charset[offset + 2] = 0xFF;
    charset[offset + 3] = (charIndex * 3) % 256;
  }
  const hex = Buffer.from(charset).toString("hex").toUpperCase();

  let pauseCalls = 0;
  let resumeCalls = 0;
  let readCalls = 0;

  const ctx = {
    platform: { id: "c64u" },
    client: {
      async pause() { pauseCalls += 1; return { success: true }; },
      async resume() { resumeCalls += 1; return { success: true }; },
      async readMemory(address, length) {
        readCalls += 1;
        // Return valid charset data for $3000, empty for others
        if (address === "$3000") {
          return { success: true, data: `$${hex}` };
        }
        const empty = Buffer.alloc(2048).toString("hex").toUpperCase();
        return { success: true, data: `$${empty}` };
      },
    },
    logger: createLogger(),
  };

  const result = await metaModule.invoke("rip_charset_from_ram", {
    scanRange: "common",
  }, ctx);

  assert.equal(result.metadata?.success, true);
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);
  assert.equal(readCalls, 2); // $3000 and $2000; $D000-$DFFF is never read

  const payload = result.structuredContent?.data;
  assert.equal(payload?.found, true);
  assert.ok(payload?.charset);
  assert.ok(payload?.candidates >= 1);
});

function screenCtx(screenText, counter) {
  return {
    client: { async readScreen() { if (counter) counter.reads += 1; return screenText; } },
    logger: createLogger(),
  };
}

test("wait_for_screen_text rejects catastrophic, backreference, oversized and invalid patterns without reading the screen", async () => {
  const bun = typeof globalThis.Bun !== "undefined";
  const bad = [...(bun ? ["(a+)+$", "(a*)*b", "(x+y?){2,}", "(a|b+)*c", "(a)\\1", "(?<n>a)\\k<n>"] : []), "a".repeat(201), "(unclosed"];
  for (const pattern of bad) {
    const counter = { reads: 0 };
    const res = await metaModule.invoke("wait_for_screen_text", { pattern, isRegex: true, timeoutMs: 100, intervalMs: 20 }, screenCtx("A".repeat(1000), counter));
    assert.equal(res.isError, true, pattern);
    assert.equal(res.metadata?.error?.kind, "validation", pattern);
    assert.equal(counter.reads, 0, pattern);
  }
});

test("wait_for_screen_text runs backreference patterns on Node", async () => {
  if (typeof globalThis.Bun !== "undefined") return;
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "(a)\\1", isRegex: true, timeoutMs: 100, intervalMs: 20 }, screenCtx("xaay"));
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent?.data?.match?.text, "aa");
});

test("wait_for_screen_text stops a catastrophic pattern with the timeout error", async () => {
  if (typeof globalThis.Bun !== "undefined") return;
  const started = Date.now();
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "^(a+)+$", isRegex: true, timeoutMs: 1000 }, screenCtx("a".repeat(40) + "!"));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /\^\(a\+\)\+\$.*250 ms/);
  assert.ok(Date.now() - started < 1500);
  const second = await metaModule.invoke("wait_for_screen_text", { pattern: "x", timeoutMs: 100 }, screenCtx("x"));
  assert.equal(second.metadata?.success, true);
});

test("wait_for_screen_text accepts ordinary regular expressions and literal text that looks like a regex", async () => {
  const ok = await metaModule.invoke("wait_for_screen_text", { pattern: "(?:RE|AD)+Y\\.?$", isRegex: true, timeoutMs: 100, intervalMs: 20 }, screenCtx("READY."));
  assert.equal(ok.isError, undefined);
  const literal = await metaModule.invoke("wait_for_screen_text", { pattern: "(a+)+", timeoutMs: 100, intervalMs: 20 }, screenCtx("x (a+)+ y"));
  assert.equal(literal.isError, undefined);
});

test("wait_for_screen_text bounds timeoutMs and intervalMs", async () => {
  const tooLong = await metaModule.invoke("wait_for_screen_text", { pattern: "x", timeoutMs: 120001 }, screenCtx("x"));
  assert.equal(tooLong.metadata?.error?.kind, "validation");
  const tooFast = await metaModule.invoke("wait_for_screen_text", { pattern: "x", intervalMs: 19 }, screenCtx("x"));
  assert.equal(tooFast.metadata?.error?.kind, "validation");
});

test("wait_for_screen_text clamps intervalMs above 5000 and warns", async () => {
  const timedOut = await metaModule.invoke("wait_for_screen_text", { pattern: "yes", timeoutMs: 150, intervalMs: 9000 }, screenCtx("never"));
  assert.equal(timedOut.metadata?.error?.kind, "execution");
  assert.match(timedOut.metadata?.error?.details?.warnings?.[0] ?? "", /9000.*5000/);
  const matched = await metaModule.invoke("wait_for_screen_text", { pattern: "yes", timeoutMs: 150, intervalMs: 9000 }, screenCtx("yes"));
  assert.match(matched.structuredContent?.data?.warnings?.[0] ?? "", /9000.*5000/);
});

test("wait_for_screen_text timeout result includes the last screen text", async () => {
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "READY.", timeoutMs: 60, intervalMs: 20 }, screenCtx("LOADING..."));
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  assert.equal(res.metadata?.error?.details?.screen, "LOADING...");
});

test("waitForScreenText is exported for reuse and does not throw on timeout", async () => {
  const { waitForScreenText } = await import("../../src/tools/meta/screen.js");
  const timedOut = await waitForScreenText({ async readScreen() { return "abc"; } }, { pattern: "zzz", timeoutMs: 40, intervalMs: 20 });
  assert.equal(timedOut.matched, false);
  assert.equal(timedOut.screen, "abc");
  const hit = await waitForScreenText({ async readScreen() { return "abc"; } }, { pattern: "B", timeoutMs: 40, intervalMs: 20 });
  assert.equal(hit.matched, true);
  assert.equal(hit.match.index, 1);
});

test("wait_for_screen_text rejects overlapping alternation under a quantifier instead of hanging", async () => {
  const bun = typeof globalThis.Bun !== "undefined";
  const screen = "a".repeat(28);
  const ctx = { client: { async readScreen() { return screen; } }, logger: createLogger() };
  for (const pattern of ["(a|a)+c", "(.|.)+X", "(a|aa)+$", "(?:a|[ab])*c"]) {
    const started = Date.now();
    const res = await metaModule.invoke("wait_for_screen_text", { pattern, isRegex: true, timeoutMs: 200, intervalMs: 20 }, ctx);
    if (bun) {
      assert.equal(res.isError, true, pattern);
      assert.equal(res.metadata?.error?.kind, "validation", pattern);
    } else {
      assert.ok(Date.now() - started < 2000, pattern);
      assert.ok(res.isError === undefined || /250 ms/.test(res.content?.[0]?.text ?? ""), pattern);
    }
  }
});

test("wait_for_screen_text still accepts a repeated group of distinct literal alternatives", async () => {
  const ctx = { client: { async readScreen() { return "ABABAB"; } }, logger: createLogger() };
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "(a|b)+", isRegex: true, timeoutMs: 200, intervalMs: 20 }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.equal(res.structuredContent?.data?.match?.text, "ABABAB");
});

test("screen patterns are limited to three unbounded repeats", async () => {
  const bun = typeof globalThis.Bun !== "undefined";
  const started = Date.now();
  const ctx = { client: { async readScreen() { return "x".repeat(1000); } }, logger: createLogger() };
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "a*a*a*a*c", isRegex: true, timeoutMs: 200 }, ctx);
  if (bun) {
    assert.equal(res.isError, true);
    assert.equal(res.metadata?.error?.kind, "validation");
  } else {
    assert.ok(Date.now() - started < 2000);
    assert.ok(res.isError === undefined || res.metadata?.error?.kind === "execution");
  }
});

test("createScreenMatcher stops a pattern that the static checks cannot classify", async () => {
  // V8 enforces the vm timeout inside the regular expression engine; Bun does not.
  if (typeof globalThis.Bun !== "undefined") return;
  const { createScreenMatcher } = await import("../../src/tools/meta/screen.js");
  const match = createScreenMatcher(/a*a*a*a*a*a*a*a*c/, 100);
  const started = Date.now();
  assert.throws(() => match("a".repeat(1000)), /longer than 100 ms/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(createScreenMatcher(/b+/)("aabbb"), { index: 2, text: "bbb" });
});

test("wait_for_screen_text returns within timeoutMs even with a long interval", async () => {
  const ctx = { client: { async readScreen() { return "never"; } }, logger: createLogger() };
  const started = Date.now();
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "READY.", timeoutMs: 150, intervalMs: 5000 }, ctx);
  assert.equal(res.isError, true);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("wait_for_screen_text gives up on a stalled screen read at the deadline", async () => {
  const ctx = { client: { readScreen: () => new Promise(() => {}) }, logger: createLogger() };
  const started = Date.now();
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "READY.", timeoutMs: 150 }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("wait_for_screen_text matches on a read made just before the deadline", async () => {
  let calls = 0;
  const ctx = { client: { async readScreen() { calls += 1; return calls >= 2 ? "READY." : "x"; } }, logger: createLogger() };
  const res = await metaModule.invoke("wait_for_screen_text", { pattern: "READY.", timeoutMs: 300, intervalMs: 5000 }, ctx);
  assert.equal(res.metadata?.success, true);
});

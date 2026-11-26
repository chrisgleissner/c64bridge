import test from "#test/runner";
import assert from "#test/assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSample, readPcmFile } from "sidwave/pcm";
import { hostSidwaveFileReader, hostSidwaveReadOptions } from "../src/sidwaveHost.js";
import { DEFAULT_MAX_READ_BYTES } from "../src/hostPaths.js";

test("the host reader applies the host path rules and the host read size limit to file: samples", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-host-reader-"));
  try {
    const file = join(dir, "a.u8");
    writeFileSync(file, Uint8Array.of(0, 128, 255, 128));
    assert.equal(hostSidwaveReadOptions.maxFileBytes, DEFAULT_MAX_READ_BYTES);
    assert.equal(renderSample({ file, file_rate: 4000 }, 4000, hostSidwaveReadOptions).stats.source, "file");
    assert.equal(readPcmFile(file, 4000, hostSidwaveFileReader).data.length, 4);
    assert.throws(() => hostSidwaveFileReader("/etc/hosts"), /outside.*allowed|allowed roots/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

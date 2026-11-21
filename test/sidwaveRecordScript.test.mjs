import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The mock server runs in this process, so the script must be started asynchronously (spawnSync would block it).
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "sidwave-record.mjs"), ...args], { cwd: root });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("sidwave-record records the whole song after it starts and stops the stream", { timeout: 120_000 }, async () => {
  const mock = await startMockC64Server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-record-"));
  try {
    // Keep the score short; the mock paces 192 audio frames every 4 ms so the capture exercises real duration
    // accounting without waiting through one of the full-length examples.
    const song = path.join(dir, "short.yaml");
    fs.writeFileSync(song, "sidwave: 1.2\ntitle: Short\ntempo: 120\nvoices:\n  - id: 1\n    patterns: { a: { groove: \"C4 E4 G4 C5\" } }\ntimeline: [{ bars: 1, layers: { v1: a } }]\nend: { hold_beats: 0, release: true }\n");
    const wav = path.join(dir, "short.wav");
    const host = new URL(mock.baseUrl).host;
    const r = await run(["--host", host, "--song", song, "--wav", wav, "--tail-seconds", "0.5", "--no-configure"]);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const durationSeconds = Number(/, ([\d.]+) s, PAL/.exec(r.stdout)?.[1]);
    assert.ok(durationSeconds >= 2, r.stdout);
    assert.match(r.stdout, /prg \d+ bytes, sha256 [0-9a-f]{64}/);
    const bytes = fs.readFileSync(wav);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.readUInt16LE(22), 2);
    assert.equal(bytes.readUInt32LE(24), 47983);
    // The recording covers the song and the tail, counted from the moment the song started.
    const seconds = (bytes.length - 44) / 4 / 47982.8869047619;
    assert.ok(seconds >= durationSeconds + 0.5 - 0.01, `${seconds} s for a ${durationSeconds} s song`);
    assert.equal(mock.state.streams.audio.active, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("sidwave-record refuses to run without a host", async () => {
  const r = await run(["--song", "title_fanfare", "--wav", "x.wav"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--host is required/);
});

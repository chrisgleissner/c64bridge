import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { STALE_CLAIM_MS, withTaskStateLock } from "../src/taskStateLock.js";

function lockFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-lock-"));
  const file = path.join(base, "tasks.json");
  const lock = `${file}.lock`;
  fs.mkdirSync(lock, { recursive: true });
  return { base, file, lock };
}

function plantClaim(lock, pid, ageMs = 0) {
  const claim = path.join(lock, `${pid}_${randomUUID()}.json`);
  fs.writeFileSync(claim, JSON.stringify({ choosing: true, ticket: 0 }));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(claim, then, then);
  }
  return claim;
}

test("I18 a claim with this process's PID that this process does not hold is stale", async () => {
  const { base, file, lock } = lockFixture();
  try {
    // A restarted server in a container usually gets the PID of the crashed one.
    const leftover = plantClaim(lock, process.pid);
    const started = Date.now();
    assert.equal(await withTaskStateLock(file, async () => 42), 42);
    assert.ok(Date.now() - started < 2_000, `acquired in ${Date.now() - started} ms`);
    assert.equal(fs.existsSync(leftover), false, "the leftover claim was removed");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("I18 a claim of a live PID that was not refreshed for longer than the stale limit is ignored", async () => {
  const { base, file, lock } = lockFixture();
  try {
    // PID 1 always exists; its claim stands for a dead server whose PID was reused.
    const reused = plantClaim(lock, 1, STALE_CLAIM_MS + 60_000);
    const started = Date.now();
    assert.equal(await withTaskStateLock(file, async () => "ok"), "ok");
    assert.ok(Date.now() - started < 2_000, `acquired in ${Date.now() - started} ms`);
    assert.equal(fs.existsSync(reused), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("I18 a fresh claim of another live process still excludes, and concurrent holders in this process are not treated as stale", async () => {
  const { base, file, lock } = lockFixture();
  try {
    const live = plantClaim(lock, 1);
    // Ticket 0 while choosing: a live contender. Release it shortly so the lock is acquired afterwards.
    setTimeout(() => fs.rmSync(live, { force: true }), 300);
    const started = Date.now();
    let inside = 0;
    let maxInside = 0;
    await Promise.all(Array.from({ length: 4 }, () => withTaskStateLock(file, async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inside -= 1;
    })));
    assert.ok(Date.now() - started >= 250, "waited for the live claim");
    assert.equal(maxInside, 1, "mutual exclusion among holders of this process");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

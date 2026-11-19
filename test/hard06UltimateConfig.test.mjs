import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "#test/runner";
import assert from "#test/assert";
import { loadConfig } from "../src/config.ts";

// DEVICE-1: a credential goes only to the host it was configured for.

const ENV = ["C64BRIDGE_CONFIG", "C64_MODE", "C64U_HOST", "C64U_PORT", "C64U_PASSWORD", "U2_HOST", "U2_PORT", "U2_PASSWORD"];

function setup(t, doc, vars = {}) {
  const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(path.join(tmpdir(), "c64-hard06-config-"));
  const file = path.join(dir, "config.json");
  if (doc !== undefined) writeFileSync(file, JSON.stringify(doc), "utf8");
  for (const key of ENV) delete process.env[key];
  Object.assign(process.env, { C64BRIDGE_CONFIG: file }, vars);
  t.after(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file };
}

test("U2_HOST does not receive the password of the c64u section", (t) => {
  setup(t, { c64u: { host: "c64u.lan", networkPassword: "pw-for-c64u" } }, { U2_HOST: "u2.lan" });
  const config = loadConfig();
  assert.equal(config.ultimate.u2.baseUrl, "http://u2.lan");
  assert.equal(config.ultimate.u2.networkPassword, undefined);
  assert.equal(config.ultimate.c64u.networkPassword, "pw-for-c64u");
  process.env.C64_MODE = "u2";
  assert.equal(loadConfig().networkPassword, undefined);
});

test("U2_HOST does not receive C64U_PASSWORD or a legacy top-level password", (t) => {
  setup(t, { networkPassword: "legacy-pw" }, { U2_HOST: "u2.lan", C64U_PASSWORD: "env-pw" });
  const config = loadConfig();
  assert.equal(config.ultimate.u2.networkPassword, undefined);
  assert.equal(config.ultimate.c64u.networkPassword, "env-pw");
});

test("U2_PASSWORD still applies to U2_HOST, and the borrowed c64u settings keep their password", (t) => {
  setup(t, { c64u: { host: "c64u.lan", networkPassword: "pw-for-c64u" } }, { U2_HOST: "u2.lan", U2_PASSWORD: "pw-for-u2" });
  assert.equal(loadConfig().ultimate.u2.networkPassword, "pw-for-u2");
  delete process.env.U2_HOST;
  delete process.env.U2_PASSWORD;
  process.env.C64_MODE = "u2";
  // Without U2_HOST the U2 profile is the c64u device itself (documented fallback).
  const config = loadConfig();
  assert.equal(config.baseUrl, "http://c64u.lan");
  assert.equal(config.networkPassword, "pw-for-c64u");
});

test("a u2 section keeps its own password when U2_HOST overrides its host", (t) => {
  setup(t, { c64u: { host: "c64u.lan", networkPassword: "A" }, u2: { host: "u2.lan", networkPassword: "B" } }, { U2_HOST: "u2b.lan" });
  const config = loadConfig();
  assert.equal(config.ultimate.u2.baseUrl, "http://u2b.lan");
  assert.equal(config.ultimate.u2.networkPassword, "B");
});

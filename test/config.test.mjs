import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "#test/runner";
import assert from "#test/assert";
import { loadConfig, __resetConfigCacheForTests } from "../src/config.ts";

function writeTempConfig(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "c64-config-"));
  const file = path.join(dir, ".c64bridge.json");
  writeFileSync(file, JSON.stringify(contents, null, 2), "utf8");
  return { dir, file };
}

test("loadConfig supports host/port schema", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const { dir, file } = writeTempConfig({
    c64u: {
      host: "example.local",
      port: 6581,
    },
  });

  process.env.C64BRIDGE_CONFIG = file;
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "example.local:6581");
  assert.equal(config.baseUrl, "http://example.local:6581");
  assert.equal(config.c64_port, 6581);

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("loadConfig defaults port when omitted", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const { dir, file } = writeTempConfig({
    c64u: {
      host: "c64u",
    },
  });

  process.env.C64BRIDGE_CONFIG = file;
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "c64u");
  assert.equal(config.baseUrl, "http://c64u");
  assert.equal(config.c64_port, 80);

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("baseUrl entries provide fallback host/port but cannot override", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const { dir, file } = writeTempConfig({
    c64u: {
      host: "example.local",
      port: 1581,
      baseUrl: "http://ignored.local:1234",
    },
    baseUrl: "http://fall.back:4321",
  });

  process.env.C64BRIDGE_CONFIG = file;
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "example.local:1581");
  assert.equal(config.baseUrl, "http://example.local:1581");
  assert.equal(config.c64_port, 1581);

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("legacy configs with only baseUrl continue to work", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const { dir, file } = writeTempConfig({
    baseUrl: "http://legacy.local:9000",
  });

  process.env.C64BRIDGE_CONFIG = file;
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "legacy.local:9000");
  assert.equal(config.baseUrl, "http://legacy.local:9000");
  assert.equal(config.c64_port, 9000);

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("loadConfig includes networkPassword from c64u config", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const { dir, file } = writeTempConfig({
    c64u: {
      host: "c64u.local",
      networkPassword: "secret-pass",
    },
  });

  process.env.C64BRIDGE_CONFIG = file;
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.networkPassword, "secret-pass");

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("loadConfig lets C64U env vars override config and defaults", (t) => {
  const originalEnv = {
    C64BRIDGE_CONFIG: process.env.C64BRIDGE_CONFIG,
    C64U_HOST: process.env.C64U_HOST,
    C64U_PORT: process.env.C64U_PORT,
    C64U_PASSWORD: process.env.C64U_PASSWORD,
  };
  const { dir, file } = writeTempConfig({
    c64u: {
      host: "config.local",
      port: 6500,
      networkPassword: "config-secret",
    },
  });

  process.env.C64BRIDGE_CONFIG = file;
  process.env.C64U_HOST = "env.local";
  process.env.C64U_PORT = "6501";
  process.env.C64U_PASSWORD = "env-secret";
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "env.local:6501");
  assert.equal(config.baseUrl, "http://env.local:6501");
  assert.equal(config.c64_port, 6501);
  assert.equal(config.networkPassword, "env-secret");

  t.after(() => {
    __resetConfigCacheForTests();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("loadConfig prefers repo config over home config when env is unset", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const originalHome = process.env.HOME;
  const repoConfigPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".c64bridge.json");
  const repoConfigExisted = existsSync(repoConfigPath);
  const repoConfigContents = repoConfigExisted ? readFileSync(repoConfigPath, "utf8") : null;
  const homeDir = mkdtempSync(path.join(tmpdir(), "c64-home-"));

  writeFileSync(path.join(homeDir, ".c64bridge.json"), JSON.stringify({ c64u: { host: "home.example" } }, null, 2), "utf8");
  writeFileSync(repoConfigPath, JSON.stringify({ c64u: { host: "repo.example" } }, null, 2), "utf8");

  delete process.env.C64BRIDGE_CONFIG;
  process.env.HOME = homeDir;
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "repo.example");
  assert.equal(config.baseUrl, "http://repo.example");

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (repoConfigExisted && repoConfigContents !== null) {
      writeFileSync(repoConfigPath, repoConfigContents, "utf8");
    } else if (existsSync(repoConfigPath)) {
      unlinkSync(repoConfigPath);
    }
    rmSync(homeDir, { recursive: true, force: true });
  });
});

test("loadConfig falls back to defaults when no config candidates exist", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const originalHome = process.env.HOME;
  const repoConfigPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".c64bridge.json");
  const repoConfigExisted = existsSync(repoConfigPath);
  const repoConfigContents = repoConfigExisted ? readFileSync(repoConfigPath, "utf8") : null;

  delete process.env.C64BRIDGE_CONFIG;
  delete process.env.HOME;
  if (repoConfigExisted) {
    unlinkSync(repoConfigPath);
  }
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "c64u");
  assert.equal(config.baseUrl, "http://c64u");
  assert.equal(config.c64_port, 80);
  assert.equal(config.networkPassword, undefined);
  assert.equal(config.vicePrewarm, false);

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (repoConfigExisted && repoConfigContents !== null) {
      writeFileSync(repoConfigPath, repoConfigContents, "utf8");
    }
  });
});

test("loadConfig keeps VICE prewarming disabled by default", (t) => {
  const originalEnv = {
    C64BRIDGE_CONFIG: process.env.C64BRIDGE_CONFIG,
    VICE_PREWARM: process.env.VICE_PREWARM,
  };
  const { dir, file } = writeTempConfig({
    vice: {
      host: "127.0.0.1",
      port: 6502,
    },
  });

  process.env.C64BRIDGE_CONFIG = file;
  delete process.env.VICE_PREWARM;
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.vicePrewarm, false);

  t.after(() => {
    __resetConfigCacheForTests();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("loadConfig supports VICE prewarming via config and env override", (t) => {
  const originalEnv = {
    C64BRIDGE_CONFIG: process.env.C64BRIDGE_CONFIG,
    VICE_PREWARM: process.env.VICE_PREWARM,
  };
  const { dir, file } = writeTempConfig({
    vice: {
      host: "127.0.0.1",
      prewarm: true,
    },
  });

  process.env.C64BRIDGE_CONFIG = file;
  delete process.env.VICE_PREWARM;
  __resetConfigCacheForTests();

  const configEnabled = loadConfig();
  assert.equal(configEnabled.vicePrewarm, true);

  process.env.VICE_PREWARM = "0";
  __resetConfigCacheForTests();

  const configDisabledByEnv = loadConfig();
  assert.equal(configDisabledByEnv.vicePrewarm, false);

  t.after(() => {
    __resetConfigCacheForTests();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("loadConfig rethrows invalid JSON from configured path", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const { dir, file } = writeTempConfig({ c64u: { host: "placeholder" } });
  writeFileSync(file, "{ invalid json\n", "utf8");

  process.env.C64BRIDGE_CONFIG = file;
  __resetConfigCacheForTests();

  assert.throws(() => loadConfig(), /Unexpected token|Expected property name|JSON/);

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) {
      delete process.env.C64BRIDGE_CONFIG;
    } else {
      process.env.C64BRIDGE_CONFIG = originalEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

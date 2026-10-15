import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

test("loadConfig selects the U2 endpoint when C64_MODE=u2", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const originalMode = process.env.C64_MODE;
  const { dir, file } = writeTempConfig({
    c64u: { host: "c64u.local", port: 80 },
    u2: { host: "u2.local", port: 8080, networkPassword: "u2-secret" },
  });
  process.env.C64BRIDGE_CONFIG = file;
  process.env.C64_MODE = "u2";
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "u2.local:8080");
  assert.equal(config.baseUrl, "http://u2.local:8080");
  assert.equal(config.networkPassword, "u2-secret");

  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) delete process.env.C64BRIDGE_CONFIG;
    else process.env.C64BRIDGE_CONFIG = originalEnv;
    if (originalMode === undefined) delete process.env.C64_MODE;
    else process.env.C64_MODE = originalMode;
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
  // Isolated cwd rather than the real repo root: several test files exercise
  // this same "repo/cwd config" scenario concurrently (each in its own
  // process), and writing to the literal repo-root .c64bridge.json would
  // race across those processes on the same real file.
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const cwdDir = mkdtempSync(path.join(tmpdir(), "c64-cwd-"));
  const homeDir = mkdtempSync(path.join(tmpdir(), "c64-home-"));

  writeFileSync(path.join(homeDir, ".c64bridge.json"), JSON.stringify({ c64u: { host: "home.example" } }, null, 2), "utf8");
  writeFileSync(path.join(cwdDir, ".c64bridge.json"), JSON.stringify({ c64u: { host: "repo.example" } }, null, 2), "utf8");

  delete process.env.C64BRIDGE_CONFIG;
  process.env.HOME = homeDir;
  process.chdir(cwdDir);
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "repo.example");
  assert.equal(config.baseUrl, "http://repo.example");

  t.after(() => {
    __resetConfigCacheForTests();
    process.chdir(originalCwd);
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
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });
});

test("loadConfig falls back to defaults when no config candidates exist", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const cwdDir = mkdtempSync(path.join(tmpdir(), "c64-cwd-empty-"));

  delete process.env.C64BRIDGE_CONFIG;
  delete process.env.HOME;
  process.chdir(cwdDir);
  __resetConfigCacheForTests();

  const config = loadConfig();
  assert.equal(config.c64_host, "c64u");
  assert.equal(config.baseUrl, "http://c64u");
  assert.equal(config.c64_port, 80);
  assert.equal(config.networkPassword, undefined);
  assert.equal(config.vicePrewarm, false);

  t.after(() => {
    __resetConfigCacheForTests();
    process.chdir(originalCwd);
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
    rmSync(cwdDir, { recursive: true, force: true });
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

test("HARD01-006 a project-cwd .c64bridge.json is honoured from a foreign (installed-package-style) working directory", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();

  // Simulate the documented npm-installed layout: the server's own module
  // lives under node_modules, but the project (cwd) has its own config.
  const projectDir = mkdtempSync(path.join(tmpdir(), "c64-project-cwd-"));
  const homeDir = mkdtempSync(path.join(tmpdir(), "c64-home-cwd-"));
  writeFileSync(path.join(projectDir, ".c64bridge.json"), JSON.stringify({ c64u: { host: "project.example" } }, null, 2), "utf8");
  writeFileSync(path.join(homeDir, ".c64bridge.json"), JSON.stringify({ c64u: { host: "home.example" } }, null, 2), "utf8");

  delete process.env.C64BRIDGE_CONFIG;
  process.env.HOME = homeDir;
  process.chdir(projectDir);
  __resetConfigCacheForTests();

  try {
    const config = loadConfig();
    assert.equal(config.c64_host, "project.example");
    assert.equal(config.baseUrl, "http://project.example");
  } finally {
    process.chdir(originalCwd);
    __resetConfigCacheForTests();
    if (originalEnv === undefined) delete process.env.C64BRIDGE_CONFIG;
    else process.env.C64BRIDGE_CONFIG = originalEnv;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("HARD01-027 loadConfig warns and falls back from invalid JSON", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  const { dir, file } = writeTempConfig({ c64u: { host: "placeholder" } });
  writeFileSync(file, "{ invalid json\n", "utf8");

  process.env.C64BRIDGE_CONFIG = file;
  __resetConfigCacheForTests();

  assert.doesNotThrow(() => loadConfig());

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

test("legacy top-level fields never reach the other profile's endpoint", (t) => {
  const originalEnv = { config: process.env.C64BRIDGE_CONFIG, mode: process.env.C64_MODE };
  delete process.env.C64_MODE;
  const created = [];
  const load = (contents) => {
    const temp = writeTempConfig(contents);
    created.push(temp.dir);
    process.env.C64BRIDGE_CONFIG = temp.file;
    __resetConfigCacheForTests();
    return loadConfig();
  };
  t.after(() => {
    __resetConfigCacheForTests();
    for (const [key, value] of [["C64BRIDGE_CONFIG", originalEnv.config], ["C64_MODE", originalEnv.mode]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  // With a u2 section, top-level fields do not configure a c64u backend and do not alter the u2 endpoint.
  let config = load({ c64_host: "127.0.0.1", c64_port: 8080, networkPassword: "c64pw", u2: { host: "127.0.0.2" } });
  assert.equal(config.legacyUltimateEndpoint, false);
  assert.equal(config.ultimate.u2.baseUrl, "http://127.0.0.2");
  assert.equal(config.ultimate.u2.networkPassword, undefined);

  // The c64u endpoint never borrows the u2 section.
  config = load({ c64u: { host: "127.0.0.1" }, u2: { host: "127.0.0.2", port: 2222 } });
  assert.equal(config.ultimate.c64u.baseUrl, "http://127.0.0.1");

  // Empty legacy values do not count as a configured endpoint; real ones do.
  assert.equal(load({ c64_host: "", vice: { host: "127.0.0.1" } }).legacyUltimateEndpoint, false);
  config = load({ c64_host: "127.0.0.1", networkPassword: "pw" });
  assert.equal(config.legacyUltimateEndpoint, true);
  assert.equal(config.ultimate.c64u.baseUrl, "http://127.0.0.1");
  assert.equal(config.ultimate.c64u.networkPassword, "pw");
});

test("a baseUrl-only endpoint keeps its https scheme and path prefix", (t) => {
  const originalEnv = process.env.C64BRIDGE_CONFIG;
  // Host and port environment overrides would replace the section baseUrl.
  const savedOverrides = Object.fromEntries(["C64U_HOST", "C64U_PORT"].map((key) => [key, process.env[key]]));
  delete process.env.C64U_HOST;
  delete process.env.C64U_PORT;
  t.after(() => {
    for (const [key, value] of Object.entries(savedOverrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const created = [];
  const load = (contents) => {
    const temp = writeTempConfig(contents);
    created.push(temp.dir);
    process.env.C64BRIDGE_CONFIG = temp.file;
    __resetConfigCacheForTests();
    return loadConfig();
  };
  t.after(() => {
    __resetConfigCacheForTests();
    if (originalEnv === undefined) delete process.env.C64BRIDGE_CONFIG;
    else process.env.C64BRIDGE_CONFIG = originalEnv;
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(load({ c64u: { baseUrl: "https://proxy.local:8443/c64u/" } }).ultimate.c64u.baseUrl, "https://proxy.local:8443/c64u");
  const proxied = load({ c64u: { baseUrl: "https://proxy.local/c64u" } });
  assert.equal(proxied.baseUrl, "https://proxy.local/c64u");
  assert.equal(proxied.c64_port, 443);
  // An explicit host still wins and builds a plain http URL, as documented.
  assert.equal(load({ c64u: { host: "10.0.0.2", baseUrl: "https://proxy.local/c64u" } }).baseUrl, "http://10.0.0.2");
  assert.equal(load({ c64u: { baseUrl: "http://10.0.0.3:8080" } }).baseUrl, "http://10.0.0.3:8080");
  // c64_host omits the scheme's default port.
  assert.equal(proxied.c64_host, "proxy.local");
  assert.equal(load({ c64u: { baseUrl: "https://proxy.local:8443/c64u" } }).c64_host, "proxy.local:8443");
  // A port override keeps the scheme and path instead of downgrading to http.
  assert.equal(load({ c64u: { baseUrl: "https://proxy.local/c64u", port: 9443 } }).baseUrl, "https://proxy.local:9443/c64u");
});

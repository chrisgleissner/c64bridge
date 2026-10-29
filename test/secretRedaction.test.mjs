import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { createLoggingHttpClient } from "../src/loggingHttpClient.js";
import { readDiagnosticRecords, writeDiagnosticEvent } from "../src/diagnostics.ts";
import { ToolExecutionError, toolErrorResult, unknownErrorResult } from "../src/tools/errors.js";
import { clearRegisteredSecrets, redactText } from "../src/redact.js";
import { resolveUltimateEndpoint } from "../src/config.js";

const PASSWORD = "s3cr3t-Pa55w0rd-d1st1nct1ve";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    const sockets = new Set();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseURL: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

/** Loads a second copy of the logger that is not silenced by NODE_ENV=test. */
async function loadActiveLogger() {
  const previous = { NODE_ENV: process.env.NODE_ENV, LOG_LEVEL: process.env.LOG_LEVEL };
  process.env.NODE_ENV = "production";
  process.env.LOG_LEVEL = "debug";
  try {
    return await import(`../src/logger.js?secret-redaction=${Date.now()}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureConsole() {
  const lines = [];
  const original = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    original[method] = console[method];
    console[method] = (...args) => lines.push(util.format(...args.map((arg) => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 8 })))));
  }
  return { lines, restore: () => Object.assign(console, original) };
}

function everyRepresentation(error) {
  const results = [util.inspect(error, { depth: 10, showHidden: false }), error.message, String(error.stack)];
  try { results.push(JSON.stringify(error)); } catch { /* circular */ }
  if (typeof error.toJSON === "function") results.push(JSON.stringify(error.toJSON()));
  return results;
}

test("network password stays out of logs, diagnostics, tool results and error objects on failures", async (t) => {
  clearRegisteredSecrets();
  const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-redact-"));
  const previousEnv = {
    dir: process.env.C64BRIDGE_DIAGNOSTICS_DIR,
    enable: process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS,
    skip: process.env.C64BRIDGE_SKIP_AUTO_START,
    password: process.env.C64U_PASSWORD,
  };
  process.env.C64BRIDGE_DIAGNOSTICS_DIR = diagDir;
  process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = "1";
  process.env.C64BRIDGE_SKIP_AUTO_START = "1";
  process.env.C64U_PASSWORD = PASSWORD;
  let consoleCapture;
  t.after(() => {
    consoleCapture?.restore();
    for (const [key, name] of [["dir", "C64BRIDGE_DIAGNOSTICS_DIR"], ["enable", "C64BRIDGE_ENABLE_TEST_DIAGNOSTICS"], ["skip", "C64BRIDGE_SKIP_AUTO_START"], ["password", "C64U_PASSWORD"]]) {
      if (previousEnv[key] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[key];
    }
    fs.rmSync(diagDir, { recursive: true, force: true });
    clearRegisteredSecrets();
  });

  // The password is registered the same way production does it.
  const endpoint = resolveUltimateEndpoint("c64u", undefined, undefined);
  assert.equal(endpoint.networkPassword, PASSWORD);

  const { loggerFor } = await loadActiveLogger();
  const logger = loggerFor("redaction-test");
  // Importing the server replaces console methods, so capture only afterwards.
  const { toCallToolResult } = await import("../src/mcp-server.ts");
  consoleCapture = captureConsole();

  const server = await startServer((req, res) => {
    assert.equal(req.headers["x-password"], PASSWORD, "the header must still be sent");
    if (req.url === "/unauthorized") { res.statusCode = 401; res.end(`bad password ${PASSWORD}`); return; }
    if (req.url === "/forbidden") { res.statusCode = 403; res.end("forbidden"); return; }
    // /hang never answers, so the client times out.
  });
  t.after(() => server.close());
  const closedPort = await startServer(() => {});
  const refusedURL = closedPort.baseURL;
  await closedPort.close();

  const failures = [];
  const attempt = async (baseURL, url, timeout) => {
    const client = createLoggingHttpClient({ baseURL, timeout, headers: { "X-Password": PASSWORD } }, logger);
    try {
      await client.instance.get(url);
      assert.fail(`${url} should have failed`);
    } catch (error) {
      assert.ok(error.isAxiosError, "expected an Axios error");
      failures.push(error);
    }
  };
  await attempt(server.baseURL, "/unauthorized", 2000);
  await attempt(server.baseURL, "/forbidden", 2000);
  await attempt(server.baseURL, "/hang", 100);
  await attempt(refusedURL, "/v1/version", 2000);
  assert.equal(failures.length, 4);
  assert.equal(failures[0].response.status, 401, "status stays available to callers");
  assert.ok(failures[2].code === "ECONNABORTED" || /timeout/i.test(failures[2].message));

  const collected = [];
  for (const error of failures) {
    collected.push(...everyRepresentation(error));
    logger.error("operation failed", { error });
    writeDiagnosticEvent("failure", { error, nested: { headers: { "X-Password": PASSWORD }, text: `echo ${PASSWORD}` } });
    const failure = new ToolExecutionError("Request failed", { details: { message: error.message, error, echoed: PASSWORD } });
    for (const result of [toolErrorResult(failure), unknownErrorResult(error), unknownErrorResult(new Error(`rejected ${PASSWORD}`))]) {
      collected.push(JSON.stringify(toCallToolResult(result)));
    }
  }
  // Server-echoed text and a message containing the password.
  logger.warn(`device said ${PASSWORD}`);
  collected.push(redactText(`device said ${PASSWORD}`));

  const diagnostics = readDiagnosticRecords();
  collected.push(JSON.stringify(diagnostics));
  for (const file of fs.readdirSync(diagDir)) collected.push(fs.readFileSync(path.join(diagDir, file), "utf8"));
  collected.push(...consoleCapture.lines);

  assert.ok(consoleCapture.lines.length >= failures.length, "failures must have been logged");
  assert.ok(fs.readdirSync(diagDir).length > 0, "diagnostics must have been written");
  for (const text of collected) {
    assert.ok(!text.includes(PASSWORD), `password leaked in: ${text.slice(0, 200)}`);
  }
});

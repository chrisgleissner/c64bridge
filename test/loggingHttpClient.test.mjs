import test from "#test/runner";
import assert from "#test/assert";
import { createLoggingHttpClient } from "../src/loggingHttpClient.js";

function createMockLogger() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  return {
    logs,
    info(...args) { logs.info.push(args); },
    warn(...args) { logs.warn.push(args); },
    error(...args) { logs.error.push(args); },
    debug(...args) { logs.debug.push(args); },
    isDebugEnabled() { return false; },
  };
}

function createDebugLogger() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  return {
    logs,
    info(...args) { logs.info.push(args); },
    warn(...args) { logs.warn.push(args); },
    error(...args) { logs.error.push(args); },
    debug(...args) { logs.debug.push(args); },
    isDebugEnabled() { return true; },
  };
}

test("createLoggingHttpClient creates client with interceptors", () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  assert.ok(client);
  assert.ok(client.instance);
  assert.ok(client.instance.interceptors);
});

test("request interceptor captures metadata", async () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost:8080" }, logger);
  
  // Mock a response handler
  client.instance.interceptors.response.use(
    (response) => {
      const config = response.config;
      assert.ok(config.__c64Meta);
      assert.equal(config.__c64Meta.method, "GET");
      assert.ok(config.__c64Meta.startedAt > 0);
      return response;
    },
    (error) => Promise.reject(error)
  );
  
  // Simulate a request being processed
  const requestConfig = {
    method: "get",
    url: "/test",
    headers: { "Content-Type": "application/json" },
    params: { q: "test" },
    data: { key: "value" },
  };
  
  const interceptedRequest = client.instance.interceptors.request.handlers[0].fulfilled(requestConfig);
  assert.ok(interceptedRequest.__c64Meta);
  assert.equal(interceptedRequest.__c64Meta.method, "GET");
  assert.equal(interceptedRequest.__c64Meta.path, "/test");
  assert.ok(interceptedRequest.__c64Meta.startedAt);
});

test("response interceptor logs success without debug", () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  
  const requestConfig = {
    method: "post",
    url: "/api/test",
    __c64Meta: {
      startedAt: Date.now() - 50,
      method: "POST",
      path: "/api/test",
    },
  };
  
  const response = {
    status: 200,
    data: { result: "ok" },
    config: requestConfig,
    headers: { "content-type": "application/json" },
  };
  
  client.instance.interceptors.response.handlers[0].fulfilled(response);
  
  assert.equal(logger.logs.info.length, 1);
  const logMsg = logger.logs.info[0][0];
  assert.ok(logMsg.includes("POST"));
  assert.ok(logMsg.includes("/api/test"));
  assert.ok(logMsg.includes("status=200"));
  assert.equal(logger.logs.debug.length, 0);
});

test("response interceptor logs with debug enabled", () => {
  const logger = createDebugLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  
  const requestConfig = {
    method: "get",
    url: "/data",
    __c64Meta: {
      startedAt: Date.now() - 30,
      method: "GET",
      path: "/data",
      headers: { accept: "application/json" },
      params: { id: "123" },
      body: null,
    },
  };
  
  const response = {
    status: 200,
    data: { items: [1, 2, 3] },
    config: requestConfig,
    headers: { "content-type": "application/json" },
  };
  
  client.instance.interceptors.response.handlers[0].fulfilled(response);
  
  assert.equal(logger.logs.info.length, 1);
  assert.ok(logger.logs.debug.length >= 2);
  const debugLogs = logger.logs.debug.map(d => d[0]);
  assert.ok(debugLogs.some(log => log.includes("request")));
  assert.ok(debugLogs.some(log => log.includes("response")));
});

test("HARD01-024 the request interceptor redacts X-Password (case-insensitively) before it ever reaches metadata/logs", () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);

  const requestConfig = {
    method: "put",
    url: "/v1/machine:reset",
    headers: { "X-Password": "super-secret", Accept: "application/json" },
  };

  const intercepted = client.instance.interceptors.request.handlers[0].fulfilled(requestConfig);
  assert.equal(intercepted.__c64Meta.headers["X-Password"], "***");
  assert.equal(intercepted.__c64Meta.headers.Accept, "application/json");
  assert.equal(JSON.stringify(intercepted.__c64Meta).includes("super-secret"), false);
});

test("HARD01-024 debug response/error logging never emits the raw X-Password value", () => {
  const logger = createDebugLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);

  // Route through the real request interceptor first, exactly as axios
  // would, so __c64Meta.headers reflects genuine redacted production state
  // rather than a hand-crafted (and therefore unrealistic) test double.
  const requestConfig = client.instance.interceptors.request.handlers[0].fulfilled({
    method: "get",
    url: "/v1/info",
    headers: { "x-password": "super-secret" },
  });

  const response = {
    status: 200,
    data: { ok: true },
    config: requestConfig,
    headers: { "x-password": "super-secret", "content-type": "application/json" },
  };

  client.instance.interceptors.response.handlers[0].fulfilled(response);

  const allDebugLogs = logger.logs.debug.map((entry) => JSON.stringify(entry));
  assert.ok(allDebugLogs.every((entry) => !entry.includes("super-secret")));
  const responseLog = logger.logs.debug.find((entry) => entry[0].includes("response"));
  assert.equal(responseLog[1].headers["x-password"], "***");
});

test("response interceptor handles missing metadata", () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  
  const response = {
    status: 201,
    data: "created",
    config: {
      method: "put",
      url: "/resource",
    },
    headers: {},
  };
  
  client.instance.interceptors.response.handlers[0].fulfilled(response);
  
  assert.equal(logger.logs.info.length, 1);
  const logMsg = logger.logs.info[0][0];
  assert.ok(logMsg.includes("PUT"));
  assert.ok(logMsg.includes("/resource"));
  assert.ok(logMsg.includes("status=201"));
});

test("error interceptor logs error without response", async () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  
  const error = {
    message: "Network Error",
    config: {
      method: "get",
      url: "/fail",
      __c64Meta: {
        startedAt: Date.now() - 100,
        method: "GET",
        path: "/fail",
      },
    },
  };
  
  await assert.rejects(
    async () => client.instance.interceptors.response.handlers[0].rejected(error)
  );
  
  assert.equal(logger.logs.warn.length, 1);
  const logMsg = logger.logs.warn[0][0];
  assert.ok(logMsg.includes("GET"));
  assert.ok(logMsg.includes("/fail"));
  assert.ok(logMsg.includes("status=ERR"));
});

test("error interceptor logs error with response", async () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  
  const error = {
    message: "Bad Request",
    response: {
      status: 400,
      data: { error: "Invalid input" },
      headers: {},
    },
    config: {
      method: "post",
      url: "/submit",
      __c64Meta: {
        startedAt: Date.now() - 50,
        method: "POST",
        path: "/submit",
      },
    },
  };
  
  await assert.rejects(
    async () => client.instance.interceptors.response.handlers[0].rejected(error)
  );
  
  assert.equal(logger.logs.warn.length, 1);
  const logMsg = logger.logs.warn[0][0];
  assert.ok(logMsg.includes("POST"));
  assert.ok(logMsg.includes("/submit"));
  assert.ok(logMsg.includes("status=400"));
});

test("error interceptor handles error without config", async () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  
  const error = {
    message: "Connection refused",
    config: undefined,
  };
  
  await assert.rejects(
    async () => client.instance.interceptors.response.handlers[0].rejected(error)
  );
  
  assert.equal(logger.logs.error.length, 1);
  const logMsg = logger.logs.error[0][0];
  assert.ok(logMsg.includes("UNKNOWN"));
  assert.ok(logMsg.includes("status=ERR"));
});

test("error interceptor logs with debug enabled", async () => {
  const logger = createDebugLogger();
  const client = createLoggingHttpClient({ baseURL: "http://localhost" }, logger);
  
  const error = {
    message: "Forbidden",
    response: {
      status: 403,
      data: { message: "Access denied" },
      headers: { "x-error": "forbidden" },
    },
    config: {
      method: "delete",
      url: "/protected",
      __c64Meta: {
        startedAt: Date.now() - 25,
        method: "DELETE",
        path: "/protected",
        headers: { authorization: "Bearer token" },
        params: null,
        body: null,
      },
    },
  };
  
  await assert.rejects(
    async () => client.instance.interceptors.response.handlers[0].rejected(error)
  );
  
  assert.equal(logger.logs.warn.length, 1);
  assert.ok(logger.logs.debug.length >= 2);
  const debugLogs = logger.logs.debug.map(d => d[0]);
  assert.ok(debugLogs.some(log => log.includes("request")));
  assert.ok(debugLogs.some(log => log.includes("error")));
});

test("resolvePath handles missing url and baseURL", () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({}, logger);
  
  const response = {
    status: 200,
    data: "ok",
    config: {
      method: "get",
    },
    headers: {},
  };
  
  client.instance.interceptors.response.handlers[0].fulfilled(response);
  
  assert.equal(logger.logs.info.length, 1);
  const logMsg = logger.logs.info[0][0];
  assert.ok(logMsg.includes("UNKNOWN"));
});

test("resolvePath prefers url over baseURL", () => {
  const logger = createMockLogger();
  const client = createLoggingHttpClient({ baseURL: "http://base" }, logger);
  
  const response = {
    status: 200,
    data: "ok",
    config: {
      method: "get",
      url: "/specific",
      baseURL: "http://base",
    },
    headers: {},
  };
  
  client.instance.interceptors.response.handlers[0].fulfilled(response);
  
  assert.equal(logger.logs.info.length, 1);
  const logMsg = logger.logs.info[0][0];
  assert.ok(logMsg.includes("/specific"));
  assert.ok(!logMsg.includes("http://base") || logMsg.includes("/specific"));
});

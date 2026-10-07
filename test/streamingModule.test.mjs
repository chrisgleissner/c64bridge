import test from "#test/runner";
import assert from "#test/assert";
import { streamingModule } from "../src/tools/streaming.js";
import { getPlatformStatus, setPlatform } from "../src/platform.js";

function createCtx() {
  return {
    client: {
      streamStart: async () => ({ success: true }),
      streamStop: async () => ({ success: true }),
    },
    logger: {
      info() {},
    },
  };
}

const platform = (process.env.C64_MODE ?? "").toLowerCase() === "vice" ? "vice" : "c64u";
const isVice = platform === "vice";
const testC64uOnly = isVice ? test.skip : test;

async function runWithPlatform(target, fn) {
  const original = getPlatformStatus().id;
  try {
    setPlatform(target);
    await fn();
  } finally {
    setPlatform(original);
  }
}

testC64uOnly("stream_start forwards parsed payload", async () => {
  const ctx = createCtx();
  const calls = [];
  ctx.client.streamStart = async (stream, target) => {
    calls.push({ stream, target });
    return { success: true, details: { mode: stream } };
  };

  const result = await streamingModule.invoke(
    "stream_start",
    { stream: "audio", target: "127.0.0.1:1234" },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.deepEqual(calls, [{ stream: "audio", target: "127.0.0.1:1234" }]);
  assert.deepEqual(result.metadata.details, { mode: "audio" });
});

testC64uOnly("stream_start surfaces firmware failure", async () => {
  const ctx = createCtx();
  ctx.client.streamStart = async () => ({ success: false, details: { reason: "busy" } });

  const result = await streamingModule.invoke(
    "stream_start",
    { stream: "video", target: "127.0.0.1:9000" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "execution");
  assert.deepEqual(result.metadata.error.details, { reason: "busy" });
});

testC64uOnly("stream_stop forwards parsed payload", async () => {
  const ctx = createCtx();
  const calls = [];
  ctx.client.streamStop = async (stream) => {
    calls.push(stream);
    return { success: true, details: { stopped: stream } };
  };

  const result = await streamingModule.invoke(
    "stream_stop",
    { stream: "debug" },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.deepEqual(calls, ["debug"]);
  assert.deepEqual(result.metadata.details, { stopped: "debug" });
});

testC64uOnly("stream_stop surfaces firmware failure", async () => {
  const ctx = createCtx();
  ctx.client.streamStop = async () => ({ success: false, details: { reason: "not-running" } });

  const result = await streamingModule.invoke(
    "stream_stop",
    { stream: "audio" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "execution");
  assert.deepEqual(result.metadata.error.details, { reason: "not-running" });
});

if (isVice) {
  test("streaming tools are unavailable on vice", () =>
    runWithPlatform("vice", async () => {
      await assert.rejects(
        () => streamingModule.invoke(
          "stream_start",
          { stream: "audio", target: "127.0.0.1:9000" },
          createCtx(),
        ),
        (error) => error?.name === "ToolUnsupportedPlatformError",
      );
    }));
}

testC64uOnly("stream_start includes the failure reason in the error text when the client provides one", async () => {
  const ctx = createCtx();
  ctx.client.streamStart = async () => ({ success: false, details: { message: "could not resolve target" } });

  const result = await streamingModule.invoke(
    "stream_start",
    { stream: "audio", target: "127.0.0.1:9000" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("firmware reported failure while starting stream: could not resolve target"));
});

testC64uOnly("stream_stop includes the failure reason in the error text when the client provides one", async () => {
  const ctx = createCtx();
  ctx.client.streamStop = async () => ({ success: false, details: { message: "no active stream" } });

  const result = await streamingModule.invoke("stream_stop", { stream: "audio" }, ctx);

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("firmware reported failure while stopping stream: no active stream"));
});

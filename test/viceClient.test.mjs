import test from "#test/runner";
import assert from "#test/assert";
import net from "node:net";
import { ViceClient } from "../src/vice/viceClient.js";
import { startViceMockServer } from "../src/vice/mockServer.js";

test("ViceClient normalizes string and typed-array data chunks", () => {
  const client = new ViceClient();

  client.onData?.("AB");
  client.onData?.(new Uint8Array([0x43, 0x44]));

  assert.equal(client.buffer.toString("ascii"), "ABCD");
});

function buildResponse(reqId, respType, body = Buffer.alloc(0), err = 0x00) {
  const header = Buffer.alloc(12);
  header[0] = 0x02;
  header[1] = 0x02;
  header.writeUInt32LE(body.length, 2);
  header[6] = respType;
  header[7] = err;
  header.writeUInt32LE(reqId, 8);
  return Buffer.concat([header, body]);
}

function parseRequest(packet) {
  const bodyLen = packet.readUInt32LE(2);
  return {
    bodyLen,
    reqId: packet.readUInt32LE(6),
    cmd: packet[10],
    body: packet.subarray(11, 11 + bodyLen),
  };
}

async function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  server.__testSockets = sockets;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  for (const socket of server.__testSockets ?? []) {
    socket.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
}

test("ViceClient encodes requests and decodes protocol responses", async (t) => {
  const requests = [];
  const memDump = Buffer.from([0xAA, 0xBB, 0xCC]);

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 11) {
        const bodyLen = buffer.readUInt32LE(2);
        const total = 11 + bodyLen;
        if (buffer.length < total) {
          return;
        }

        const packet = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        const request = parseRequest(packet);
        requests.push(request);

        const responseBody = request.cmd === 0x01
          ? Buffer.concat([Buffer.from([memDump.length, 0x00]), memDump])
          : Buffer.alloc(0);

        socket.write(buildResponse(request.reqId, request.cmd, responseBody));
        if (request.cmd === 0xBB) {
          queueMicrotask(() => socket.end());
        }
      }
    });
  });

  t.after(async () => {
    await closeServer(server);
  });

  const port = await listen(server);
  const client = new ViceClient();
  t.after(() => {
    client.close();
  });

  await client.connect(port);
  await client.info();
  await client.resetSoft();
  await client.resetHard();
  await client.reset();
  await client.reset(1);
  const memory = await client.memGet(0x1000, 0x1002);
  await client.memSet(0x2000, Buffer.from([0x10, 0x11, 0x12]));
  const beforeEmptyKeyboard = requests.length;
  await client.keyboardFeed("");
  await client.keyboardFeed("RUN\r");
  await client.exitMonitor();
  await client.quit();

  assert.deepEqual(Array.from(memory), Array.from(memDump));
  assert.equal(requests.length, beforeEmptyKeyboard + 3);
  assert.deepEqual(
    requests.map((request) => request.cmd),
    [0x85, 0xCC, 0xCC, 0xCC, 0xCC, 0x01, 0x02, 0x72, 0xAA, 0xBB]
  );

  assert.deepEqual(Array.from(requests[1].body), [0x00]);
  assert.deepEqual(Array.from(requests[2].body), [0x01]);
  assert.deepEqual(Array.from(requests[3].body), [0x00]);
  assert.deepEqual(Array.from(requests[4].body), [0x01]);

  assert.equal(requests[5].body[0], 0x00);
  assert.equal(requests[5].body.readUInt16LE(1), 0x1000);
  assert.equal(requests[5].body.readUInt16LE(3), 0x1002);
  assert.equal(requests[5].body[5], 0x00);
  assert.equal(requests[5].body.readUInt16LE(6), 0x0000);

  assert.equal(requests[6].body[0], 0x01);
  assert.equal(requests[6].body.readUInt16LE(1), 0x2000);
  assert.equal(requests[6].body.readUInt16LE(3), 0x2002);
  assert.equal(requests[6].body[5], 0x00);
  assert.equal(requests[6].body.readUInt16LE(6), 0x0000);
  assert.deepEqual(Array.from(requests[6].body.subarray(8)), [0x10, 0x11, 0x12]);

  assert.equal(requests[7].body[0], 4);
  assert.equal(requests[7].body.subarray(1).toString("ascii"), "RUN\r");
});

test("HARD01-014 joyportSet sends BM command 0xA2 with port and active-low value encoded per spec", async (t) => {
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 11) {
        const bodyLen = buffer.readUInt32LE(2);
        const total = 11 + bodyLen;
        if (buffer.length < total) return;
        const packet = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        const request = parseRequest(packet);
        requests.push(request);
        socket.write(buildResponse(request.reqId, request.cmd, Buffer.alloc(0)));
      }
    });
  });
  t.after(async () => { await closeServer(server); });

  const port = await listen(server);
  const client = new ViceClient();
  t.after(() => client.close());
  await client.connect(port);

  await client.joyportSet(2, 0xF7); // port 2, right pressed (active-low bit cleared)
  await client.joyportSet(1, 0xFF); // port 1, released

  assert.deepEqual(requests.map((r) => r.cmd), [0xA2, 0xA2]);
  // VICE numbers joyports from 0 (joyport.h: JOYPORT_1 = 0, JOYPORT_2 = 1), so
  // control port 2 is sent as 1 and control port 1 as 0.
  assert.equal(requests[0].body.readUInt16LE(0), 1);
  assert.equal(requests[0].body.readUInt16LE(2), 0xF7);
  assert.equal(requests[1].body.readUInt16LE(0), 0);
  assert.equal(requests[1].body.readUInt16LE(2), 0xFF);
});

test("HARD01-012 a request that never gets a response times out, releases the pending queue, and a later request succeeds after reconnect", async (t) => {
  let respond = false;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 11) {
        const bodyLen = buffer.readUInt32LE(2);
        const total = 11 + bodyLen;
        if (buffer.length < total) return;
        const packet = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        if (!respond) {
          // Simulate a lost/never-answered frame: accept the command, never reply.
          continue;
        }
        const request = parseRequest(packet);
        socket.write(buildResponse(request.reqId, request.cmd, Buffer.alloc(0)));
      }
    });
  });

  t.after(async () => {
    await closeServer(server);
  });

  const port = await listen(server);
  const client = new ViceClient();
  t.after(() => client.close());
  await client.connect(port);

  const start = Date.now();
  await assert.rejects(
    // Bypass the public wrappers' long production default so the test stays
    // fast and deterministic; `send` is TS-private only, not runtime-hidden.
    () => client.send(0x85, undefined, { timeoutMs: 100 }),
    /timed out/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 90, `expected the request to wait roughly the timeout, got ${elapsed}ms`);
  assert.equal(client.pending.size, 0, "the timed-out request must be removed from the pending map");

  // The timeout destroys the unhealthy socket. Production always constructs
  // a fresh ViceClient per connection (see ViceBackend.withClient); match
  // that here rather than reusing the client whose old socket's async
  // teardown could otherwise race a new pending request.
  respond = true;
  const reconnected = new ViceClient();
  t.after(() => reconnected.close());
  await reconnected.connect(port);
  await reconnected.info();
});

test("ViceClient re-syncs partial frames and ignores unsolicited events", () => {
  const client = new ViceClient();
  let resolvedFrame = null;
  let rejectedError = null;

  client.pending.set(7, {
    cmd: 0x44,
    resolve: (frame) => {
      resolvedFrame = frame;
    },
    reject: (error) => {
      rejectedError = error;
    },
  });

  client.onData(Buffer.alloc(12, 0x01));
  assert.equal(client.buffer.length, 0);

  const unsolicited = buildResponse(0xffffffff, 0x44);
  const response = buildResponse(7, 0x44, Buffer.from([0x10, 0x20, 0x30]));
  const payload = Buffer.concat([Buffer.from([0x00]), unsolicited, response]);

  client.onData(payload.subarray(0, 10));
  assert.equal(resolvedFrame, null);
  client.onData(payload.subarray(10));

  assert.equal(rejectedError, null);
  assert.ok(Buffer.isBuffer(resolvedFrame));
  assert.deepEqual(Array.from(resolvedFrame.subarray(12)), [0x10, 0x20, 0x30]);
  assert.equal(client.pending.size, 0);
  assert.equal(client.buffer.length, 0);
});

test("ViceClient rejects error and mismatched responses", () => {
  const client = new ViceClient();
  let errorResponse = null;
  let mismatchResponse = null;

  client.pending.set(1, {
    cmd: 0x40,
    resolve: () => assert.fail("error response should not resolve"),
    reject: (error) => {
      errorResponse = error;
    },
  });

  client.onData(buildResponse(1, 0x40, Buffer.alloc(0), 0x12));
  assert.match(errorResponse?.message ?? "", /BM error 0x12/);
  assert.equal(client.pending.size, 0);

  client.pending.set(2, {
    cmd: 0x41,
    resolve: () => assert.fail("mismatched response should not resolve"),
    reject: (error) => {
      mismatchResponse = error;
    },
  });

  client.onData(buildResponse(2, 0x42));
  assert.match(mismatchResponse?.message ?? "", /expected 0x41 got 0x42/);
  assert.equal(client.pending.size, 0);
  assert.doesNotThrow(() => {
    client.onData(buildResponse(99, 0x50));
  });
});

test("ViceClient rejects pending requests on socket errors and close is defensive", async (t) => {
  const server = net.createServer((socket) => {
    socket.on("data", () => {});
  });

  t.after(async () => {
    await closeServer(server);
  });

  const port = await listen(server);
  const client = new ViceClient();
  t.after(() => {
    client.close();
  });

  await client.connect(port);
  const pending = client.info();
  client.socket.emit("error", new Error("socket boom"));

  await assert.rejects(pending, /socket boom/);
  assert.equal(client.pending.size, 0);

  let closeError = null;
  client.pending.set(99, {
    cmd: 0x85,
    resolve: () => assert.fail("close should reject pending requests"),
    reject: (error) => {
      closeError = error;
    },
  });
  client.buffer = Buffer.from([0x01, 0x02]);
  client.close();
  assert.match(closeError?.message ?? "", /connection closed/i);
  assert.equal(client.pending.size, 0);
  assert.equal(client.buffer.length, 0);

  const closingClient = new ViceClient();
  closingClient.socket = {
    destroy() {
      throw new Error("destroy failed");
    },
  };

  assert.doesNotThrow(() => {
    closingClient.close();
  });
});

test("ViceClient skips the reserved 0xFFFFFFFF reqId on wraparound instead of colliding with unsolicited events", async (t) => {
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 11) {
        const bodyLen = buffer.readUInt32LE(2);
        const total = 11 + bodyLen;
        if (buffer.length < total) return;
        const packet = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        const request = parseRequest(packet);
        requests.push(request);
        socket.write(buildResponse(request.reqId, request.cmd));
      }
    });
  });

  t.after(async () => {
    await closeServer(server);
  });

  const port = await listen(server);
  const client = new ViceClient();
  t.after(() => {
    client.close();
  });

  await client.connect(port);
  client.nextReqId = 0xffffffff;

  await client.resetSoft();
  await client.resetHard();

  assert.equal(requests.length, 2);
  // The first request must not be issued with the reserved unsolicited-event
  // marker; it wraps to 0 instead, and the following request picks up at 1.
  assert.equal(requests[0].reqId, 0x00000000);
  assert.equal(requests[1].reqId, 0x00000001);
});

async function startRawViceServer(t, respond) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 11) {
        const bodyLen = buffer.readUInt32LE(2);
        const total = 11 + bodyLen;
        if (buffer.length < total) return;
        const request = parseRequest(buffer.subarray(0, total));
        buffer = buffer.subarray(total);
        socket.write(buildResponse(request.reqId, request.cmd, respond(request)));
      }
    });
  });
  t.after(async () => { await closeServer(server); });
  const port = await listen(server);
  const client = new ViceClient();
  t.after(() => client.close());
  await client.connect(port);
  return client;
}

test("memGet returns all 65536 bytes for a full $0000-$FFFF read whose 16-bit ML field wraps to 0", async (t) => {
  const memory = Buffer.alloc(0x10000);
  for (let i = 0; i < memory.length; i += 1) memory[i] = (i * 7) & 0xff;
  const client = await startRawViceServer(t, (request) => {
    const start = request.body.readUInt16LE(1);
    const end = request.body.readUInt16LE(3);
    const length = end - start + 1;
    const body = Buffer.alloc(2 + length);
    // VICE writes the uint32 length with write_uint16, so 65536 is sent as 0.
    body.writeUInt16LE(length & 0xffff, 0);
    memory.copy(body, 2, start, end + 1);
    return body;
  });

  const full = await client.memGet(0x0000, 0xffff);
  assert.equal(full.length, 0x10000);
  assert.ok(full.equals(memory));

  const partial = await client.memGet(0x1000, 0x1003);
  assert.deepEqual(Array.from(partial), Array.from(memory.subarray(0x1000, 0x1004)));
});

test("memGet reads the full 64 KB address space from the VICE mock server", async (t) => {
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.stop(); });
  const client = new ViceClient();
  t.after(() => client.close());
  await client.connect(server.port);

  await client.memSet(0xfffe, Buffer.from([0x12, 0x34]));
  const full = await client.memGet(0x0000, 0xffff);
  assert.equal(full.length, 0x10000);
  assert.equal(full[0xfffe], 0x12);
  assert.equal(full[0xffff], 0x34);
});

function encodeRealViceDisplay(width, height, pixels) {
  // Layout produced by monitor_binary_process_display_get in VICE 3.9/3.10:
  // FL (=13) counts only the DW..BP fields, BL follows them, and the response
  // body is sized as 4 + FL + BL, so the last 4 pixel bytes are never sent.
  const body = Buffer.alloc(4 + 13 + 4 + pixels.length);
  body.writeUInt32LE(13, 0);
  body.writeUInt16LE(width, 4);
  body.writeUInt16LE(height, 6);
  body.writeUInt16LE(1, 8);
  body.writeUInt16LE(1, 10);
  body.writeUInt16LE(width - 2, 12);
  body.writeUInt16LE(height - 2, 14);
  body[16] = 8;
  body.writeUInt32LE(pixels.length, 17);
  pixels.copy(body, 21);
  return body.subarray(0, 4 + 13 + pixels.length);
}

test("displayGet reads pixels after the BL field and tolerates the 4-byte short VICE display response", async (t) => {
  const width = 8;
  const height = 6;
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = 0x10 + i;
  const client = await startRawViceServer(t, () => encodeRealViceDisplay(width, height, pixels));

  const display = await client.displayGet();
  assert.equal(display.debugWidth, width);
  assert.equal(display.debugHeight, height);
  assert.equal(display.innerWidth, width - 2);
  assert.equal(display.bitsPerPixel, 8);
  // The buffer keeps the declared BL length so callers can still index rows;
  // only the 4 bytes VICE never sends are zero-filled.
  assert.equal(display.pixels.length, pixels.length);
  assert.deepEqual(
    Array.from(display.pixels.subarray(0, pixels.length - 4)),
    Array.from(pixels.subarray(0, pixels.length - 4)),
  );
  assert.deepEqual(Array.from(display.pixels.subarray(pixels.length - 4)), [0, 0, 0, 0]);
});

test("displayGet rejects a display response missing more than the 4 bytes VICE omits", async (t) => {
  const pixels = Buffer.alloc(48, 0x05);
  const client = await startRawViceServer(t, () => encodeRealViceDisplay(8, 6, pixels).subarray(0, 4 + 13 + 40));
  await assert.rejects(() => client.displayGet(), /truncated/);
});

test("displayGet decodes the VICE mock server display with the real VICE layout", async (t) => {
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.stop(); });
  const client = new ViceClient();
  t.after(() => client.close());
  await client.connect(server.port);

  const display = await client.displayGet();
  assert.equal(display.pixels.length, 64);
  // The mock fills pixel i with i & 0x0f; the first byte must be pixel 0, not
  // the low byte of the BL field.
  assert.deepEqual(
    Array.from(display.pixels.subarray(0, 60)),
    Array.from({ length: 60 }, (_, i) => i & 0x0f),
  );
});

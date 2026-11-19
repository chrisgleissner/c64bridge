import test from "#test/runner";
import assert from "#test/assert";
import net from "node:net";
import { ViceClient } from "../src/vice/viceClient.js";

// HARD05-006: VICE monitor frames are bounded and reassembled from chunks.

function frame(type, reqId, body, length = body.length) {
  const header = Buffer.alloc(12);
  header[0] = 2;
  header[1] = 2;
  header.writeUInt32LE(length, 2);
  header[6] = type;
  header.writeUInt32LE(reqId, 8);
  return Buffer.concat([header, body]);
}

async function withVice(onRequest, fn) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (request) => onRequest(socket, request.readUInt32LE(6)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ViceClient();
  try {
    await client.connect(server.address().port);
    return await fn(client);
  } finally {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a frame length above the cap ends the session with a limit error", async () => {
  let closed = false;
  await withVice((socket, reqId) => {
    socket.on("close", () => { closed = true; });
    socket.write(frame(0x01, reqId, Buffer.alloc(0), 0xfffffff0));
  }, async (client) => {
    await assert.rejects(client.memGet(0x0400, 0x040f), /exceeds the \d+ byte limit/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, true, "the connection is closed");
  });
});

test("a frame is reassembled from many small chunks, after an unsolicited frame", async () => {
  const data = Buffer.from(Array.from({ length: 4096 }, (_, index) => index & 0xff));
  const body = Buffer.concat([Buffer.from([data.length & 0xff, data.length >> 8]), data]);
  const wire = frame(0x62, 0xffffffff, Buffer.alloc(8));
  await withVice((socket, reqId) => {
    const payload = Buffer.concat([wire, frame(0x01, reqId, body)]);
    let offset = 0;
    const sizes = [1, 5, 13, 7, 100, 3];
    let step = 0;
    const pump = () => {
      if (offset >= payload.length) return;
      const size = sizes[step++ % sizes.length];
      socket.write(payload.subarray(offset, offset + size));
      offset += size;
      setImmediate(pump);
    };
    pump();
  }, async (client) => {
    const bytes = await client.memGet(0x1000, 0x1fff);
    assert.equal(bytes.length, 4096);
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(bytes[4095], 0xff);
  });
});

test("a 64 KiB body in 1 KiB chunks completes quickly", async () => {
  const data = Buffer.alloc(0x10000, 0x5a);
  const body = Buffer.concat([Buffer.from([0, 0]), data]);
  await withVice((socket, reqId) => {
    const payload = frame(0x01, reqId, body);
    for (let offset = 0; offset < payload.length; offset += 1024) socket.write(payload.subarray(offset, offset + 1024));
  }, async (client) => {
    const started = Date.now();
    const bytes = await client.memGet(0x0000, 0xffff);
    assert.equal(bytes.length, 0x10000);
    assert.ok(Date.now() - started < 2_000);
  });
});

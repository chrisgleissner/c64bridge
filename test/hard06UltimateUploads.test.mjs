import test from "#test/runner";
import assert from "#test/assert";
import http from "node:http";
import { createFacade } from "../src/device.ts";

// DEVICE-6 (preparation): upload a host cartridge image and a host disk image to an Ultimate.

async function withDevice(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, type: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/drives") res.end('{"drives":[{"a":{"enabled":true,"bus_id":8}},{"b":{"enabled":true,"bus_id":9}}],"errors":[]}');
      else if (req.url.startsWith("/v1/drives/b:mount")) res.end('{"errors":["Drive is in the wrong mode"]}');
      else res.end('{"errors":[]}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { facade } = await createFacade(undefined, { preferredC64uBaseUrl: `http://127.0.0.1:${server.address().port}` });
    await fn(facade, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function filePart(request) {
  const boundary = /boundary=([^;]+)/.exec(request.type)?.[1];
  assert.ok(boundary, `multipart body expected, got ${request.type}`);
  const text = request.body.toString("latin1");
  const name = /filename="([^"]+)"/.exec(text)?.[1];
  const start = text.indexOf("\r\n\r\n") + 4;
  const end = text.indexOf(`\r\n--${boundary}`, start);
  return { name, bytes: Buffer.from(text.slice(start, end), "latin1") };
}

test("runCrt uploads the cartridge as upload.crt to POST /v1/runners:run_crt", async () => {
  await withDevice(async (facade, seen) => {
    const crt = Buffer.concat([Buffer.from("C64 CARTRIDGE   ", "latin1"), Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x2d])]);
    const result = await facade.runCrt(crt);
    assert.equal(result.success, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/v1/runners:run_crt");
    const part = filePart(seen[0]);
    assert.equal(part.name, "upload.crt");
    assert.deepEqual([...part.bytes], [...crt]);
    await assert.rejects(facade.runCrt(new Uint8Array(0)), /empty/);
  });
});

test("driveMountImage uploads the image to POST /v1/drives/<id>:mount with its type", async () => {
  await withDevice(async (facade, seen) => {
    const image = Buffer.alloc(174848, 0x01);
    image[0] = 0x00;
    image[image.length - 1] = 0xfe;
    const result = await facade.driveMountImage("drive8", image, { type: "d64", mode: "readonly" });
    assert.equal(result.success, true);
    const upload = seen.find((request) => request.method === "POST");
    assert.equal(upload.url, "/v1/drives/a:mount?type=d64&mode=readonly");
    const part = filePart(upload);
    assert.equal(part.name, "upload.d64");
    assert.equal(part.bytes.length, image.length);
    assert.equal(part.bytes.equals(image), true);
  });
});

test("driveMountImage reports firmware errors and rejects bad input before any request", async () => {
  await withDevice(async (facade, seen) => {
    const failed = await facade.driveMountImage("b", Buffer.alloc(16), { type: "d81" });
    assert.equal(failed.success, false);
    assert.deepEqual(failed.details.errors, ["Drive is in the wrong mode"]);
    const before = seen.length;
    await assert.rejects(facade.driveMountImage("a", Buffer.alloc(16), { type: "tap" }), /Unknown disk image type/);
    await assert.rejects(facade.driveMountImage("a", new Uint8Array(0), { type: "d64" }), /empty/);
    assert.equal(seen.length, before);
  });
});

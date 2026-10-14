import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAllFacades, createFacade, ViceBackend } from "../src/device.js";
import { loadConfig } from "../src/config.js";

// These tests check what the C64U/U2 REST backend puts on the wire against the
// rules the Ultimate firmware applies (software/api/*.cc in 1541ultimate):
// - multipart uploads are taken as files in part order; the part body is the file;
// - /v1/drives/{drive} accepts only a, b and softiec (DriveToSubsys, case-insensitive);
// - the request path is split on "/" before percent-decoding.

const FIRMWARE_DRIVE_IDS = new Set(["a", "b", "softiec"]);

// Byte-exact multipart/form-data parser. Bun's Response.formData() truncates
// binary file parts at the first zero byte, so it cannot check SID bytes.
function parseMultipart(request) {
  const boundary = /boundary=([^;]+)/.exec(String(request.headers["content-type"]))?.[1];
  assert.ok(boundary, "multipart boundary missing");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = request.body.indexOf(delimiter);
  while (start >= 0) {
    const next = request.body.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;
    const chunk = request.body.subarray(start + delimiter.length + 2, next - 2); // skip CRLF after the delimiter and before the next
    const headerEnd = chunk.indexOf("\r\n\r\n");
    const headers = chunk.subarray(0, headerEnd).toString("latin1");
    parts.push({
      name: /name="([^"]*)"/.exec(headers)?.[1],
      filename: /filename="([^"]*)"/.exec(headers)?.[1],
      body: chunk.subarray(headerEnd + 4),
    });
    start = next;
  }
  return parts;
}

async function startFirmwareWireServer({ drivesListing } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const pathname = req.url.split("?")[0];
    if (req.method === "GET" && pathname === "/v1/drives") {
      if (drivesListing === "fail") return send(500, { errors: ["listing unavailable"] });
      return send(200, { drives: drivesListing ?? [], errors: [] });
    }
    const drive = /^\/v1\/drives\/([^:/]+):/.exec(pathname);
    if (drive) {
      const id = decodeURIComponent(drive[1]);
      return FIRMWARE_DRIVE_IDS.has(id.toLowerCase())
        ? send(200, { errors: [] })
        : send(400, { errors: [`Invalid Drive '${id}'`] });
    }
    if (pathname.startsWith("/v1/configs/")) {
      const segments = pathname.split("/").slice(3).map((segment) => decodeURIComponent(segment));
      if (segments.length > 2) return send(404, { errors: ["Not found"] });
      return send(200, { segments, errors: [] });
    }
    return send(200, { errors: [] });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ENV_KEYS = ["C64BRIDGE_CONFIG", "C64_MODE", "HOME", "C64U_HOST", "C64U_PORT", "C64U_PASSWORD", "U2_HOST", "U2_PORT", "U2_PASSWORD"];

/** Run fn with only `config` visible to loadConfig() and no endpoint env overrides. */
async function withOnlyConfig(config, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c64u-wire-"));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousCwd = process.cwd();
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.C64BRIDGE_CONFIG = configPath;
    process.env.HOME = root;
    process.chdir(root);
    return await fn();
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function facadeFor(server, extra = {}) {
  return await withOnlyConfig({ c64u: { baseUrl: server.baseUrl, ...extra } }, async () => (await createFacade()).facade);
}

test("sidplayAttachment sends the SID and song-length bytes as multipart file parts in firmware order", async (t) => {
  const server = await startFirmwareWireServer();
  t.after(() => server.close());
  const facade = await facadeFor(server);

  const sid = Buffer.from([0x50, 0x53, 0x49, 0x44, 0x00, 0x02, 0xff]);
  const songlengths = Buffer.from("; tune.sid\nabc=0:42\n", "latin1");
  const result = await facade.sidplayAttachment(sid, { songnr: 2, songlengths });
  assert.equal(result.success, true);

  const request = server.requests.find((entry) => entry.url.startsWith("/v1/runners:sidplay"));
  assert.ok(request, "sidplay upload must reach the device");
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url, "http://x").searchParams.get("songnr"), "2");
  assert.match(String(request.headers["content-type"]), /^multipart\/form-data; boundary=/);
  assert.equal(request.body.includes(Buffer.from("\"type\":\"Buffer\"")), false, "Buffer must not be JSON-serialised");

  // OpenAPI SidUpload: repeated `file` part, SID first, optional song lengths second.
  const parts = parseMultipart(request).filter((part) => part.name === "file");
  assert.equal(parts.length, 2);
  assert.ok(parts[0].filename, "SID must be a file part, not a text field");
  assert.deepEqual(Array.from(parts[0].body), Array.from(sid));
  assert.deepEqual(Array.from(parts[1].body), Array.from(songlengths));
  // The firmware names its temp file after the upload and derives MUS/STR handling from the extension.
  assert.match(parts[0].filename, /\.sid$/i);
  assert.match(parts[1].filename, /\.ssl$/i);

  await facade.sidplayAttachment(Uint8Array.from(sid));
  const single = server.requests.filter((entry) => entry.url.startsWith("/v1/runners:sidplay")).at(-1);
  assert.equal(parseMultipart(single).filter((part) => part.name === "file").length, 1);
  assert.equal(new URL(single.url, "http://x").searchParams.has("songnr"), false);
});

test("C64U drive operations map bus-number drive IDs to the firmware drive letters", async (t) => {
  // Drive letters are not bus numbers: here drive a sits on bus 10 and b on bus 8.
  const server = await startFirmwareWireServer({
    // Shape as reported by Ultimate 64 Elite firmware 3.15.
    drivesListing: [
      { a: { enabled: true, bus_id: 10, type: "1541", rom: "1541.rom", image_file: "demo.d64", image_path: "/Usb0/games" } },
      { b: { enabled: false, bus_id: 8, type: "1581", rom: "1581.rom", image_file: "", image_path: "" } },
      { "IEC Drive": { bus_id: 11, enabled: true, type: "DOS emulation", partitions: [{ id: 1, path: "/Temp/" }] } },
      { "Printer Emulation": { bus_id: 4, enabled: false } },
    ],
  });
  t.after(() => server.close());
  const facade = await facadeFor(server);
  const driveUrls = () => server.requests.filter((entry) => entry.url.startsWith("/v1/drives/")).map((entry) => entry.url.split("?")[0]);

  assert.equal((await facade.driveMount("drive8", "/Usb0/demo.d64")).success, true);
  assert.equal((await facade.driveOn("10")).success, true);
  assert.equal((await facade.driveReset("softiec")).success, true);
  assert.equal((await facade.driveOff("A")).success, true);
  assert.equal((await facade.driveRemove("b")).success, true);
  assert.equal((await facade.driveSetMode("softiec", "1541")).success, true);
  // The listing reports the soft IEC drive as "IEC Drive"; that id must be usable as input too.
  assert.equal((await facade.driveLoadRom("IEC Drive", "/roms/x.rom")).success, true);
  assert.deepEqual(driveUrls(), [
    "/v1/drives/b:mount",
    "/v1/drives/a:on",
    "/v1/drives/softiec:reset",
    "/v1/drives/a:off",
    "/v1/drives/b:remove",
    "/v1/drives/softiec:set_mode",
    "/v1/drives/softiec:load_rom",
  ]);

  // Every id that drivesList reports for a drive is accepted by the drive endpoints.
  const listed = await facade.drivesList();
  assert.equal(listed.find((drive) => drive.id === "a").image, "/Usb0/games/demo.d64");
  for (const entry of listed.filter((drive) => drive.id !== "Printer Emulation")) {
    assert.equal((await facade.driveReset(entry.id)).success, true, `listed id ${entry.id} must be usable`);
  }

  // Only drives a and b are matched by bus number; the IEC drive (bus 11) and
  // printer (bus 4) entries are not drive-route targets for driveN ids.
  const before = driveUrls().length;
  await assert.rejects(() => facade.driveOn("drive9"), /drive9/);
  await assert.rejects(() => facade.driveOn("drive11"), /drive11/);
  await assert.rejects(() => facade.driveOn("4"), /'4'/);
  assert.equal(driveUrls().length, before, "an unknown bus number must not be sent to the firmware");
});

test("C64U drive bus numbers fall back to a=8 and b=9 when the drive listing is unavailable", async (t) => {
  const server = await startFirmwareWireServer({ drivesListing: "fail" });
  t.after(() => server.close());
  const facade = await facadeFor(server);

  assert.equal((await facade.driveOn("drive8")).success, true);
  assert.equal((await facade.driveOff("9")).success, true);
  assert.deepEqual(
    server.requests.filter((entry) => entry.url.startsWith("/v1/drives/")).map((entry) => entry.url.split("?")[0]),
    ["/v1/drives/a:on", "/v1/drives/b:off"],
  );
});

test("VICE drive operations accept the C64U drive letters a and b", async () => {
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  const resourceSets = [];
  backend.withClient = async (fn) => fn({ async resourceSet(name, value) { resourceSets.push([name, value]); } });

  await backend.driveOn("a");
  await backend.driveOff("B");
  await backend.driveOn("drive10");
  assert.deepEqual(resourceSets, [["Drive8CPUEnabled", 1], ["Drive9CPUEnabled", 0], ["Drive10CPUEnabled", 1]]);
  await assert.rejects(() => backend.driveOn("c"), /Invalid drive specification/);
  await assert.rejects(() => backend.driveOn("constructor"), /Invalid drive specification/);
});

test("config category and item names containing '/' reach the firmware as single path segments", async (t) => {
  const server = await startFirmwareWireServer();
  t.after(() => server.close());
  const facade = await facadeFor(server);

  const item = await facade.configGet("C64 and Cartridge Settings", "Bus Sharing - I/O1");
  assert.deepEqual(item.segments, ["C64 and Cartridge Settings", "Bus Sharing - I/O1"]);
  assert.equal((await facade.configSet("C64 and Cartridge Settings", "Bus Sharing - I/O2", "Internal")).success, true);
  const category = await facade.configGet("Odd/Category 100%");
  assert.deepEqual(category.segments, ["Odd/Category 100%"]);

  const configUrls = server.requests.filter((entry) => entry.url.startsWith("/v1/configs/")).map((entry) => entry.url.split("?")[0]);
  assert.deepEqual(configUrls, [
    "/v1/configs/C64%20and%20Cartridge%20Settings/Bus%20Sharing%20-%20I%2FO1",
    "/v1/configs/C64%20and%20Cartridge%20Settings/Bus%20Sharing%20-%20I%2FO2",
    "/v1/configs/Odd%2FCategory%20100%25",
  ]);
});

test("legacy top-level baseUrl and networkPassword configure the C64U backend", async (t) => {
  const server = await startFirmwareWireServer();
  t.after(() => server.close());

  await withOnlyConfig({ baseUrl: server.baseUrl, networkPassword: "legacy-secret" }, async () => {
    const { facade, selected, reason } = await createFacade();
    assert.equal(selected, "c64u");
    // Configured, not discovered by the unconfigured-fallback reachability probe.
    assert.equal(reason, "config only");
    assert.equal(facade.getBaseUrl(), server.baseUrl);
    await facade.info();
    const last = server.requests.at(-1);
    assert.equal(last.url, "/v1/info");
    assert.equal(last.headers["x-password"], "legacy-secret");

    // The MCP server constructs its client from loadConfig() and createAllFacades().
    const config = loadConfig();
    const all = await createAllFacades(undefined, {
      preferredC64uBaseUrl: config.baseUrl,
      preferredC64uNetworkPassword: config.networkPassword,
    });
    assert.equal(all.primary.selected, "c64u");
    assert.equal(all.primary.facade.getBaseUrl(), server.baseUrl);
  });

  // A top-level password also applies to a c64u section that has none.
  await withOnlyConfig({ c64u: { baseUrl: server.baseUrl }, networkPassword: "shared-secret" }, async () => {
    const { facade } = await createFacade();
    await facade.version();
    assert.equal(server.requests.at(-1).headers["x-password"], "shared-secret");
  });
});

test("the C64U backend endpoint is the endpoint loadConfig resolves", async () => {
  // loadConfig documents that host/port beat baseUrl; the backend must not decide differently.
  const config = { c64u: { host: "127.0.0.1:1111", baseUrl: "http://127.0.0.1:2222" } };
  await withOnlyConfig(config, async () => {
    const { facade } = await createFacade();
    assert.equal(loadConfig().baseUrl, "http://127.0.0.1:1111");
    assert.equal(facade.getBaseUrl(), loadConfig().baseUrl);
  });

  await withOnlyConfig({ c64_host: "127.0.0.1", c64_port: 3333 }, async () => {
    const { facade, selected } = await createFacade();
    assert.equal(selected, "c64u");
    assert.equal(facade.getBaseUrl(), "http://127.0.0.1:3333");
    assert.equal(facade.getBaseUrl(), loadConfig().baseUrl);
  });
});

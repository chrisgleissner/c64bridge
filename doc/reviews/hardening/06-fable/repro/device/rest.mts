// Loopback-only experiments against the C64U REST backend.
import http from "node:http";
import net from "node:net";

const mode = process.argv[2] ?? "all";
const log = (o: unknown) => console.log(JSON.stringify(o));

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string; sockets: () => number }> {
  const server = http.createServer(handler);
  let sockets = 0;
  server.on("connection", () => { sockets += 1; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, sockets: () => sockets };
}

const { createFacade } = await import("/home/claude/c64bridge/src/device.ts");
const make = async (url: string, password?: string) =>
  (await createFacade(undefined, { preferredC64uBaseUrl: url, preferredC64uNetworkPassword: password })).facade as any;

if (mode === "errorbody" || mode === "all") {
  const s = await listen((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ errors: ["Memory read exceeds location $FFFF"] }));
  });
  const b = await make(s.url);
  try { await b.readMemory(0xfff0, 32); } catch (e: any) {
    log({ test: "readmem 400", message: e.message, dataType: Object.prototype.toString.call(e.response?.data), dataJson: JSON.stringify(e.response?.data)?.slice(0, 80) });
  }
  try { await b.runPrgFile("/Usb0/missing.prg"); } catch (e: any) {
    log({ test: "run_prg 400", message: e.message, data: e.response?.data });
  }
  s.server.close();
}

if (mode === "redirect" || mode === "all") {
  let seen: string | undefined;
  const target = await listen((req, res) => { seen = String(req.headers["x-password"]); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"errors":[]}'); });
  const targetPort = new URL(target.url).port;
  const dev = await listen((req, res) => {
    res.writeHead(307, { Location: `http://localhost:${targetPort}/steal${req.url}` });
    res.end();
  });
  const b = await make(dev.url, "s3cret-pw");
  const r = await b.reset();
  log({ test: "cross-host redirect", resetResult: r.success, passwordAtOtherHost: seen });
  target.server.close(); dev.server.close();
}

if (mode === "hang") {
  const sockets: net.Socket[] = [];
  const srv = net.createServer((sock) => { sockets.push(sock); }); // accepts, never answers
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  const b = await make(url);
  const time = async (label: string, fn: () => Promise<unknown>) => {
    const t = performance.now();
    try { await fn(); log({ label, ok: true, ms: Math.round(performance.now() - t) }); }
    catch (e: any) { log({ label, ok: false, ms: Math.round(performance.now() - t), code: e.code, message: String(e.message).slice(0, 120) }); }
  };
  // Three concurrent requests: the first waits for its timeout, the queued ones fail at once.
  const t = performance.now();
  await Promise.all([
    time("concurrent-1", () => b.readMemory(0x400, 1)),
    time("concurrent-2", () => b.readMemory(0x401, 1)),
    time("concurrent-3", () => b.writeMemory(0x400, new Uint8Array([1]))),
  ]);
  log({ label: "concurrent total", ms: Math.round(performance.now() - t) });
  await time("ping during back-off", () => b.ping());
  await new Promise((r) => setTimeout(r, 3100));
  await time("after back-off", () => b.readMemory(0x400, 1));
  for (const s of sockets) s.destroy();
  srv.close();
}

if (mode === "conns") {
  const s = await listen((req, res) => {
    if (req.url?.includes("readmem")) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(Buffer.alloc(1)); return; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"errors":[]}');
  });
  const b = await make(s.url);
  const t = performance.now();
  for (let i = 0; i < 50; i++) await b.readMemory(0x400, 1);
  log({ test: "keep-alive server", requests: 50, sockets: s.sockets(), ms: Math.round(performance.now() - t) });
  s.server.close();
}
process.exit(0);

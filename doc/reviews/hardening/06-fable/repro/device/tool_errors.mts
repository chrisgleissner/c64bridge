// What an LLM client sees when the firmware rejects a request with an HTTP error and an `errors` array.
import http from "node:http";
import net from "node:net";
import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
import { toolRegistry } from "/home/claude/c64bridge/src/tools/registry/index.ts";

const routes: Record<string, [number, string]> = {
  "/v1/machine:readmem": [400, "Memory read exceeds location $FFFF"],
  "/v1/machine:writemem": [400, "Memory write exceeds location $FFFF"],
  "/v1/runners:run_prg": [404, "Cannot open file"],
  "/v1/drives/a:mount": [404, "Cannot open file"],
  "/v1/configs/Audio%20Mixer/Vol%20UltiSid%201": [404, "Item not found"],
};
const server = http.createServer((req, res) => {
  const p = (req.url ?? "").split("?")[0]!;
  const hit = routes[p];
  if (hit) { res.writeHead(hit[0], { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify({ errors: [hit[1]] })); return; }
  if (p === "/v1/drives") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"drives":[{"a":{"enabled":true,"bus_id":8}}],"errors":[]}'); return; }
  res.writeHead(200, { "content-type": "application/json" }); res.end('{"errors":[]}');
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const client = new C64Client(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ctx = { client, logger: quiet, rag: {}, platform: { id: "c64u", features: [], limitedFeatures: [] }, setPlatform: () => ({ id: "c64u", features: [], limitedFeatures: [] }) } as any;
const calls: Array<[string, unknown]> = [
  ["c64_memory", { op: "read", address: "$FFF0", length: 16 }],
  ["c64_memory", { op: "write", address: "$0400", bytes: "$01" }],
  ["c64_program", { op: "run_prg", path: "/Usb0/game.prg" }],
  ["c64_disk", { op: "mount", drive: "drive8", image: "/Usb0/disk.d64" }],
  ["c64_config", { op: "get", category: "Audio Mixer", item: "Vol UltiSid 1" }],
];
for (const [tool, args] of calls) {
  try {
    const r: any = await toolRegistry.invoke(tool, args, ctx);
    const text = (r.content ?? []).map((c: any) => c.text).join(" ").replace(/\s+/g, " ");
    console.log(JSON.stringify({ tool, op: (args as any).op, isError: r.isError ?? false, text: text.slice(0, 260) })); console.log("FULL", JSON.stringify(r).slice(0, 600));
  } catch (e: any) {
    console.log(JSON.stringify({ tool, op: (args as any).op, threw: e.message }));
  }
}
server.close();
process.exit(0);

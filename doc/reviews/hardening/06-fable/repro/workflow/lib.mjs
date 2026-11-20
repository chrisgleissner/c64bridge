import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "/home/claude/c64bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "/home/claude/c64bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { startMockC64Server } from "/home/claude/c64bridge/scripts/mockC64Server.mjs";
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";

export async function start({ vice = true, mode, extraEnv = {} } = {}) {
  const mock = await startMockC64Server();
  const vm = vice ? await startViceMockServer({ host: "127.0.0.1" }) : null;
  const u = new URL(mock.baseUrl);
  const cfg = { c64u: { host: u.hostname, port: Number(u.port) } };
  if (vm) cfg.vice = { host: "127.0.0.1", port: vm.port };
  const cfgPath = path.join("/tmp/h6/workflow", `cfg-${process.pid}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const env = { ...process.env, C64BRIDGE_CONFIG: cfgPath, VICE_TEST_TARGET: "mock", ...extraEnv };
  delete env.NODE_ENV; delete env.C64_TEST_TARGET;
  if (mode) env.C64_MODE = mode;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx/esm", "src/mcp-server.ts"], cwd: "/home/claude/c64bridge", env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (c) => { stderr += c; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
  const client = new Client({ name: "workflow-review", version: "0" }, { capabilities: {} });
  const t0 = Date.now();
  await client.connect(transport);
  const initMs = Date.now() - t0;
  const log = [];
  async function call(name, args, { show = 1200, label } = {}) {
    const s = performance.now();
    let res, err;
    try { res = await client.callTool({ name, arguments: args }); } catch (e) { err = e; }
    const ms = Math.round(performance.now() - s);
    const text = err ? `THROW ${err.message}` : JSON.stringify(res);
    const entry = { label: label ?? name, args, ms, bytes: text.length, isError: res?.isError };
    log.push(entry);
    console.log(`\n### ${label ?? name} ${JSON.stringify(args).slice(0, 300)}\n-> ${ms}ms ${text.length}B isError=${res?.isError ?? !!err}`);
    if (err) console.log(text);
    else for (const c of res.content ?? []) {
      if (c.type === "text") console.log(c.text.length > show ? c.text.slice(0, show) + `...[+${c.text.length - show}]` : c.text);
      else console.log(`[${c.type} ${c.mimeType ?? ""} ${(c.data ?? "").length}B]`);
    }
    if (res?.structuredContent) console.log("structuredContent:", JSON.stringify(res.structuredContent).slice(0, 400));
    return res;
  }
  async function read(uri, show = 600) {
    const s = performance.now();
    const r = await client.readResource({ uri });
    const ms = Math.round(performance.now() - s);
    const t = r.contents.map((c) => c.text ?? "").join("");
    console.log(`\n### read ${uri} -> ${ms}ms ${t.length}B\n${t.slice(0, show)}`);
    return t;
  }
  async function stop() {
    await client.close().catch(() => {});
    await mock.stop?.().catch?.(() => {}); await mock.close?.();
    await vm?.stop?.(); await vm?.close?.();
  }
  return { client, call, read, stop, mock, vm, initMs, log, get stderr() { return stderr; } };
}

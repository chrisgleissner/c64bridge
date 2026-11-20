// Which host and password each Ultimate profile resolves to.
import fs from "node:fs";
const file = "/tmp/h6/device/cfg.json";
const show = async (label: string, doc: unknown, env: Record<string, string>) => {
  fs.writeFileSync(file, JSON.stringify(doc));
  process.env.C64BRIDGE_CONFIG = file;
  for (const k of ["C64U_HOST", "C64U_PORT", "C64U_PASSWORD", "U2_HOST", "U2_PORT", "U2_PASSWORD", "C64_MODE"]) delete process.env[k];
  Object.assign(process.env, env);
  const { loadConfig } = await import("/home/claude/c64bridge/src/config.ts");
  const c = loadConfig();
  console.log(JSON.stringify({ label, c64u: { url: c.ultimate.c64u.baseUrl, pw: c.ultimate.c64u.networkPassword }, u2: { url: c.ultimate.u2.baseUrl, pw: c.ultimate.u2.networkPassword } }));
};
await show("c64u section + U2_HOST env", { c64u: { host: "c64u.lan", networkPassword: "pw-for-c64u" } }, { U2_HOST: "u2.lan" });
await show("c64u section, C64_MODE=u2, no u2 settings", { c64u: { host: "c64u.lan", networkPassword: "pw-for-c64u" } }, { C64_MODE: "u2" });

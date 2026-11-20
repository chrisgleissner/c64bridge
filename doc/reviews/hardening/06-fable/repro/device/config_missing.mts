process.chdir("/tmp/h6/device/cwdtest");
process.env.C64BRIDGE_CONFIG = "/tmp/h6/device/does-not-exist.json";
const { loadConfig } = await import("/home/claude/c64bridge/src/config.ts");
try { const c = loadConfig(); console.log(JSON.stringify({ explicit: process.env.C64BRIDGE_CONFIG, usedBaseUrl: c.baseUrl, password: c.networkPassword })); }
catch (e: any) { console.log("threw:", e.message); }

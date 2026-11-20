const { waitForScreenText } = await import("/home/claude/c64bridge/src/tools/meta/screen.ts");
const screen = ["    **** COMMODORE 64 BASIC V2 ****", "", " 64K RAM SYSTEM  38911 BASIC BYTES FREE", "", "READY.", "RUN", "", "HELLO", "", "READY."].join("\n");
const c: any = { readScreen: async () => screen };
for (const p of ["^READY\\.$", "^HELLO$", "^RUN$", "READY\\.$", "^\\s*HELLO"]) {
  const r = await waitForScreenText(c, { pattern: p, isRegex: true, timeoutMs: 200, intervalMs: 20 });
  console.log(JSON.stringify(p), "matched:", r.matched);
}

import fs from "node:fs/promises";
import path from "node:path";
import { tools, stopAllBackgroundTasks } from "../../src/tools/meta/background.ts";
const ctx = { client: { readMemory: async () => ({ success: true, data: "$00" }) } };
const directory = process.argv[2];
for (let index = 0;; index++) {
  const input = path.join(directory, `input-${index}.json`);
  let command;
  for (;;) {
    try { command = JSON.parse(await fs.readFile(input, "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  const { tool, args } = command;
  if (tool === "exit") { await stopAllBackgroundTasks(); process.exit(0); }
  const result = await tools.find((entry) => entry.name === tool).execute(args ?? {}, ctx);
  await fs.writeFile(path.join(directory, `output-${index}.json`), JSON.stringify(result));
}

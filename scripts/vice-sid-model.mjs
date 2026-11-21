import { spawnSync } from "node:child_process";

/** Select a VICE SID model option from its own help and verify its 8580 mapping. */
export function vice8580ModelArgs(help) {
  const engine = help.match(/-sidenginemodel\s+<[^>]+>[\s\S]{0,240}?\b257:\s*ReSID\s+8580\b/i);
  if (engine) return ["-sidenginemodel", "257"];
  const model = help.match(/-sidmodel\s+<[^>]+>[\s\S]{0,180}?\b1:\s*8580\b/i);
  if (model) return ["-sidmodel", "1"];
  throw new Error("VICE help does not expose a recognized 8580 SID model option");
}

export function resolveVice8580ModelArgs(vice, headless) {
  const executable = headless ? "xvfb-run" : vice;
  const args = headless ? ["-a", vice, "-help"] : ["-help"];
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect VICE SID options: ${result.error?.message ?? (result.stderr || result.stdout).trim()}`);
  }
  return vice8580ModelArgs(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

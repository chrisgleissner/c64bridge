import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function processIsAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

type Claim = { key: string; choosing: boolean; ticket: number };

/** Filesystem bakery lock: each contender exclusively owns its own claim file.
 * Publishing "choosing" before reading tickets prevents simultaneous entrants.
 * No contender removes a live owner's file or reclaims a shared recovery mutex.
 */
export async function withTaskStateLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const directory = `${file}.lock`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  const key = `${process.pid}_${randomUUID()}.json`;
  const claimPath = join(directory, key);
  const temporary = `${claimPath}.tmp`;
  async function publish(choosing: boolean, ticket: number): Promise<void> {
    await fs.writeFile(temporary, JSON.stringify({ choosing, ticket }));
    await fs.rename(temporary, claimPath);
  }
  async function claims(): Promise<Claim[]> {
    const entries = await fs.readdir(directory);
    const result: Claim[] = [];
    for (const entry of entries) {
      const match = /^(\d+)_[a-f0-9-]+\.json$/.exec(entry);
      if (!match || entry === key) continue;
      if (!processIsAlive(Number(match[1]))) {
        // Claims are never reused, so removing a dead owner's exact path cannot
        // remove a new owner's replacement claim.
        await fs.rm(join(directory, entry), { force: true });
        continue;
      }
      try {
        const data = JSON.parse(await fs.readFile(join(directory, entry), "utf8"));
        result.push({ key: entry, choosing: data.choosing !== false, ticket: Number.isSafeInteger(data.ticket) && data.ticket > 0 ? data.ticket : 0 });
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return result;
  }
  try {
    await publish(true, 0);
    const ticket = 1 + Math.max(0, ...(await claims()).map((claim) => claim.ticket));
    await publish(false, ticket);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const contenders = await claims();
      if (!contenders.some((claim) => claim.choosing || claim.ticket < ticket || (claim.ticket === ticket && claim.key < key))) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for background task state lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return await operation();
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(claimPath, { force: true });
  }
}

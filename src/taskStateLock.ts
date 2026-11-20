import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function processIsAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

type Claim = { key: string; choosing: boolean; ticket: number };

/** A live contender refreshes its claim at this interval while it waits or holds the lock. */
const CLAIM_REFRESH_MS = 1_000;
/** A claim not refreshed for this long belongs to a dead process whose PID was reused. */
export const STALE_CLAIM_MS = 30_000;

/** Claims this process holds right now; any other claim with this PID was left by an earlier process. */
const heldKeys = new Set<string>();

/** Filesystem bakery lock: each contender exclusively owns its own claim file.
 * Publishing "choosing" before reading tickets prevents simultaneous entrants.
 * No contender removes a live owner's file or reclaims a shared recovery mutex.
 * A claim is dead when its process is gone, when it carries this process's PID
 * but this process does not hold it (a restarted server, typically in a container,
 * often gets the same PID), or when it has not been refreshed for STALE_CLAIM_MS
 * (its PID now belongs to an unrelated process). Live claims are refreshed every
 * CLAIM_REFRESH_MS, so none of these rules removes a live owner's file.
 */
export async function withTaskStateLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const directory = `${file}.lock`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  const key = `${process.pid}_${randomUUID()}.json`;
  const claimPath = join(directory, key);
  const temporary = `${claimPath}.tmp`;
  heldKeys.add(key);
  const refresh = setInterval(() => {
    const now = new Date();
    fs.utimes(claimPath, now, now).catch(() => { /* not published yet or already removed */ });
  }, CLAIM_REFRESH_MS);
  refresh.unref?.();
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
      const pid = Number(match[1]);
      let stale = !processIsAlive(pid) || (pid === process.pid && !heldKeys.has(entry));
      if (!stale) {
        try {
          stale = Date.now() - (await fs.stat(join(directory, entry))).mtimeMs > STALE_CLAIM_MS;
        } catch (error: any) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
      }
      if (stale) {
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
    clearInterval(refresh);
    await fs.rm(temporary, { force: true });
    await fs.rm(claimPath, { force: true });
    heldKeys.delete(key);
  }
}

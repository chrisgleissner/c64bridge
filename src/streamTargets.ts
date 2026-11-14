export type UserStreamKind = "video" | "audio" | "debug";

const userTargets = new Map<UserStreamKind, string>();
const lockTails = new Map<UserStreamKind, Promise<unknown>>();

/** Remembers the target of a stream the user started with c64_stream start. */
export function rememberUserStream(stream: UserStreamKind, target: string): void {
  userTargets.set(stream, target);
}

/** Forgets the remembered target once the user stopped that stream. */
export function forgetUserStream(stream: UserStreamKind): void {
  userTargets.delete(stream);
}

export function userStreamTarget(stream: UserStreamKind): string | undefined {
  return userTargets.get(stream);
}

/** Runs captures that use the same device stream one after another. */
export async function withStreamLock<T>(stream: UserStreamKind, task: () => Promise<T>): Promise<T> {
  const previous = lockTails.get(stream) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  lockTails.set(stream, tail);
  try {
    return await run;
  } finally {
    if (lockTails.get(stream) === tail) lockTails.delete(stream);
  }
}

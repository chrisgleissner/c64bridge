/**
 * Owned pause for one tool call. The facade is pinned at call start so the
 * matching resume reaches the backend that was paused, and the client's pause
 * depth counter keeps overlapping calls and an explicit `c64_system pause`
 * from undoing each other. Clients without acquirePause/releasePause (test
 * stubs) fall back to plain pause/resume.
 */
type PauseClient = {
  pinFacade?: () => Promise<unknown>;
  acquirePause?: (facade?: any) => Promise<{ success: boolean; details?: unknown }>;
  releasePause?: (facade?: any) => Promise<{ success: boolean; details?: unknown }>;
  pause: (facade?: any) => Promise<{ success: boolean; details?: unknown }>;
  resume: (facade?: any) => Promise<{ success: boolean; details?: unknown }>;
};

export interface OwnedPause {
  /** Facade pinned for the whole call; pass it to the memory reads and writes. */
  facade: any;
  result: { success: boolean; details?: unknown };
  /** Releases the pause. Never throws; a failure is returned as success:false. */
  release(): Promise<{ success: boolean; details?: unknown }>;
}

export async function acquireOwnedPause(client: unknown, enabled = true): Promise<OwnedPause> {
  const c = client as PauseClient;
  const facade = typeof c.pinFacade === "function" ? await c.pinFacade() : undefined;
  if (!enabled) return { facade, result: { success: true }, release: async () => ({ success: true }) };
  const result = typeof c.acquirePause === "function" ? await c.acquirePause(facade) : await c.pause(facade);
  return {
    facade,
    result,
    async release() {
      try {
        return typeof c.releasePause === "function" ? await c.releasePause(facade) : await c.resume(facade);
      } catch (error) {
        return { success: false, details: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}

export function resumeWarning(details: unknown): string {
  const text = details && typeof details === "object" && "message" in details ? String((details as { message: unknown }).message) : "";
  return `The machine could not be resumed after the operation${text ? ` (${text})` : ""}; call c64_system with op 'resume'.`;
}

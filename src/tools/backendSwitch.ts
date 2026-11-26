import { assertForegroundAllowed } from "../tasks/resources.js";
import type { PlatformId } from "../platform.js";
import type { ToolExecutionContext } from "./types.js";

/**
 * Lease check shared by every operation that changes the active backend. `backendId` is the
 * backend being left; the check throws `resource_conflict` when a task holds a lease there.
 */
export function backendSwitchGuard(ctx: Pick<ToolExecutionContext, "taskLease">): (backendId: PlatformId | undefined) => void {
  return (backendId) => {
    assertForegroundAllowed({ tool: "c64_select_backend", op: "select", backendId }, ctx.taskLease);
  };
}

/** Switch the backend with the same lease check that c64_select_backend applies. */
export async function switchBackendChecked(
  ctx: Pick<ToolExecutionContext, "client" | "taskLease">,
  backend: PlatformId,
): Promise<void> {
  await ctx.client.switchBackend(backend, backendSwitchGuard(ctx));
}

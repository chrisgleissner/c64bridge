import type { C64Facade } from "../device.js";
import { screenLayoutFromRegisters } from "../device.js";
import { screenCodesToAscii } from "../petscii.js";
import type { ToolExecutionContext } from "../tools/types.js";

/** Reads the text screen where the VIC-II shows it (base and character set from $D018/$DD00) through the pinned facade. */
export async function readScreenThroughFacade(ctx: ToolExecutionContext, facade: C64Facade | undefined): Promise<string> {
  if (facade?.readScreenState) {
    const state = await facade.readScreenState();
    return screenCodesToAscii(state.bytes, { columns: 40, rows: 25, charset: state.charset });
  }
  let d018: number | undefined;
  let dd00: number | undefined;
  try {
    d018 = (await ctx.client.readMemoryRaw(0xd018, 1, facade))[0];
    dd00 = (await ctx.client.readMemoryRaw(0xdd00, 1, facade))[0];
  } catch {
    // Keep the defaults ($0400, upper case) when the registers cannot be read.
  }
  const layout = screenLayoutFromRegisters(d018, dd00);
  const bytes = await ctx.client.readMemoryRaw(layout.baseAddress, Math.min(0x03e8, 0x10000 - layout.baseAddress), facade);
  return screenCodesToAscii(bytes, { columns: 40, rows: 25, charset: layout.charset });
}

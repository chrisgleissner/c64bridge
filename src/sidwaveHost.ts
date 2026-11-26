import { readFileSync } from "node:fs";
import type { SidwaveFileReader, SidwaveReadOptions } from "sidwave/pcm";
import { DEFAULT_MAX_READ_BYTES, resolveHostPath } from "./hostPaths.js";

/**
 * Reads a SIDWAVE `file:` sample source the way every other host file argument is read: the path must lie in an
 * allowed root and the file must not exceed the host read size limit.
 */
export const hostSidwaveFileReader: SidwaveFileReader = (file) => readFileSync(resolveHostPath(file, { purpose: "read" }));

/** Options for sidwave `parseSidwave` and `renderSample` calls made on behalf of a tool caller. */
export const hostSidwaveReadOptions: SidwaveReadOptions = {
  readFile: hostSidwaveFileReader,
  maxFileBytes: DEFAULT_MAX_READ_BYTES,
};

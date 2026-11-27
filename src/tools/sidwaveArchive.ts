/** `c64_sound` ops for collections: instrument libraries. */
import { basename } from "node:path";
import { parseSidFile } from "sidwave";
import { extractInstruments } from "sidwave/analyze";
import { ToolValidationError } from "./errors.js";
import { capped, engineFactory, isSid, planOutput, readInput, scoreOf, SCORE, type Args, type Definition } from "./sidwaveShared.js";

function checkSong(args: Args, songs: number) {
  if (args.song !== undefined && (args.song < 1 || args.song > songs)) {
    throw new ToolValidationError(`song must be 1..${songs} for this SID file`, { path: "$.song" });
  }
}

export const extractInstrumentsDefinition: Definition = {
  op: "extract_instruments", effect: "write", description: "Save the instruments of a score or SID as an importable library.",
  optional: [...SCORE, "from", "song", "durationSeconds", "name", "licence", "author", "outputPath", "overwrite", "includeScore"],
  run: async (args, ctx) => {
    const input = await readInput(args);
    const output = planOutput(args, `${input.stem}-instruments`, ".sidwave.yaml", [input.file]);
    // Only the given values: an undefined author would replace the one of the SID header.
    const options = Object.fromEntries(Object.entries({ name: args.name, licence: args.licence, author: args.author })
      .filter(([, value]) => value !== undefined)) as { name?: string; licence?: string; author?: string };
    let source: string | Uint8Array;
    if (isSid(input.bytes)) {
      checkSong(args, parseSidFile(input.bytes).songs);
      source = input.bytes;
    } else {
      source = (await scoreOf(input, args, ctx)).text;
    }
    let result;
    try {
      result = await extractInstruments(source, typeof source === "string" ? options : {
        ...options, engine: engineFactory(ctx)("sidlite"), song: args.song, seconds: args.durationSeconds,
      });
    } catch (error) {
      // The library reports a bad name, licence or score with a plain Error.
      if (error instanceof Error && error.constructor === Error) throw new ToolValidationError(error.message);
      throw error;
    }
    ctx.signal?.throwIfAborted();
    const artifact = await output.write(result.library, ctx);
    const shown = capped(result.instruments, 20);
    const first = result.instruments[0]?.name;
    return {
      ...artifact, libraryName: result.libraryName, count: result.instruments.length,
      instruments: shown.items.map(({ name, sourceName, usedByVoices, patternEntries }) => ({ name, sourceName, usedByVoices, patternEntries })),
      ...(shown.omitted ? { instrumentsOmitted: shown.omitted } : {}),
      external: result.external, provenance: result.provenance,
      ...(first ? { use: `In a score of the same folder: imports: [{ as: x, from: ${basename(artifact.outputPath)} }], then instrument: x.${first}` } : {}),
      ...(args.includeScore ? { sidwave: result.library } : {}),
    };
  },
};

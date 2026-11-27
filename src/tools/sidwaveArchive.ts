/** `c64_sound` ops for collections: instrument libraries, SID header and Songlengths edits. */
import { basename, extname } from "node:path";
import {
  editSidHeader, hvscDatabases, hvscPathOf, parseSidFile, parseSonglengthList, songlengthsFormatOf, songlengthsKey,
  writeSonglengthsEntry, type SidEditFields,
} from "sidwave";
import { extractInstruments } from "sidwave/analyze";
import { readHostFile, resolveHostPath } from "../hostPaths.js";
import { ToolValidationError } from "./errors.js";
import {
  capped, engineFactory, isSid, planOutput, readFileInput, readInput, required, scoreOf, SCORE, type Args, type Definition, type Input,
} from "./sidwaveShared.js";

const latin1File = async (path: string) => (await readHostFile(path)).toString("latin1");

function requireSid(input: Input) {
  if (!isSid(input.bytes)) throw new ToolValidationError(`${input.name} is not a SID file`, { path: "$.inputPath" });
  return parseSidFile(input.bytes);
}

function checkSong(args: Args, songs: number) {
  if (args.song !== undefined && (args.song < 1 || args.song > songs)) {
    throw new ToolValidationError(`song must be 1..${songs} for this SID file`, { path: "$.song" });
  }
}

/** The databases and tune path of an HVSC directory, for the values the caller did not give. */
function hvsc(args: Args, file: string) {
  if (args.hvscDir === undefined) return { songlengths: args.songlengthsPath, stil: args.stilPath, path: args.hvscPath };
  // Confinement check only: a directory is not a readable file.
  const root = resolveHostPath(args.hvscDir, { purpose: "write" });
  const databases = hvscDatabases(root);
  return {
    songlengths: args.songlengthsPath ?? databases.songlengths,
    stil: args.stilPath ?? databases.stil,
    path: args.hvscPath ?? hvscPathOf(root, file),
  };
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

export const sidEditDefinition: Definition = {
  op: "sid_edit", effect: "write",
  description: "Edit a copy by action: header (fields: name, author, released, clock, sidModel, startSong, ...) or songlength (durations \"3:05 0:41\" into a Songlengths database).",
  required: ["inputPath", "action"],
  optional: ["fields", "durations", "songlengthsPath", "hvscDir", "hvscPath", "outputPath", "overwrite"],
  run: async (args, ctx) => {
    const input = await readFileInput(args.inputPath!);
    const file = requireSid(input);
    if (args.action === "header") {
      const fields = required(args, "fields") as SidEditFields;
      const output = planOutput(args, `${input.stem}-edited`, ".sid", [input.file]);
      const result = editSidHeader(input.bytes, fields);
      return {
        action: "header", ...(await output.write(result.bytes, ctx)), changes: result.changes.map(({ field, from, to }) => ({ field, from, to })),
        warnings: result.warnings, version: result.version, md5: result.md5,
      };
    }
    if (args.action !== "songlength") {
      throw new ToolValidationError("Unknown sid_edit action", { path: "$.action", details: { allowed: ["header", "songlength"] } });
    }
    const places = hvsc(args, input.file!);
    if (places.songlengths === undefined) throw new ToolValidationError("Name the database: songlengthsPath or hvscDir", { path: "$.songlengthsPath" });
    const database = resolveHostPath(places.songlengths, { purpose: "read" });
    const durations = args.durations === undefined ? undefined : parseSonglengthList(args.durations);
    if (durations && durations.length !== file.songs) {
      throw new ToolValidationError(`The file has ${file.songs} song${file.songs === 1 ? "" : "s"}; give one duration per song`, { path: "$.durations" });
    }
    if (places.path !== undefined && [...places.path].some((character) => character.charCodeAt(0) > 255)) {
      throw new ToolValidationError("hvscPath must be in Latin-1, as the database is", { path: "$.hvscPath" });
    }
    const extension = extname(database) || ".md5";
    const output = planOutput(args, `${basename(database, extension)}-edited`, extension, [input.file]);
    const format = songlengthsFormatOf(database);
    const md5 = songlengthsKey(input.bytes, format);
    const hvscPath = places.path === undefined || places.path.startsWith("/") ? places.path : `/${places.path}`;
    const result = writeSonglengthsEntry(await latin1File(database), { md5, durations, path: hvscPath }, format);
    const artifact = await output.write(Buffer.from(result.text, "latin1"), ctx);
    const changes = capped(result.changes, 5);
    return {
      action: "songlength", result: result.action, md5, ...artifact, database,
      changes: changes.items, ...(changes.omitted ? { changesOmitted: changes.omitted } : {}),
      ...(artifact.outputPath === database ? {} : { note: "The database is unchanged; pass its path as outputPath with overwrite: true to replace it." }),
    };
  },
};

/**
 * MCP Skills extension (`io.modelcontextprotocol/skills`): thin adapter over the skill catalogue in
 * `skills.ts`. The catalogue owns discovery, validation, digests and served bytes; this module only maps
 * them onto `skills/list`, `skills/get` and `resources/read` for `skill://` URIs.
 *
 * Choice: `skill://` resources are NOT added to `resources/list`. The same 13 skills are already listed as
 * `c64://skills/<name>`; listing them twice would duplicate every skill for a client that ignores the
 * extension. Clients that use the extension find skills through `skills/list`; `skill://` URIs stay
 * readable through `resources/read` for every client.
 */
import { z } from "zod";
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError, type Server } from "@modelcontextprotocol/server";
import {
  DEFAULT_SKILL_PAGE_SIZE,
  SKILL_EXTENSION_URI_PREFIX,
  SkillCursorError,
  listSkillExtensionEntries,
  pageSkillExtensionEntries,
  readSkillBytes,
} from "./skills.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
/** Test seam: page size of `skills/list` (integer >= 1). */
export const SKILLS_PAGE_SIZE_ENV = "C64BRIDGE_SKILLS_PAGE_SIZE";

/** The catalogue does not change while the server runs; clients may cache a listing for a minute. */
const CACHE_FIELDS = { ttlMs: 60_000, cacheScope: "public" } as const;

function pageSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SKILLS_PAGE_SIZE_ENV]?.trim();
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_SKILL_PAGE_SIZE;
}

/** Cache fields exist only in the 2026-07-28 shape; a pre-2026 request carries no envelope. */
function cacheFields(ctx: { mcpReq: { envelope?: unknown } }): Record<string, unknown> {
  return ctx.mcpReq.envelope === undefined ? {} : { ...CACHE_FIELDS };
}

const listParams = z.looseObject({ cursor: z.string().optional() });
const getParams = z.looseObject({ uri: z.string() });

export function registerSkillsHandlers(server: Server): void {
  server.setRequestHandler("skills/list", { params: listParams }, async (params, ctx) => {
    try {
      const page = pageSkillExtensionEntries({ ...(params.cursor !== undefined ? { cursor: params.cursor } : {}), pageSize: pageSize() });
      return {
        skills: page.entries,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        ...cacheFields(ctx),
      };
    } catch (error) {
      if (error instanceof SkillCursorError) throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
      throw error;
    }
  });
  server.setRequestHandler("skills/get", { params: getParams }, async (params, ctx) => {
    const skill = listSkillExtensionEntries().find((entry) => entry.uri === params.uri);
    if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${params.uri}`);
    return { skill, ...cacheFields(ctx) };
  });
}

export function isSkillExtensionUri(uri: string): boolean {
  return uri.startsWith(SKILL_EXTENSION_URI_PREFIX);
}

/**
 * `resources/read` for a `skill://<name>/<path>` URI: the catalogue bytes exactly as hashed for `skills/list`
 * (no further rewriting). Unknown, traversal and escaping URIs are resource-not-found.
 */
export function readSkillExtensionResource(uri: string): { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string } {
  const found = readSkillBytes(uri);
  if (!found) throw new ResourceNotFoundError(uri, `Unknown resource: ${uri}`);
  try {
    return { uri, mimeType: found.mimeType, text: new TextDecoder("utf-8", { fatal: true }).decode(found.bytes) };
  } catch {
    return { uri, mimeType: found.mimeType, blob: Buffer.from(found.bytes).toString("base64") };
  }
}

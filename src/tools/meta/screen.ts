// Screen-related meta tools
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { sleep } from "./util.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const MAX_PATTERN_LENGTH = 200;
export const MAX_WAIT_TIMEOUT_MS = 120_000;
export const MIN_POLL_INTERVAL_MS = 20;

/**
 * Checks a user regular expression before it runs on the event loop. A pattern
 * such as (a+)+$ takes exponential time on a screen of identical characters, so
 * quantified groups that contain a quantifier are rejected, as are
 * backreferences (also a source of super-linear matching).
 */
export function assertSafeScreenPattern(pattern: string): void {
  const path = "$.pattern";
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ToolValidationError(`Pattern is ${pattern.length} characters; the limit is ${MAX_PATTERN_LENGTH}`, { path });
  }
  // One entry per open group: whether it contains a quantifier.
  const groups: boolean[] = [];
  let inClass = false;
  let previousWasGroupWithQuantifier = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const isQuantifier = !inClass && (char === "*" || char === "+" || char === "?" || (char === "{" && /^\{\d+(,\d*)?\}/.test(pattern.slice(index))));
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      if (!inClass && (/[1-9]/.test(next) || (next === "k" && pattern[index + 2] === "<"))) {
        throw new ToolValidationError("Backreferences are not supported in screen patterns", { path });
      }
      index += 1;
      previousWasGroupWithQuantifier = false;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      previousWasGroupWithQuantifier = false;
      continue;
    }
    if (char === "(") {
      groups.push(false);
      previousWasGroupWithQuantifier = false;
      continue;
    }
    if (char === ")") {
      previousWasGroupWithQuantifier = groups.pop() ?? false;
      continue;
    }
    if (isQuantifier) {
      // "(?" opens a group modifier, and a "?" after another quantifier makes it lazy; neither is a repeat.
      const opensModifier = char === "?" && pattern[index - 1] === "(";
      const isLazyMarker = char === "?" && "*+?}".includes(pattern[index - 1] ?? "");
      if (!opensModifier && !isLazyMarker) {
        if (previousWasGroupWithQuantifier) {
          throw new ToolValidationError(
            "Nested quantifiers (a repeated group that itself contains a repeat) are not supported in screen patterns",
            { path },
          );
        }
        if (groups.length > 0) groups[groups.length - 1] = true;
      }
      previousWasGroupWithQuantifier = false;
      continue;
    }
    previousWasGroupWithQuantifier = false;
  }
}

export function compileScreenPattern(pattern: string, isRegex: boolean, caseInsensitive: boolean): RegExp {
  const flags = caseInsensitive ? "i" : undefined;
  if (!isRegex) {
    return new RegExp(escapeRegex(pattern), flags);
  }
  assertSafeScreenPattern(pattern);
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new ToolValidationError(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`, { path: "$.pattern" });
  }
}

export interface WaitForScreenTextOptions {
  readonly pattern: string;
  readonly isRegex?: boolean;
  readonly caseInsensitive?: boolean;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export type WaitForScreenTextResult =
  | { matched: true; match: { index: number; length: number; text: string }; elapsedMs: number; screen: string }
  | { matched: false; elapsedMs: number; screen: string | undefined };

/** Polls the screen until the pattern matches or the timeout elapses. Does not throw on timeout. */
export async function waitForScreenText(
  client: { readScreen(): Promise<string> },
  options: WaitForScreenTextOptions,
): Promise<WaitForScreenTextResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? 3000, MAX_WAIT_TIMEOUT_MS);
  const intervalMs = Math.max(options.intervalMs ?? 100, MIN_POLL_INTERVAL_MS);
  const regex = compileScreenPattern(options.pattern, options.isRegex ?? false, options.caseInsensitive ?? true);
  const start = Date.now();
  let lastScreen: string | undefined;
  while (Date.now() - start < timeoutMs) {
    const screen = await client.readScreen();
    lastScreen = screen;
    const match = screen.match(regex);
    if (match && match.index !== undefined) {
      return {
        matched: true,
        match: { index: match.index, length: match[0]?.length ?? 0, text: match[0] ?? "" },
        elapsedMs: Date.now() - start,
        screen,
      };
    }
    await sleep(intervalMs);
  }
  return { matched: false, elapsedMs: Date.now() - start, screen: lastScreen };
}

const waitForScreenTextArgsSchema = objectSchema({
  description: "Poll screen until text or regex matches, or timeout elapses.",
  properties: {
    pattern: stringSchema({ description: "Substring or regex to find (at most 200 characters; regex with nested quantifiers or backreferences is rejected)", minLength: 1, maxLength: 200 }),
    isRegex: optionalSchema(booleanSchema({ description: "Interpret pattern as regular expression", default: false }), false),
    caseInsensitive: optionalSchema(booleanSchema({ description: "Case-insensitive search", default: true }), true),
    timeoutMs: optionalSchema(numberSchema({ description: "Overall timeout in milliseconds (1-120000)", integer: true, minimum: 1, maximum: 120000, default: 3000 }), 3000),
    intervalMs: optionalSchema(numberSchema({ description: "Poll interval in milliseconds (at least 20)", integer: true, minimum: 20, default: 100 }), 100),
  },
  required: ["pattern"],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "wait_for_screen_text",
    description: "Poll screen until a regex or substring matches, within a timeout.",
    summary: "Screen poll with regex/text match and timing.",
    inputSchema: waitForScreenTextArgsSchema.jsonSchema,
    tags: ["screen", "assert"],
    examples: [{ name: "Wait for READY.", description: "Find boot prompt", arguments: { pattern: "READY.", isRegex: false, timeoutMs: 1000, intervalMs: 50 } }],
    async execute(args, ctx) {
      try {
        const parsed = waitForScreenTextArgsSchema.parse(args ?? {});
        const result = await waitForScreenText(ctx.client as any, parsed);
        if (result.matched) {
          return jsonResult({
            matched: true,
            match: result.match,
            elapsedMs: result.elapsedMs,
          }, { success: true });
        }
        throw new ToolExecutionError("Timeout waiting for screen text", {
          details: { pattern: parsed.pattern, timeoutMs: parsed.timeoutMs, elapsedMs: result.elapsedMs, screen: result.screen ?? null },
        });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];

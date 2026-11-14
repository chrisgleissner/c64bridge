// Screen-related meta tools
import { cancelledResult, type ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { sleep } from "./util.js";
import vm from "node:vm";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const MAX_PATTERN_LENGTH = 200;
export const MAX_WAIT_TIMEOUT_MS = 120_000;
export const MIN_POLL_INTERVAL_MS = 20;
export const MAX_POLL_INTERVAL_MS = 5000;
/** A read that starts at the deadline may take this long, so the call returns within timeoutMs plus this margin. */
const FINAL_READ_GRACE_MS = 250;
/** Upper bound for one pattern evaluation against one screen. */
export const PATTERN_EVAL_TIMEOUT_MS = 250;
/** Unbounded repeats (*, +, {n,}) allowed per pattern; each one adds a power to the worst-case backtracking cost. */
export const MAX_UNBOUNDED_REPEATS = 3;

/** True when regex evaluation can be interrupted by the runtime's vm timeout. */
export function runtimeEnforcesPatternTimeout(): boolean {
  return typeof (globalThis as any).Bun === "undefined";
}

/** Splits a group body at its top-level "|" characters, skipping escapes, classes and nested groups. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "\\") { index += 1; continue; }
    if (inClass) { if (char === "]") inClass = false; continue; }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "|" && depth === 0) { parts.push(body.slice(start, index)); start = index + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * True when the alternatives of a repeated group cannot match the same text in
 * two ways: each is a run of plain literal characters and no two start with the
 * same character (compared without case, which covers the i flag).
 */
function alternativesAreDisjointLiterals(alternatives: string[]): boolean {
  const first = new Set<string>();
  for (const alternative of alternatives) {
    if (alternative.length === 0 || /[\\[\](){}.*+?|^$]/.test(alternative)) return false;
    const key = alternative[0]!.toLowerCase();
    if (first.has(key)) return false;
    first.add(key);
  }
  return true;
}

/**
 * Checks a user regular expression before it runs on the event loop. A pattern
 * such as (a+)+$ takes exponential time on a screen of identical characters, so
 * quantified groups that contain a quantifier are rejected, as are
 * backreferences (also a source of super-linear matching) only when the
 * runtime cannot enforce the vm evaluation timeout.
 */
export function assertSafeScreenPattern(pattern: string): void {
  const path = "$.pattern";
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ToolValidationError(`Pattern is ${pattern.length} characters; the limit is ${MAX_PATTERN_LENGTH}`, { path });
  }
  if (runtimeEnforcesPatternTimeout()) return;
  // One entry per open group: whether it contains a quantifier.
  const groups: boolean[] = [];
  const groupStarts: number[] = [];
  let unboundedRepeats = 0;
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
      groupStarts.push(index);
      previousWasGroupWithQuantifier = false;
      continue;
    }
    if (char === ")") {
      previousWasGroupWithQuantifier = groups.pop() ?? false;
      const groupStart = groupStarts.pop();
      const rest = pattern.slice(index + 1);
      if (groupStart !== undefined && (/^[*+]/.test(rest) || /^\{\d+(,\d*)?\}/.test(rest))) {
        const alternatives = splitAlternatives(pattern.slice(groupStart + 1, index).replace(/^\?:/, ""));
        if (alternatives.length > 1 && !alternativesAreDisjointLiterals(alternatives)) {
          throw new ToolValidationError(
            "A repeated group with alternatives that can match the same text (for example (a|a)+ or (.|.)+) is not supported in screen patterns",
            { path },
          );
        }
      }
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
        if (char === "*" || char === "+" || (char === "{" && /^\{\d+,\}/.test(pattern.slice(index)))) {
          unboundedRepeats += 1;
          if (unboundedRepeats > MAX_UNBOUNDED_REPEATS) {
            throw new ToolValidationError(
              `Screen patterns may contain at most ${MAX_UNBOUNDED_REPEATS} unbounded repeats (*, +, {n,})`,
              { path },
            );
          }
        }
      }
      previousWasGroupWithQuantifier = false;
      continue;
    }
    previousWasGroupWithQuantifier = false;
  }
}

/**
 * Runs a pattern against screen text with a hard time limit. V8 interrupts a
 * running regular expression when the vm timeout expires, so a pattern that the
 * static checks above miss cannot freeze the event loop on Node. (Bun does not
 * enforce the vm timeout; the static checks bound the cost there.)
 */
export function createScreenMatcher(regex: RegExp, timeoutMs: number = PATTERN_EVAL_TIMEOUT_MS) {
  const sandbox = vm.createContext({ source: regex.source, flags: regex.flags, screen: "", result: null as unknown });
  vm.runInContext("var re = new RegExp(source, flags);", sandbox);
  return (screen: string): { index: number; text: string } | null => {
    sandbox.screen = screen;
    try {
      vm.runInContext("var m = re.exec(screen); result = m ? [m.index, m[0]] : null;", sandbox, { timeout: timeoutMs });
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new ToolValidationError(`Pattern /${regex.source}/ took longer than ${timeoutMs} ms to evaluate and was stopped; use a simpler pattern`, { path: "$.pattern" });
      }
      throw error;
    }
    const found = sandbox.result as [number, string] | null;
    return found ? { index: found[0], text: found[1] } : null;
  };
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
  /** Checked before every read; an aborted signal ends the wait with `cancelled: true`. */
  readonly signal?: AbortSignal;
}

export type WaitForScreenTextResult =
  | { matched: true; match: { index: number; length: number; text: string }; elapsedMs: number; screen: string; warnings?: string[] }
  | { matched: false; elapsedMs: number; screen: string | undefined; warnings?: string[]; cancelled?: true };

/** Reads the screen, giving up after limitMs. Resolves undefined when the read did not finish in time. */
async function readWithin(client: { readScreen(): Promise<string> }, limitMs: number): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(1, limitMs)); });
  const read = client.readScreen();
  read.catch(() => undefined); // a read that fails after the deadline must not become an unhandled rejection
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Polls the screen until the pattern matches or the timeout elapses. Does not throw on timeout. */
export async function waitForScreenText(
  client: { readScreen(): Promise<string> },
  options: WaitForScreenTextOptions,
): Promise<WaitForScreenTextResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? 3000, MAX_WAIT_TIMEOUT_MS);
  const intervalMs = Math.min(Math.max(options.intervalMs ?? 100, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
  const warnings = (options.intervalMs ?? 100) > MAX_POLL_INTERVAL_MS
    ? [`intervalMs ${options.intervalMs} exceeds ${MAX_POLL_INTERVAL_MS}; ${MAX_POLL_INTERVAL_MS} ms was used`]
    : undefined;
  const regex = compileScreenPattern(options.pattern, options.isRegex ?? false, options.caseInsensitive ?? true);
  const matchScreen = createScreenMatcher(regex);
  const start = Date.now();
  let lastScreen: string | undefined;
  for (;;) {
    if (options.signal?.aborted) {
      return { matched: false, cancelled: true, elapsedMs: Date.now() - start, screen: lastScreen, ...(warnings ? { warnings } : {}) };
    }
    // The last read happens at the deadline, after the final sleep. A stalled read must not outlast the deadline: it counts as a miss.
    const screen = await readWithin(client, Math.max(timeoutMs - (Date.now() - start), FINAL_READ_GRACE_MS));
    if (screen === undefined) break;
    lastScreen = screen;
    const match = matchScreen(screen);
    if (match) {
      return {
        matched: true,
        match: { index: match.index, length: match.text.length, text: match.text },
        elapsedMs: Date.now() - start,
        screen,
        ...(warnings ? { warnings } : {}),
      };
    }
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return { matched: false, elapsedMs: Date.now() - start, screen: lastScreen, ...(warnings ? { warnings } : {}) };
}

const waitForScreenTextArgsSchema = objectSchema({
  description: "Poll screen until text or regex matches, or timeout elapses.",
  properties: {
    pattern: stringSchema({ description: "Substring or regex to find (at most 200 characters; on runtimes without evaluation timeout, backreferences and nested quantifiers are rejected)", minLength: 1, maxLength: 200 }),
    isRegex: optionalSchema(booleanSchema({ description: "Interpret pattern as regular expression", default: false }), false),
    caseInsensitive: optionalSchema(booleanSchema({ description: "Case-insensitive search", default: true }), true),
    timeoutMs: optionalSchema(numberSchema({ description: "Overall timeout in milliseconds (1-120000)", integer: true, minimum: 1, maximum: 120000, default: 3000 }), 3000),
    intervalMs: optionalSchema(numberSchema({ description: "Poll interval in milliseconds (minimum 20; values above 5000 are clamped to 5000)", integer: true, minimum: 20, default: 100 }), 100),
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
        const result = await waitForScreenText(ctx.client as any, { ...parsed, signal: ctx.signal });
        if (result.matched === false && result.cancelled) {
          return cancelledResult(`wait_for_screen_text was cancelled after ${result.elapsedMs} ms`);
        }
        if (result.matched) {
          return jsonResult({
            matched: true,
            match: result.match,
            elapsedMs: result.elapsedMs,
            ...(result.warnings ? { warnings: result.warnings } : {}),
          }, { success: true });
        }
        throw new ToolExecutionError("Timeout waiting for screen text", {
          details: { pattern: parsed.pattern, timeoutMs: parsed.timeoutMs, elapsedMs: result.elapsedMs, screen: result.screen ?? null, ...(result.warnings ? { warnings: result.warnings } : {}) },
        });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];

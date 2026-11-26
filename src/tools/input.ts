import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  type OperationHandlerMap,
  type OperationMap,
} from "./types.js";
import {
  arraySchema,
  booleanSchema,
  literalSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "./schema.js";
import { jsonResult, textResult } from "./responses.js";
import {
  ToolExecutionError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";
import { lookupNamedPetscii, petsciiControlName } from "../petscii.js";

function isMissingNativeInputEndpoint(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "response" in error
    && (error as { response?: { status?: unknown } }).response?.status === 404;
}

function nativeInputUnavailableResult(operation: string) {
  return toolErrorResult(new ToolExecutionError(
    `Native physical input is unavailable on this firmware, so ${operation} was not sent. Use c64://platform/status before choosing native input; use key or write_text for ordinary C64 input.`,
    { code: "native_input_unavailable", details: { fallback: "key_or_write_text" } },
  ));
}

// {TOKEN} names and codes come from the shared control-code table in ../petscii.ts (also used
// for BASIC text), so both tools accept the same names. Bytes are queued through KERNAL
// keyboard-buffer injection on both C64U and VICE.
function validTokenNames(): string[] {
  const names: string[] = [];
  for (let code = 0; code < 256; code += 1) {
    const name = petsciiControlName(code);
    if (name !== undefined) names.push(`{${name.replace(/ /g, "_").toUpperCase()}}`);
  }
  return names;
}

// ASCII a-z are shifted graphics characters in PETSCII, so typed "print" would
// reach BASIC as graphics and give ?SYNTAX ERROR. Literal letters are therefore
// sent as the unshifted PETSCII letters $41-$5A; {tokens} keep their codes.
// Newline is RETURN. Any other character without a PETSCII equivalent, and any
// unknown {TOKEN}, is rejected instead of being typed as something else.
function describeChar(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `'${codePoint < 0x20 ? "" : char}' (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`;
}

function expandPetsciiTokens(text: string): string {
  return text.replace(/\{([^}]+)\}|\r\n|[\s\S]/gu, (match: string, token: string | undefined, offset: number) => {
    if (token === undefined) {
      if (match === "\n" || match === "\r" || match === "\r\n") {
        return String.fromCharCode(13);
      }
      const code = match.codePointAt(0) ?? 0;
      if (code >= 0x61 && code <= 0x7a) {
        return match.toUpperCase();
      }
      if (code >= 0x20 && code <= 0x7e) {
        return match;
      }
      throw new ToolValidationError(
        `Character ${describeChar(match)} at position ${offset + 1} of the text has no PETSCII mapping. Use printable ASCII, \\n for RETURN, or a {TOKEN}.`,
        { path: "$.text" },
      );
    }
    const upper = token.trim().toUpperCase();
    const code = lookupNamedPetscii(upper);
    if (code !== undefined) {
      return String.fromCharCode(code);
    }
    // Numeric form: {$1D} or {29}. Anchored, so {12AB} is not read as {12}.
    let num = NaN;
    if (/^\$[0-9A-F]{1,2}$/.test(upper)) {
      num = parseInt(upper.slice(1), 16);
    } else if (/^\d{1,3}$/.test(upper)) {
      num = parseInt(upper, 10);
    }
    if (!isNaN(num) && num >= 0 && num <= 255) {
      return String.fromCharCode(num);
    }
    throw new ToolValidationError(
      `Unknown token {${token}} at position ${offset + 1} of the text. Valid tokens: ${validTokenNames().join(", ")}, or a numeric code such as {$1D} or {29} (0-255).`,
      { path: "$.text" },
    );
  });
}

// ---------------------------------------------------------------------------
// Joystick helpers
// Bits 0-4: Up / Down / Left / Right / Fire, active LOW (0 = pressed).
// VICE must use Binary Monitor Joyport Set; CIA register writes are not input.
// ---------------------------------------------------------------------------

const JOYSTICK_BIT: Record<string, number> = {
  up: 0,
  down: 1,
  left: 2,
  right: 3,
  fire: 4,
};

const KEYBOARD_INPUTS = [
  "inst_del", "return", "cursor_left_right", "f7", "f1", "f3", "f5", "cursor_up_down",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "left_shift", "right_shift", "plus", "minus", "period", "colon", "at", "comma", "pound", "star", "semicolon", "clr_home", "equals", "arrow_up", "slash", "arrow_left", "ctrl", "space", "commodore", "run_stop", "restore",
] as const;
const JOYSTICK_INPUTS = ["up", "down", "left", "right", "fire", "fire2", "fire3"] as const;
const INPUT_TRANSITIONS = ["press", "release", "tap"] as const;

function joystickByte(controls: readonly string[]): number {
  let mask = 0xff;
  for (const ctrl of controls) {
    const bit = JOYSTICK_BIT[ctrl.toLowerCase()];
    if (bit !== undefined) {
      mask &= ~(1 << bit);
    }
  }
  return mask & 0xff;
}

// ---------------------------------------------------------------------------
// Operation maps
// ---------------------------------------------------------------------------
interface InputOperationMap extends OperationMap {
  readonly write_text: { readonly text: string; readonly delayMs?: number };
  readonly key: { readonly key: string; readonly durationMs?: number; readonly count?: number };
  readonly joystick: {
    readonly port: 1 | 2;
    readonly controls: readonly string[];
    readonly action: "press" | "release" | "tap";
    readonly durationMs?: number;
  };
  readonly keyboard: { readonly inputs: readonly string[]; readonly transition: "press" | "release" | "tap" };
  readonly release_all: Record<string, never>;
  readonly state: Record<string, never>;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const writeTextArgsSchema = objectSchema({
  description: "Send a text string to the keyboard buffer, with PETSCII token expansion.",
  properties: {
    op: literalSchema("write_text"),
    text: stringSchema({
      description: "Text to type: printable ASCII (letters sent as PETSCII upper case), \\n for RETURN, and {TOKEN}s such as {RETURN}, {CLR}, {F1}…{F8}, {UP}, colour names, {$1D}/{29}. Unmappable characters and unknown tokens are rejected.",
      minLength: 1,
      maxLength: 512,
    }),
    delayMs: optionalSchema(numberSchema({
      description: "Delay in ms after sending (default 0).",
      integer: true,
      minimum: 0,
      maximum: 10000,
      default: 0,
    })),
  },
  required: ["op", "text"],
  additionalProperties: false,
});

export const keyArgsSchema = objectSchema({
  description: "Press one key one or more times, optionally with a delay.",
  properties: {
    op: literalSchema("key"),
    key: stringSchema({
      description: "Key to press: a printable character or PETSCII token name (RETURN, F1…F8, UP). STOP only types code 3 and may not break a running program; use op keyboard with run_stop on C64U.",
      minLength: 1,
      maxLength: 32,
    }),
    durationMs: optionalSchema(numberSchema({
      description: "Delay in ms between presses (default 0).",
      integer: true,
      minimum: 0,
      maximum: 5000,
      default: 0,
    })),
    count: optionalSchema(numberSchema({
      description: "Number of times to press the key (default 1).",
      integer: true,
      minimum: 1,
      maximum: 100,
      default: 1,
    })),
  },
  required: ["op", "key"],
  additionalProperties: false,
});

export const joystickArgsSchema = objectSchema({
  description: "Simulate joystick input. On C64U/U64 this uses machine:input. On VICE it attaches the joyport simulation device, which pulls CIA lines 5-7 low: port 1 produces phantom keys and port 2 reads $1E for up instead of $7E. Prefer port 2 on VICE and test bits 0-4.",
  properties: {
    op: literalSchema("joystick"),
    port: numberSchema({
    description: "Joystick port (1 or 2).",
      integer: true,
      minimum: 1,
      maximum: 2,
    }),
    controls: arraySchema(
      stringSchema({
        description: "Control to activate.",
        enum: JOYSTICK_INPUTS,
      }),
      {
        description: "List of controls to activate simultaneously.",
        minItems: 0,
      },
    ),
    action: stringSchema({
      description: "press = hold until a release call; release = restore all bits; tap = press then release after durationMs.",
      enum: ["press", "release", "tap"],
    }),
    durationMs: optionalSchema(numberSchema({
      description: "Duration to hold for tap action in ms (default 80).",
      integer: true,
      minimum: 10,
      maximum: 5000,
      default: 80,
    })),
  },
  required: ["op", "port", "controls", "action"],
  additionalProperties: false,
});

export const keyboardArgsSchema = objectSchema({
  description: "Send physical C64 keyboard matrix events through machine:input (needs firmware support; U64 3.15+).",
  properties: {
    op: literalSchema("keyboard"),
    inputs: arraySchema(stringSchema({ description: "Physical keyboard input.", enum: KEYBOARD_INPUTS }), {
      description: "One or more keys to transition together (for example left_shift + a).",
      minItems: 1,
      maxItems: 8,
    }),
    transition: stringSchema({ description: "press holds, release frees, tap presses and releases.", enum: INPUT_TRANSITIONS }),
  },
  required: ["op", "inputs", "transition"],
  additionalProperties: false,
});

const releaseAllArgsSchema = objectSchema({
  description: "Release every key and joystick control injected through machine:input.",
  properties: { op: literalSchema("release_all") },
  required: ["op"],
  additionalProperties: false,
});

const inputStateArgsSchema = objectSchema({
  description: "Read the keys and joystick controls held through machine:input.",
  properties: { op: literalSchema("state") },
  required: ["op"],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type FeedResult = { delivered: number; status?: "drained" | "queued" | "stopped"; pending?: number; stoppedAt?: number };

/** The VICE keyboard-feed outcome as result fields. A feed is typed only when its status is "drained". */
function feedFields(fed: FeedResult | undefined): { status: "drained" | "queued" | "stopped"; pending: number; stoppedAt: number | null; success: boolean } {
  const status = fed?.status ?? "drained";
  return { status, pending: fed?.pending ?? 0, stoppedAt: fed?.stoppedAt ?? null, success: status === "drained" };
}

function feedNote(fields: ReturnType<typeof feedFields>): string {
  if (fields.status === "stopped") {
    const at = fields.stoppedAt === null ? "" : ` at $${fields.stoppedAt.toString(16).toUpperCase().padStart(4, "0")}`;
    return ` The keyboard feed stopped at a checkpoint${at}; ${fields.pending} byte(s) pending.`;
  }
  if (fields.status === "queued") {
    return ` The feed is held: a pause is active; ${fields.pending} byte(s) pending until it ends.`;
  }
  return "";
}

// A tap owns its press until the matching release. Keep other native joystick
// changes (including release_all) behind it on the same physical backend.
const nativeJoystickTails = new WeakMap<object, Promise<void>>();

async function withNativeJoystickLock<T>(backend: object, operation: () => Promise<T>): Promise<T> {
  const previous = nativeJoystickTails.get(backend) ?? Promise.resolve();
  const run = previous.then(operation);
  const tail = run.then(() => undefined, () => undefined);
  nativeJoystickTails.set(backend, tail);
  try {
    return await run;
  } finally {
    if (nativeJoystickTails.get(backend) === tail) nativeJoystickTails.delete(backend);
  }
}

function textToPetsciiBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(bytes);
}

/** The request abort signal, so a cancelled call stops waiting for the keyboard queue to drain. */
function signalOption(ctx: { readonly signal?: AbortSignal }): { signal: AbortSignal } | undefined {
  return ctx.signal ? { signal: ctx.signal } : undefined;
}

const inputOperationHandlers: OperationHandlerMap<InputOperationMap> = {
  write_text: async (args, ctx) => {
    try {
      const parsed = writeTextArgsSchema.parse(args);
      const expanded = expandPetsciiTokens(parsed.text);
      const petsciiBytes = textToPetsciiBytes(expanded);
      const fed = feedFields(await ctx.client.injectKeyboardQueue(petsciiBytes, signalOption(ctx)));
      if (parsed.delayMs && parsed.delayMs > 0) {
        await new Promise<void>((res) => setTimeout(res, parsed.delayMs));
      }
      ctx.logger.info("Sent keyboard text", { length: expanded.length, status: fed.status });
      const text = fed.success
        ? `Sent ${expanded.length} character(s) to keyboard buffer.`
        : `Keyboard text not typed: ${expanded.length} character(s) requested.${feedNote(fed)}`;
      return textResult(text, { ...fed, length: expanded.length });
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
      return unknownErrorResult(error);
    }
  },

  key: async (args, ctx) => {
    try {
      const parsed = keyArgsSchema.parse(args);
      const count = parsed.count ?? 1;
      const durationMs = parsed.durationMs ?? 0;
      // Resolve key to a character: try token first, then single char
      const tokenCode = lookupNamedPetscii(parsed.key);
      const keyByte = tokenCode !== undefined
        ? tokenCode
        : parsed.key.length === 1
          ? expandPetsciiTokens(parsed.key).charCodeAt(0)
          : (() => {
              throw new ToolValidationError(`Unrecognised key: ${parsed.key}. Use a single character or a PETSCII token name.`, { path: "$.key" });
            })();
      let fed = feedFields({ delivered: 0 });
      let presses = 0;
      if (durationMs === 0 && count > 1) {
        // No pause between presses: one injection of count bytes, not count round trips.
        const raw = await ctx.client.injectKeyboardQueue(new Uint8Array(count).fill(keyByte), signalOption(ctx));
        fed = feedFields(raw);
        presses = fed.status === "drained" ? count : Math.min(count, raw.delivered ?? 0);
      } else {
        for (let i = 0; i < count; i++) {
          fed = feedFields(await ctx.client.injectKeyboardQueue(Uint8Array.of(keyByte), signalOption(ctx)));
          presses += 1;
          // Stop at the first feed that did not drain: later presses would queue behind a stopped feed.
          if (fed.status !== "drained") break;
          if (durationMs > 0) {
            await new Promise<void>((res) => setTimeout(res, durationMs));
          }
        }
      }
      ctx.logger.info("Pressed key", { key: parsed.key, count, durationMs, status: fed.status });
      const text = fed.success
        ? `Pressed '${parsed.key}' ${count} time${count === 1 ? "" : "s"}.`
        : `Key '${parsed.key}' not pressed after ${presses} of ${count} time${count === 1 ? "" : "s"}.${feedNote(fed)}`;
      return textResult(text, { ...fed, key: parsed.key, count, presses, durationMs });
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
      return unknownErrorResult(error);
    }
  },

  joystick: async (args, ctx) => {
    try {
      const parsed = joystickArgsSchema.parse(args);
      const port = parsed.port as 1 | 2;
      const durationMs = parsed.durationMs ?? 80;
      const pressedByte = joystickByte(parsed.controls);
      const facade = await ctx.client.pinFacade?.();
      const platform = facade?.type ?? await ctx.client.getActiveBackendType();

      if (platform === "c64u") {
        const backend = facade ?? ctx.client;
        return await withNativeJoystickLock(backend, async () => {
          if (parsed.controls.length === 0 && parsed.action === "release") {
            const state = await backend.sendInputEvents({ events: [{ kind: "release_all" }] });
            return textResult("Released all REST-injected keyboard and joystick inputs.", { success: true, action: "release_all", state });
          }
          const joystickEvent = (transition: "press" | "release") => ({
            events: [{ kind: "joystick" as const, port, inputs: [...parsed.controls], transition }],
          });
          let state;
          if (parsed.action === "tap") {
            // The firmware holds a REST joystick tap for a single tick of its own, measured at 0.5-18.5 ms (under one PAL frame)
            // on an Ultimate 64 Elite, firmware 3.15a, 2026-11-20. That is too short for a game to poll reliably,
            // so hold the press for durationMs here.
            let failed = false;
            try {
              // A failed response can follow an applied press, so cleanup also
              // covers the initial request.
              await backend.sendInputEvents(joystickEvent("press"));
              await new Promise<void>((res) => setTimeout(res, durationMs));
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              try {
                state = await backend.sendInputEvents(joystickEvent("release"));
              } catch (error) {
                if (!failed) throw error;
                ctx.logger.warn("Unable to release joystick after a failed tap", { port });
              }
            }
          } else {
            state = await backend.sendInputEvents(joystickEvent(parsed.action as "press" | "release"));
          }
          return textResult(`Joystick port ${port} ${parsed.action}: ${parsed.controls.join(", ")}.`, {
            success: true, port, action: parsed.action, controls: parsed.controls, state,
          });
        });
      }

      if (parsed.controls.some((control) => !(control in JOYSTICK_BIT))) {
        throw new ToolValidationError("VICE joystick supports up, down, left, right, and fire only.", { path: "$.controls" });
      }

      if (parsed.action === "release") {
        await ctx.client.viceJoystickRelease(port);
        ctx.logger.info("Released joystick", { port });
        return textResult(`Joystick port ${port} released.`, { success: true, port, action: "release" });
      }

      if (parsed.action === "press") {
        await ctx.client.viceJoystickPress(port, pressedByte);
        ctx.logger.info("Pressed joystick", { port, controls: parsed.controls, byte: pressedByte });
        return textResult(
          `Joystick port ${port} pressed: ${parsed.controls.join(", ") || "none"}.${port === 1 ? " On VICE, port 1 also shows phantom keys while held." : ""}`,
          { success: true, port, action: "press", controls: parsed.controls },
        );
      }

      // tap: press → wait → release
      await ctx.client.viceJoystickPress(port, pressedByte);
      await new Promise<void>((res) => setTimeout(res, durationMs));
      await ctx.client.viceJoystickRelease(port);
      ctx.logger.info("Tapped joystick", { port, controls: parsed.controls, durationMs });
      return textResult(
        `Joystick port ${port} tapped: ${parsed.controls.join(", ") || "none"} for ${durationMs}ms.`,
        { success: true, port, action: "tap", controls: parsed.controls, durationMs },
      );
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
      if (isMissingNativeInputEndpoint(error)) return nativeInputUnavailableResult("the joystick event");
      return unknownErrorResult(error);
    }
  },

  keyboard: async (args, ctx) => {
    try {
      const parsed = keyboardArgsSchema.parse(args);
      const state = await ctx.client.sendInputEvents({
        events: [{ kind: "keyboard", inputs: [...parsed.inputs], transition: parsed.transition as "press" | "release" | "tap" }],
      });
      return textResult(`Keyboard ${parsed.transition}: ${parsed.inputs.join(", ")}.`, {
        success: true, inputs: parsed.inputs, transition: parsed.transition, state,
      });
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
      if (isMissingNativeInputEndpoint(error)) return nativeInputUnavailableResult("the keyboard event");
      return unknownErrorResult(error);
    }
  },

  release_all: async (args, ctx) => {
    try {
      releaseAllArgsSchema.parse(args);
      const backend = await ctx.client.pinFacade?.() ?? ctx.client;
      const state = await withNativeJoystickLock(backend, () => backend.sendInputEvents({ events: [{ kind: "release_all" }] }));
      return textResult("Released all REST-injected keyboard and joystick inputs.", { success: true, state });
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
      if (isMissingNativeInputEndpoint(error)) return nativeInputUnavailableResult("the release request");
      return unknownErrorResult(error);
    }
  },

  state: async (args, ctx) => {
    try {
      inputStateArgsSchema.parse(args);
      return jsonResult(await ctx.client.getInputState());
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
      if (isMissingNativeInputEndpoint(error)) return nativeInputUnavailableResult("the input-state query");
      return unknownErrorResult(error);
    }
  },
};

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------
export const inputModule = defineToolModule({
  domain: "input",
  summary: "Keyboard input plus native Ultimate REST keyboard and joystick control.",
  supportedPlatforms: ["c64u", "u2", "vice"],
  resources: ["c64://guide/bootstrap", "c64://memory/map", "c64://io/cia/spec"],
  prompts: [],
  defaultTags: ["input"],
  workflowHints: [
    "Use write_text with {RETURN} tokens to automate BASIC entry; use key for one PETSCII/KERNAL queue key. Neither is for navigating Ultimate firmware menus.",
    "write_text and key inject through the KERNAL keyboard queue ($0277/$00C6) so they work on both C64U and VICE.",
    "Use keyboard for physical C64 key combinations (including modifiers) on machine:input, and release_all to recover from interrupted holds. It requires a C64U firmware version that provides the endpoint, or U64 3.15+.",
    "Before native input, read c64://platform/status. If machine:input is unavailable or unknown, use key or write_text for ordinary C64 input instead of attempting physical matrix events.",
    "Change C64U/U64/U2 configuration through c64_config REST operations, never by keyboard menu navigation. Use keyboard navigation only where REST has no equivalent, such as the machine code monitor, visual SID editor, or Tool Menu.",
    "Joystick uses machine:input on a C64U firmware version that provides the endpoint or U64 3.15+; VICE supports up/down/left/right/fire through its monitor.",
  ],
  tools: [
    {
      name: "c64_input",
      description: "Cross-platform PETSCII typing plus native Ultimate keyboard and joystick events.",
      summary: "Types text, sends physical key combinations, and controls joysticks.",
      inputSchema: discriminatedUnionSchema({
        description: "Input operations: write_text, key, keyboard, joystick, release_all, state.",
        variants: [
          writeTextArgsSchema.jsonSchema,
          keyArgsSchema.jsonSchema,
          joystickArgsSchema.jsonSchema,
          keyboardArgsSchema.jsonSchema,
          releaseAllArgsSchema.jsonSchema,
          inputStateArgsSchema.jsonSchema,
        ],
      }),
      operationPlatforms: { joystick: ["c64u", "vice"], keyboard: ["c64u"], release_all: ["c64u"], state: ["c64u"] },
      operationEffects: { write_text: "write", key: "write", keyboard: "write", joystick: "write", release_all: "write", state: "read" },
      tags: ["input", "keyboard", "joystick"],
      examples: [
        {
          name: "Type BASIC line",
          description: "Enter a BASIC line and press RETURN",
          arguments: { op: "write_text", text: "PRINT \"HELLO\"{RETURN}" },
        },
        {
          name: "Press F1",
          description: "Send the F1 function key",
          arguments: { op: "key", key: "F1" },
        },
        {
          name: "Tap joystick right",
          description: "Brief rightward tap on joystick port 2",
          arguments: { op: "joystick", port: 2, controls: ["right"], action: "tap", durationMs: 80 },
        },
        {
          name: "Type an uppercase A",
          description: "Tap a physical key chord through Ultimate REST input",
          arguments: { op: "keyboard", inputs: ["left_shift", "a"], transition: "tap" },
        },
        {
          name: "Press fire on port 1",
          description: "Hold fire button on joystick port 1",
          arguments: { op: "joystick", port: 1, controls: ["fire"], action: "press" },
        },
      ],
      execute: createOperationDispatcher<InputOperationMap>("c64_input", inputOperationHandlers),
    },
  ],
});

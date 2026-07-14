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
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

// ---------------------------------------------------------------------------
// PETSCII token expansion table
// Maps {TOKEN} placeholders to PETSCII/control-byte values that are queued via
// KERNAL keyboard-buffer injection on both C64U and VICE.
// ---------------------------------------------------------------------------
const PETSCII_TOKENS: Readonly<Record<string, number>> = {
  RETURN: 13,
  CR: 13,
  CLR: 147,
  HOME: 19,
  DEL: 20,
  INS: 148,
  INSERT: 148,
  STOP: 3,
  RUN: 131,
  SHIFT_RETURN: 141,
  F1: 133,
  F2: 137,
  F3: 134,
  F4: 138,
  F5: 135,
  F6: 139,
  F7: 136,
  F8: 140,
  UP: 145,
  DOWN: 17,
  LEFT: 157,
  RIGHT: 29,
  BLACK: 144,
  WHITE: 5,
  RED: 28,
  CYAN: 159,
  PURPLE: 156,
  GREEN: 30,
  BLUE: 31,
  YELLOW: 158,
  ORANGE: 129,
  BROWN: 149,
  LIGHT_RED: 150,
  DARK_GREY: 151,
  MEDIUM_GREY: 152,
  LIGHT_GREEN: 153,
  LIGHT_BLUE: 154,
  LIGHT_GREY: 155,
  REVERSE_ON: 18,
  REVERSE_OFF: 146,
  FLASH_ON: 130,
  FLASH_OFF: 148,
  LOWERCASE: 14,
  UPPERCASE: 142,
  ESCAPE: 27,
  TAB: 9,
  CURSOR_UP: 145,
  CURSOR_DOWN: 17,
  CURSOR_LEFT: 157,
  CURSOR_RIGHT: 29,
};

function expandPetsciiTokens(text: string): string {
  return text.replace(/\{([^}]+)\}/g, (_match, token: string) => {
    const upper = token.trim().toUpperCase();
    const code = PETSCII_TOKENS[upper];
    if (code !== undefined) {
      return String.fromCharCode(code);
    }
    // Numeric form: {$1D} or {29}
    let num: number;
    if (upper.startsWith("$")) {
      num = parseInt(upper.slice(1), 16);
    } else {
      num = parseInt(upper, 10);
    }
    if (!isNaN(num) && num >= 0 && num <= 255) {
      return String.fromCharCode(num);
    }
    return _match; // leave unrecognised tokens as-is
  });
}

// ---------------------------------------------------------------------------
// Joystick helpers
// Port 2 → CIA1 Port A ($DC00), Port 1 → CIA1 Port B ($DC01)
// Bits 0-4: Up / Down / Left / Right / Fire, active LOW (0 = pressed)
// ---------------------------------------------------------------------------
const JOYSTICK_PORT_ADDRESS: Record<1 | 2, number> = {
  1: 0xDC01,
  2: 0xDC00,
};

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
      description: "Text to type. Use {RETURN}, {CLR}, {F1}…{F8}, {UP/DOWN/LEFT/RIGHT}, colour names, etc.",
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
  description: "Tap a single key or hold it for a duration.",
  properties: {
    op: literalSchema("key"),
    key: stringSchema({
      description: "Key to press: a printable character, or a PETSCII token name (RETURN, F1…F8, UP, etc.).",
      minLength: 1,
      maxLength: 32,
    }),
    durationMs: optionalSchema(numberSchema({
      description: "Delay in ms after each queued key press before the next press (default 0 = no delay).",
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
  description: "Simulate joystick input. On C64U/U64 this uses machine:input (a C64U firmware version that provides it, or U64 3.15+); VICE writes CIA1 registers.",
  properties: {
    op: literalSchema("joystick"),
    port: numberSchema({
      description: "Joystick port (1 = $DC01, 2 = $DC00).",
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
  description: "Send physical C64 keyboard matrix events through machine:input (a C64U firmware version that provides it, or U64 3.15+).",
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
  description: "Release every key and joystick control injected through machine:input (a C64U firmware version that provides it, or U64 3.15+).",
  properties: { op: literalSchema("release_all") },
  required: ["op"],
  additionalProperties: false,
});

const inputStateArgsSchema = objectSchema({
  description: "Read the keys and joystick controls held through machine:input (a C64U firmware version that provides it, or U64 3.15+).",
  properties: { op: literalSchema("state") },
  required: ["op"],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function textToPetsciiBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(bytes);
}

const inputOperationHandlers: OperationHandlerMap<InputOperationMap> = {
  write_text: async (args, ctx) => {
    try {
      const parsed = writeTextArgsSchema.parse(args);
      const expanded = expandPetsciiTokens(parsed.text);
      const petsciiBytes = textToPetsciiBytes(expanded);
      await ctx.client.injectKeyboardQueue(petsciiBytes);
      if (parsed.delayMs && parsed.delayMs > 0) {
        await new Promise<void>((res) => setTimeout(res, parsed.delayMs));
      }
      ctx.logger.info("Sent keyboard text", { length: expanded.length });
      return textResult(`Sent ${expanded.length} character(s) to keyboard buffer.`, { success: true, length: expanded.length });
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
      const tokenCode = PETSCII_TOKENS[parsed.key.toUpperCase()];
      const keyByte = tokenCode !== undefined
        ? tokenCode
        : parsed.key.length === 1
          ? parsed.key.charCodeAt(0) & 0xff
          : (() => {
              throw new ToolValidationError(`Unrecognised key: ${parsed.key}. Use a single character or a PETSCII token name.`, { path: "$.key" });
            })();
      for (let i = 0; i < count; i++) {
        await ctx.client.injectKeyboardQueue(Uint8Array.of(keyByte));
        if (durationMs > 0) {
          await new Promise<void>((res) => setTimeout(res, durationMs));
        }
      }
      ctx.logger.info("Pressed key", { key: parsed.key, count, durationMs });
      return textResult(
        `Pressed '${parsed.key}' ${count} time${count === 1 ? "" : "s"}.`,
        { success: true, key: parsed.key, count, durationMs },
      );
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
      const releasedByte = 0xff;
      const platform = await ctx.client.getActiveBackendType();

      if (platform === "c64u") {
        if (parsed.controls.length === 0 && parsed.action === "release") {
          const state = await ctx.client.sendInputEvents({ events: [{ kind: "release_all" }] });
          return textResult("Released all REST-injected keyboard and joystick inputs.", { success: true, action: "release_all", state });
        }
        const state = await ctx.client.sendInputEvents({
          events: [{ kind: "joystick", port, inputs: [...parsed.controls], transition: parsed.action as "press" | "release" | "tap" }],
        });
        return textResult(`Joystick port ${port} ${parsed.action}: ${parsed.controls.join(", ")}.`, {
          success: true, port, action: parsed.action, controls: parsed.controls, state,
        });
      }

      const addr = JOYSTICK_PORT_ADDRESS[port];
      if (parsed.controls.some((control) => !(control in JOYSTICK_BIT))) {
        throw new ToolValidationError("VICE joystick supports up, down, left, right, and fire only.", { path: "$.controls" });
      }

      if (parsed.action === "release") {
        await ctx.client.viceMemSet(addr, Uint8Array.of(releasedByte));
        ctx.logger.info("Released joystick", { port, address: `$${addr.toString(16).toUpperCase()}` });
        return textResult(`Joystick port ${port} released.`, { success: true, port, action: "release" });
      }

      if (parsed.action === "press") {
        await ctx.client.viceMemSet(addr, Uint8Array.of(pressedByte));
        ctx.logger.info("Pressed joystick", { port, controls: parsed.controls, byte: pressedByte });
        return textResult(
          `Joystick port ${port} pressed: ${parsed.controls.join(", ") || "none"}.`,
          { success: true, port, action: "press", controls: parsed.controls },
        );
      }

      // tap: press → wait → release
      await ctx.client.viceMemSet(addr, Uint8Array.of(pressedByte));
      await new Promise<void>((res) => setTimeout(res, durationMs));
      await ctx.client.viceMemSet(addr, Uint8Array.of(releasedByte));
      ctx.logger.info("Tapped joystick", { port, controls: parsed.controls, durationMs });
      return textResult(
        `Joystick port ${port} tapped: ${parsed.controls.join(", ") || "none"} for ${durationMs}ms.`,
        { success: true, port, action: "tap", controls: parsed.controls, durationMs },
      );
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
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
      return unknownErrorResult(error);
    }
  },

  release_all: async (args, ctx) => {
    try {
      releaseAllArgsSchema.parse(args);
      const state = await ctx.client.sendInputEvents({ events: [{ kind: "release_all" }] });
      return textResult("Released all REST-injected keyboard and joystick inputs.", { success: true, state });
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
      return unknownErrorResult(error);
    }
  },

  state: async (args, ctx) => {
    try {
      inputStateArgsSchema.parse(args);
      return jsonResult(await ctx.client.getInputState());
    } catch (error) {
      if (error instanceof ToolValidationError) return toolErrorResult(error);
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

/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

/**
 * Typed conditions for `c64_memory` op `wait_until` (contract C7). This module is pure: it performs no I/O,
 * keeps no state and has no clock. Addresses are resolved by an injected function, so the symbol table is
 * consulted exactly once, when the condition is parsed. There are no arbitrary predicates or expressions;
 * every condition is one of the nine types below.
 */

import { ToolValidationError } from "../tools/errors.js";
import { stripHexByteSeparators } from "../tools/hex.js";
import { parseNumericLiteral } from "../numericArg.js";

export type Endian = "little" | "big";
export type Width = 1 | 2 | 4;
export type Comparison = "gt" | "gte" | "lt" | "lte";
export type CheckpointKind = "exec" | "load" | "store";

export const CONDITION_TYPES = [
  "equals", "not_equals", "masked", "range", "threshold", "changed", "screen_text", "screen_changed", "checkpoint",
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export interface NumericSpec {
  readonly width: Width;
  readonly signed: boolean;
  readonly endian: Endian;
}

export type Condition =
  | { readonly type: "equals" | "not_equals"; readonly address: number; readonly bytes: Uint8Array }
  | { readonly type: "masked"; readonly address: number; readonly mask: number; readonly value: number }
  | ({ readonly type: "range"; readonly address: number; readonly min: number; readonly max: number } & NumericSpec)
  | ({ readonly type: "threshold"; readonly address: number; readonly comparison: Comparison; readonly value: number } & NumericSpec)
  | { readonly type: "changed"; readonly address: number; readonly length: number }
  | { readonly type: "screen_text"; readonly text: string; readonly present: boolean; readonly caseInsensitive: boolean }
  | { readonly type: "screen_changed" }
  | { readonly type: "checkpoint"; readonly address: number; readonly kind: CheckpointKind };

/** What one iteration must read. Resolved once, so a later symbol change cannot retarget it. */
export type ReadTarget =
  | { readonly kind: "memory"; readonly address: number; readonly length: number }
  | { readonly kind: "screen" }
  | { readonly kind: "checkpoint"; readonly address: number; readonly access: CheckpointKind };

export type Observation =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "screen"; readonly text: string }
  | { readonly kind: "hits"; readonly count: number };

export interface Evaluation {
  readonly met: boolean;
  /** Human-readable statement of what would satisfy the condition. */
  readonly expected: string;
  /** JSON value of what was seen: hex string for bytes, number for numeric conditions, text for the screen, hit count for a checkpoint. */
  readonly observed: string | number;
}

export const MAX_COMPARE_BYTES = 1024;
export const MAX_SCREEN_TEXT_LENGTH = 1000;

export type AddressResolver = (raw: string, path: string) => number;

const OPTIONAL_KEYS: Record<ConditionType, readonly string[]> = {
  equals: ["address", "bytes"],
  not_equals: ["address", "bytes"],
  masked: ["address", "mask", "value"],
  range: ["address", "min", "max", "width", "signed", "endian"],
  threshold: ["address", "comparison", "value", "width", "signed", "endian"],
  changed: ["address", "length"],
  screen_text: ["text", "present", "caseInsensitive"],
  screen_changed: [],
  checkpoint: ["address", "kind"],
};

function fail(message: string, path: string, details?: Record<string, unknown>): never {
  throw new ToolValidationError(message, { path, ...(details ? { details } : {}) });
}

export function hex(value: number, digits = 2): string {
  return `$${value.toString(16).toUpperCase().padStart(digits, "0")}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  return `$${Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Integer from a JSON number or a numeric literal string ($FF, 0xFF, %1010, decimal, optionally negative). */
function parseInteger(raw: unknown, path: string, what: string): number {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) fail(`${what} must be an integer`, path, { received: raw });
    return raw;
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    const negative = text.startsWith("-");
    const literal = parseNumericLiteral(negative ? text.slice(1) : text, path);
    if (literal === undefined) {
      fail(`${what} must be a number or a numeric literal such as $FF, 0xFF or 255; bare hexadecimal needs a prefix`, path, { received: raw });
    }
    return negative ? -literal : literal;
  }
  return fail(`${what} must be a number or a numeric literal string`, path, { received: raw });
}

function parseAddress(raw: unknown, path: string, resolve: AddressResolver): number {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) fail("Address must be an integer in range $0000-$FFFF", path, { received: raw });
    return resolve(String(raw), path);
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    fail("address is required: $HHHH, decimal, a loaded program label or a documented name", path);
  }
  const address = resolve(raw as string, path);
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) fail("Address must be in range $0000-$FFFF", path, { received: raw });
  return address;
}

function requireRange(address: number, length: number, path: string): void {
  if (address + length - 1 > 0xffff) {
    fail(`${path} range exceeds address space; ${hex(address, 4)} + ${length} byte(s) would pass $FFFF`, path);
  }
}

function parseWidth(raw: unknown, path: string): Width {
  if (raw === undefined) fail("width is required: 1, 2 or 4 (bytes)", path);
  if (raw !== 1 && raw !== 2 && raw !== 4) fail("width must be 1, 2 or 4 (bytes)", path, { allowed: [1, 2, 4], received: raw });
  return raw;
}

function parseBoolean(raw: unknown, path: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") fail("must be true or false", path, { received: raw });
  return raw as boolean;
}

function parseNumericSpec(rec: Record<string, unknown>, base: string): NumericSpec {
  const width = parseWidth(rec.width, `${base}.width`);
  const signed = parseBoolean(rec.signed, `${base}.signed`, false);
  const endian = rec.endian === undefined ? "little" : rec.endian;
  if (endian !== "little" && endian !== "big") fail('endian must be "little" or "big"', `${base}.endian`, { allowed: ["little", "big"], received: endian });
  return { width, signed, endian };
}

export function numericBounds(spec: Pick<NumericSpec, "width" | "signed">): { min: number; max: number } {
  const bits = spec.width * 8;
  return spec.signed ? { min: -(2 ** (bits - 1)), max: 2 ** (bits - 1) - 1 } : { min: 0, max: 2 ** bits - 1 };
}

function parseBounded(raw: unknown, path: string, what: string, spec: NumericSpec): number {
  const value = parseInteger(raw, path, what);
  const { min, max } = numericBounds(spec);
  if (value < min || value > max) {
    fail(`${what} ${value} does not fit ${spec.width * 8} bit ${spec.signed ? "signed" : "unsigned"} (${min}..${max})`, path, { minimum: min, maximum: max, received: value });
  }
  return value;
}

/**
 * Validates a raw `condition` argument and resolves its address through `resolveAddress`.
 * Throws ToolValidationError with the path of the first offending field (for example `$.condition.width`).
 */
export function parseCondition(raw: unknown, resolveAddress: AddressResolver, base = "$.condition"): Condition {
  if (!isRecord(raw)) return fail("condition must be an object with a type", base);
  const type = raw.type;
  if (type === undefined) fail(`type is required; one of ${CONDITION_TYPES.join(", ")}`, `${base}.type`, { allowed: [...CONDITION_TYPES] });
  if (typeof type !== "string" || !(CONDITION_TYPES as readonly string[]).includes(type)) {
    fail(`Unknown condition type ${JSON.stringify(type)}; use one of ${CONDITION_TYPES.join(", ")}`, `${base}.type`, { allowed: [...CONDITION_TYPES], received: type });
  }
  const kind = type as ConditionType;
  const allowedKeys = new Set(["type", ...OPTIONAL_KEYS[kind]]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`Unknown property "${key}" for condition type ${kind}; allowed: ${[...allowedKeys].join(", ")}`, `${base}.${key}`);
  }
  const addr = () => parseAddress(raw.address, `${base}.address`, resolveAddress);

  switch (kind) {
    case "equals":
    case "not_equals": {
      const address = addr();
      if (typeof raw.bytes !== "string") return fail('bytes is required: a hex string such as "$A9 00"', `${base}.bytes`);
      const cleaned = stripHexByteSeparators(raw.bytes).toUpperCase();
      if (cleaned.length === 0) fail("bytes must not be empty", `${base}.bytes`);
      if (!/^[0-9A-F]+$/.test(cleaned)) fail("bytes contains non-hexadecimal characters", `${base}.bytes`, { received: raw.bytes });
      if (cleaned.length % 2 !== 0) fail("bytes must have an even number of hex digits", `${base}.bytes`, { received: raw.bytes });
      const bytes = Uint8Array.from(cleaned.match(/../g)!, (pair) => Number.parseInt(pair, 16));
      if (bytes.length > MAX_COMPARE_BYTES) fail(`bytes is at most ${MAX_COMPARE_BYTES} bytes`, `${base}.bytes`, { maximum: MAX_COMPARE_BYTES });
      requireRange(address, bytes.length, `${base}.address`);
      return { type: kind, address, bytes };
    }
    case "masked": {
      const address = addr();
      const byte: NumericSpec = { width: 1, signed: false, endian: "little" };
      const mask = parseBounded(raw.mask, `${base}.mask`, "mask", byte);
      const value = parseBounded(raw.value, `${base}.value`, "value", byte);
      if ((value & ~mask & 0xff) !== 0) {
        fail(`value ${hex(value)} has bits outside mask ${hex(mask)}; the condition could never be met`, `${base}.value`);
      }
      return { type: kind, address, mask, value };
    }
    case "range": {
      const address = addr();
      const spec = parseNumericSpec(raw, base);
      requireRange(address, spec.width, `${base}.address`);
      const min = parseBounded(raw.min, `${base}.min`, "min", spec);
      const max = parseBounded(raw.max, `${base}.max`, "max", spec);
      if (min > max) fail(`min ${min} is greater than max ${max}`, `${base}.min`);
      return { type: kind, address, min, max, ...spec };
    }
    case "threshold": {
      const address = addr();
      const spec = parseNumericSpec(raw, base);
      requireRange(address, spec.width, `${base}.address`);
      const comparison = raw.comparison;
      if (comparison !== "gt" && comparison !== "gte" && comparison !== "lt" && comparison !== "lte") {
        fail("comparison must be gt, gte, lt or lte", `${base}.comparison`, { allowed: ["gt", "gte", "lt", "lte"], received: comparison });
      }
      const value = parseBounded(raw.value, `${base}.value`, "value", spec);
      return { type: kind, address, comparison: comparison as Comparison, value, ...spec };
    }
    case "changed": {
      const address = addr();
      if (raw.length === undefined) fail(`length is required: 1..${MAX_COMPARE_BYTES} bytes`, `${base}.length`);
      const length = parseInteger(raw.length, `${base}.length`, "length");
      if (length < 1 || length > MAX_COMPARE_BYTES) fail(`length must be 1..${MAX_COMPARE_BYTES}`, `${base}.length`, { minimum: 1, maximum: MAX_COMPARE_BYTES, received: length });
      requireRange(address, length, `${base}.address`);
      return { type: kind, address, length };
    }
    case "screen_text": {
      if (typeof raw.text !== "string") return fail("text is required: the text to look for on the screen", `${base}.text`);
      if (raw.text.length < 1 || raw.text.length > MAX_SCREEN_TEXT_LENGTH) fail(`text must be 1..${MAX_SCREEN_TEXT_LENGTH} characters`, `${base}.text`, { minLength: 1, maxLength: MAX_SCREEN_TEXT_LENGTH });
      return {
        type: kind,
        text: raw.text,
        present: parseBoolean(raw.present, `${base}.present`, true),
        caseInsensitive: parseBoolean(raw.caseInsensitive, `${base}.caseInsensitive`, true),
      };
    }
    case "screen_changed":
      return { type: kind };
    case "checkpoint": {
      const address = addr();
      const access = raw.kind === undefined ? "exec" : raw.kind;
      if (access !== "exec" && access !== "load" && access !== "store") fail("kind must be exec, load or store", `${base}.kind`, { allowed: ["exec", "load", "store"], received: access });
      return { type: kind, address, kind: access };
    }
  }
}

/** What an iteration must read for this condition. */
export function readPlan(condition: Condition): ReadTarget {
  switch (condition.type) {
    case "equals":
    case "not_equals":
      return { kind: "memory", address: condition.address, length: condition.bytes.length };
    case "masked":
      return { kind: "memory", address: condition.address, length: 1 };
    case "range":
    case "threshold":
      return { kind: "memory", address: condition.address, length: condition.width };
    case "changed":
      return { kind: "memory", address: condition.address, length: condition.length };
    case "screen_text":
    case "screen_changed":
      return { kind: "screen" };
    case "checkpoint":
      return { kind: "checkpoint", address: condition.address, access: condition.kind };
  }
}

/** JSON form of a read target for the result. */
export function describeTarget(target: ReadTarget): Record<string, unknown> {
  switch (target.kind) {
    case "memory": return { type: "memory", address: hex(target.address, 4), length: target.length };
    case "screen": return { type: "screen" };
    case "checkpoint": return { type: "checkpoint", address: hex(target.address, 4), kind: target.access };
  }
}

/** Decodes a 1, 2 or 4 byte integer; 4-byte values stay exact because no bitwise operators are used. */
export function decodeInteger(bytes: Uint8Array, spec: NumericSpec): number {
  let value = 0;
  for (let i = 0; i < spec.width; i += 1) {
    const byte = bytes[spec.endian === "little" ? spec.width - 1 - i : i] ?? 0;
    value = value * 256 + byte;
  }
  const bits = spec.width * 8;
  return spec.signed && value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function needBytes(observation: Observation): Uint8Array {
  if (observation.kind !== "bytes") throw new Error(`Condition needs a bytes observation, got ${observation.kind}`);
  return observation.bytes;
}

function needScreen(observation: Observation): string {
  if (observation.kind !== "screen") throw new Error(`Condition needs a screen observation, got ${observation.kind}`);
  return observation.text;
}

const COMPARE_TEXT: Record<Comparison, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * Evaluates a condition against one observation. `initial` is the first observation of the wait; `changed` and
 * `screen_changed` compare against it, so they are never met by the first iteration.
 */
export function evaluate(condition: Condition, observation: Observation, initial: Observation): Evaluation {
  switch (condition.type) {
    case "equals":
    case "not_equals": {
      const bytes = needBytes(observation);
      const equal = sameBytes(bytes, condition.bytes);
      const wanted = bytesToHex(condition.bytes);
      return {
        met: condition.type === "equals" ? equal : !equal,
        expected: condition.type === "equals" ? `equals ${wanted}` : `differs from ${wanted}`,
        observed: bytesToHex(bytes),
      };
    }
    case "masked": {
      const byte = needBytes(observation)[0] ?? 0;
      return {
        met: (byte & condition.mask) === condition.value,
        expected: `(byte & ${hex(condition.mask)}) == ${hex(condition.value)}`,
        observed: hex(byte),
      };
    }
    case "range": {
      const value = decodeInteger(needBytes(observation), condition);
      return { met: value >= condition.min && value <= condition.max, expected: `${condition.min} <= value <= ${condition.max}`, observed: value };
    }
    case "threshold": {
      const value = decodeInteger(needBytes(observation), condition);
      const met = condition.comparison === "gt" ? value > condition.value
        : condition.comparison === "gte" ? value >= condition.value
          : condition.comparison === "lt" ? value < condition.value
            : value <= condition.value;
      return { met, expected: `value ${COMPARE_TEXT[condition.comparison]} ${condition.value}`, observed: value };
    }
    case "changed": {
      const bytes = needBytes(observation);
      const first = needBytes(initial);
      return { met: !sameBytes(bytes, first), expected: `differs from initial ${bytesToHex(first)}`, observed: bytesToHex(bytes) };
    }
    case "screen_text": {
      const text = needScreen(observation);
      const found = condition.caseInsensitive ? text.toLowerCase().includes(condition.text.toLowerCase()) : text.includes(condition.text);
      return {
        met: found === condition.present,
        expected: `screen ${condition.present ? "contains" : "does not contain"} ${JSON.stringify(condition.text)}${condition.caseInsensitive ? " (case-insensitive)" : ""}`,
        observed: text,
      };
    }
    case "screen_changed": {
      const text = needScreen(observation);
      return { met: text !== needScreen(initial), expected: "screen differs from the initial screen", observed: text };
    }
    case "checkpoint": {
      if (observation.kind !== "hits") throw new Error(`Condition needs a hits observation, got ${observation.kind}`);
      return { met: observation.count > 0, expected: `checkpoint ${condition.kind} at ${hex(condition.address, 4)} hit at least once`, observed: observation.count };
    }
  }
}

import { hasRegisteredSecrets, redactResultText, redactResultValue, redactValue } from "../redact.js";
import type { ToolRunResult } from "../tools/types.js";

/** Above this many bytes of text, long strings that the text already carries are not sent again in structuredContent. */
export const LARGE_RESULT_TEXT_BYTES = 16 * 1024;
/** Strings at least this long are replaced by a note in structuredContent of a large result. */
const ELIDED_STRING_CHARS = 512;
/** A string value at least this long that the message already contains is not repeated after it. */
const REPEATED_VALUE_CHARS = 16;
/** Keys a text result's message already expresses: success through isError, error through the message itself. */
const IMPLIED_KEYS = new Set(["message", "success", "error"]);

type WireResult = {
  content: ToolRunResult["content"];
  structuredContent?: ToolRunResult["structuredContent"];
  metadata?: ToolRunResult["metadata"];
  isError?: boolean;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ToolRunResult.metadata is not an MCP result field, and textResult already copies
// it into structuredContent.data. Keys whose value is already present in
// structuredContent.data are not sent again; forwarding the whole object sent every
// payload (for example the hex of a memory read) an extra time. Keys that
// structuredContent does not carry (small flags and counts from jsonResult) are kept.
function metadataNotInStructuredContent(
  metadata: Record<string, unknown>,
  structured: ToolRunResult["structuredContent"],
): Record<string, unknown> {
  const data = structured?.data;
  const record = isPlainRecord(data) ? data : {};
  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key in record && JSON.stringify(record[key]) === JSON.stringify(value)) continue;
    remaining[key] = value;
  }
  return remaining;
}

/**
 * D2: the text block is self-sufficient. A text result (structured data `{ message, ...data }` whose
 * message is the text) gets the data beyond the message appended as compact JSON, without values the
 * message already shows and without `success` and `error`, which the message and isError carry.
 */
function selfSufficientContent(result: ToolRunResult): ToolRunResult["content"] {
  const data = result.structuredContent?.data;
  const first = result.content[0];
  if (!isPlainRecord(data) || first?.type !== "text" || data.message !== first.text) {
    return result.content;
  }
  const message = first.text;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (IMPLIED_KEYS.has(key) || value === undefined) continue;
    if (typeof value === "string" && value.length >= REPEATED_VALUE_CHARS && message.includes(value)) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length === 0) return result.content;
  return [{ type: "text", text: `${message}\n${JSON.stringify(extra)}` }, ...result.content.slice(1)];
}

function textOf(content: ToolRunResult["content"]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * A large payload is sent once: when the text exceeds LARGE_RESULT_TEXT_BYTES, every long string of
 * structuredContent that the text already contains is replaced by a note saying where it is.
 * Strings the text does not contain stay, so nothing is lost.
 */
function elideLargePayloads(value: unknown, text: string): unknown {
  if (typeof value === "string") {
    if (value.length < ELIDED_STRING_CHARS) return value;
    const inText = text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1));
    return inText ? `[${value.length} characters, sent once in the text content]` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => elideLargePayloads(entry, text));
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, elideLargePayloads(entry, text)]));
  }
  return value;
}

/**
 * Successful results are redacted per string leaf, whole-word for short secrets. The text of a JSON
 * block is parsed and regenerated from the redacted value, and is kept byte for byte when nothing
 * changed. Image blocks are never altered. Error text that is not JSON uses substring redaction.
 */
function redactContent(content: ToolRunResult["content"], isError: boolean): ToolRunResult["content"] {
  return content.map((block) => {
    if (block.type !== "text") return block;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      return { ...block, text: isError ? redactValue(block.text) as string : redactResultText(block.text) };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { ...block, text: isError ? redactValue(block.text) as string : redactResultText(block.text) };
    }
    const redacted = redactResultValue(parsed, undefined, { substring: isError });
    return JSON.stringify(redacted) === JSON.stringify(parsed) ? block : { ...block, text: JSON.stringify(redacted) };
  });
}

export function toCallToolResult(result: ToolRunResult): WireResult {
  const composed = selfSufficientContent(result);
  const secrets = hasRegisteredSecrets();
  const base: WireResult = { content: secrets ? redactContent(composed, result.isError === true) : composed };

  if (result.structuredContent !== undefined) {
    const text = textOf(composed);
    const structured = Buffer.byteLength(text) > LARGE_RESULT_TEXT_BYTES
      ? { ...result.structuredContent, data: elideLargePayloads(result.structuredContent.data, text) }
      : result.structuredContent;
    // Structured content is data in both successful and error results (a failed batch carries the
    // successful commands' payloads), so it gets per-leaf redaction that leaves payload fields intact;
    // in error results every other string is redacted by substring, so messages never show a secret.
    base.structuredContent = (secrets
      ? redactResultValue(structured, undefined, { substring: result.isError === true })
      : structured) as ToolRunResult["structuredContent"];
  }
  if (result.metadata !== undefined) {
    const remaining = metadataNotInStructuredContent(result.metadata, result.structuredContent);
    if (Object.keys(remaining).length > 0) {
      base.metadata = (secrets
        ? redactResultValue(remaining, undefined, { substring: result.isError === true })
        : remaining) as ToolRunResult["metadata"];
    }
  }
  if (result.isError !== undefined) {
    base.isError = result.isError;
  }

  return base;
}

import { redactValue } from "../redact.js";
import type { ToolRunResult } from "../tools/types.js";

// ToolRunResult.metadata is internal (used by batch and tests). It is not an MCP
// result field, and textResult already copies it into structuredContent.data,
// so it is not forwarded; forwarding it sent every payload an extra time.
export function toCallToolResult(result: ToolRunResult): {
  content: ToolRunResult["content"];
  structuredContent?: ToolRunResult["structuredContent"];
  isError?: boolean;
} {
  const base: {
    content: ToolRunResult["content"];
    structuredContent?: ToolRunResult["structuredContent"];
    isError?: boolean;
  } = { content: redactValue(result.content) as ToolRunResult["content"] };

  if (result.structuredContent !== undefined) {
    base.structuredContent = redactValue(result.structuredContent) as ToolRunResult["structuredContent"];
  }
  if (result.isError !== undefined) {
    base.isError = result.isError;
  }

  return base;
}

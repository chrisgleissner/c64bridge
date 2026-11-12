/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { ToolValidationError } from "./tools/errors.js";

/**
 * Shared parser for memory address and length arguments.
 *
 * Accepted forms: `$C000`, `0xC000`, `%1010`, and decimal. Returns undefined
 * when the text is not a numeric literal at all, so the caller can try a symbol
 * name next. A decimal with a leading zero (`0400`) is rejected as ambiguous,
 * because it was previously read as decimal 400 although it looks like hex.
 */
export function parseNumericLiteral(raw: string, path?: string): number | undefined {
  const text = raw.trim();
  if (/^\$[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(1), 16);
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^%[01]+$/.test(text)) return Number.parseInt(text.slice(1), 2);
  if (/^[0-9]+$/.test(text)) {
    if (text.length > 1 && text.startsWith("0")) {
      throw new ToolValidationError(
        `Ambiguous number "${text}": a decimal with a leading zero could also be hexadecimal. Write "$${text}" for hex or "${Number.parseInt(text, 10)}" for decimal.`,
        { path },
      );
    }
    return Number.parseInt(text, 10);
  }
  return undefined;
}

/**
 * Throws for a bare string of hex digits that contains A-F (`C000`), which
 * would otherwise be reported as an unknown symbol or an unparsable number.
 * Call it after symbol lookup so names that happen to be hex digits still work.
 */
export function assertNotBareHex(raw: string, path?: string): void {
  const text = raw.trim();
  if (/^[0-9a-f]*[a-f][0-9a-f]*$/i.test(text)) {
    throw new ToolValidationError(
      `Ambiguous value "${text}": hexadecimal needs a prefix. Write "$${text.toUpperCase()}" or "0x${text.toUpperCase()}".`,
      { path },
    );
  }
}

export function formatAddressForMessage(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Validates that an address (and optional length) lies within $0000-$FFFF. */
export function assertAddressRange(address: number, length: number | undefined, path?: string): void {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new ToolValidationError("Address must be in range $0000-$FFFF", { path });
  }
  if (length !== undefined && address + length - 1 > 0xffff) {
    throw new ToolValidationError(
      `Memory range ${formatAddressForMessage(address)} + ${length} bytes passes $FFFF`,
      { path },
    );
  }
}

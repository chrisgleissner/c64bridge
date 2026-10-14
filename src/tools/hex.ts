/**
 * Normalise a user-supplied hex byte string such as "$A9 $00", "A9_00" or
 * "$A900" to bare hex digits. A "$" may prefix the whole string or each
 * whitespace-separated byte group; whitespace and "_" separators are removed.
 * The result is not validated, so callers still check length and digits.
 */
export function stripHexByteSeparators(input: string): string {
  return input.trim().replace(/(^|\s)\$/g, "$1").replace(/[\s_]/g, "");
}

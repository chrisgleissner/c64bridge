import { ToolValidationError } from "./tools/errors.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function decodedForms(segment: string): string[] {
  const forms = [segment];
  try {
    forms.push(decodeURIComponent(segment));
  } catch {
    // A malformed escape stays literal; encodeURIComponent turns the "%" into "%25".
  }
  return forms;
}

function checkSegment(segment: string, label: string, path: string): void {
  for (const form of decodedForms(segment)) {
    if (form === "." || form === "..") {
      throw new ToolValidationError(`${label} must not contain a "." or ".." segment`, { path });
    }
    if (CONTROL_CHARACTERS.test(form)) {
      throw new ToolValidationError(`${label} must not contain control characters`, { path });
    }
  }
}

/**
 * Configuration category and item names become one REST path segment each. They must not be a
 * dot segment, contain control characters (also percent-encoded) or a backslash. A category must
 * not contain "/" either; the firmware names an item such as "Bus Sharing - I/O1" with one, which
 * is sent as %2F inside a single segment.
 */
export function assertSafeConfigName(value: string, kind: "category" | "item"): void {
  const label = `Configuration ${kind} name`;
  const path = kind;
  if (value.length === 0) {
    throw new ToolValidationError(`${label} must not be empty`, { path });
  }
  checkSegment(value, label, path);
  for (const form of decodedForms(value)) {
    if (form.includes("\\") || (kind === "category" && form.includes("/"))) {
      throw new ToolValidationError(`${label} must not contain ${kind === "category" ? "a slash or a backslash" : "a backslash"}`, { path });
    }
  }
}

/** Device file paths: "/" separates segments; empty inner, "." and ".." segments and control characters are rejected. */
export function assertSafeDevicePath(value: string, label = "Device path"): void {
  const segments = value.split("/");
  const firstNamed = segments.findIndex((segment) => segment !== "");
  segments.forEach((segment, index) => {
    // Leading separators ("/Usb0", "//USB0") and a trailing one are accepted; an empty inner segment is not.
    const edge = index < firstNamed || index === segments.length - 1;
    if (segment === "" && !edge) {
      throw new ToolValidationError(`${label} must not contain an empty segment`, { path: "path" });
    }
    checkSegment(segment, label, "path");
  });
}

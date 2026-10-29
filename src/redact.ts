/**
 * Shared redaction for the Ultimate network password and other credentials.
 *
 * The password is meant to leave the process only as the `X-Password` request
 * header. Every sink that can carry arbitrary values (console logging,
 * diagnostics files, MCP tool results) passes its content through this module.
 *
 * Two mechanisms are combined:
 * - values registered with `registerSecret` are replaced wherever they appear
 *   inside a string, including error messages and stack traces;
 * - properties whose name is a credential header are replaced regardless of value.
 */

const REDACTED = "***";
const SENSITIVE_KEY = /^(x-password|authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
const MIN_SECRET_LENGTH = 1;

const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
    secrets.add(value);
  }
}

/** Test hook: forget all registered secrets. */
export function clearRegisteredSecrets(): void {
  secrets.clear();
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactText(text: string): string {
  let result = text;
  // Longest first, so a secret that contains another one is replaced as a whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (result.includes(secret)) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a copy of `value` that is safe to log, persist or return to a client.
 * Errors (including Axios errors) are reduced to name, message, stack, code and
 * HTTP status, so their request configuration is never copied.
 */
export function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Error) {
    seen.add(value);
    const extra = value as Error & { code?: unknown; cause?: unknown; response?: { status?: unknown } };
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
      ...(extra.code !== undefined ? { code: redactValue(extra.code, seen) } : {}),
      ...(extra.response?.status !== undefined ? { status: extra.response.status } : {}),
      ...(extra.cause !== undefined ? { cause: redactValue(extra.cause, seen) } : {}),
    };
  }
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((entry) => redactValue(entry, seen));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      redactText(key),
      isSensitiveKey(key) ? REDACTED : redactValue(entry, seen),
    ]),
  );
}

function scrubHeaders(headers: unknown): void {
  if (!headers || typeof headers !== "object") return;
  for (const key of Object.keys(headers)) {
    if (isSensitiveKey(key)) {
      (headers as Record<string, unknown>)[key] = REDACTED;
    }
  }
}

function scrubRequestHolder(holder: unknown): void {
  if (!holder || typeof holder !== "object") return;
  const target = holder as { config?: { headers?: unknown }; request?: unknown };
  scrubHeaders(target.config?.headers);
  // The raw ClientRequest keeps the serialized header block, including X-Password.
  if (target.request !== undefined) {
    target.request = undefined;
  }
}

/**
 * Removes credentials from a rejected Axios error in place and returns it, so
 * callers that inspect, log or serialize the error cannot expose them.
 * Status, code, message and response data stay available.
 */
export function scrubRequestError<T>(error: T): T {
  if (!error || typeof error !== "object") return error;
  scrubRequestHolder(error);
  const response = (error as { response?: { data?: unknown } }).response;
  scrubRequestHolder(response);
  // A device that echoes the rejected password in its error body.
  if (response && typeof response.data === "string") {
    response.data = redactText(response.data);
  }
  return error;
}

/**
 * Firmware configuration items that hold credentials. The Ultimate config API
 * lists items by display name (for example "Network Password" in the
 * "Network settings" category), so matching is by item name: passwords,
 * passphrases and pre-shared keys, plus a bare "key" item in a Wi-Fi category.
 */
const SENSITIVE_CONFIG_ITEM = /pass(word|wd|phrase|code)?\b|\bpsk\b|secret/i;
const WIFI_CATEGORY = /wi-?fi|wlan|wireless/i;
const BARE_KEY_ITEM = /^(wifi |wlan )?(key|wpa key|network key)$/i;

export function isSensitiveConfigItem(category: string | undefined, item: string | undefined): boolean {
  if (!item) return false;
  if (SENSITIVE_CONFIG_ITEM.test(item)) return true;
  return BARE_KEY_ITEM.test(item.trim()) && (item.toLowerCase().includes("wifi") || WIFI_CATEGORY.test(category ?? ""));
}

/**
 * Returns a copy of a firmware configuration response in which the value of
 * every credential item is replaced with `***`. Item names stay, so a client can
 * see that the item exists. `category` and `item` describe the request: when an
 * item was requested and the response is its bare value, the value is replaced.
 */
export function redactConfigValue(value: unknown, category?: string, item?: string): unknown {
  if (item && isSensitiveConfigItem(category, item)) {
    return value !== null && typeof value === "object" ? redactConfigTree(value, category) : REDACTED;
  }
  return redactConfigTree(value, category);
}

function redactConfigTree(value: unknown, category: string | undefined): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfigTree(entry, category));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveConfigItem(category, key) && entry !== null && entry !== undefined) {
      out[key] = REDACTED;
    } else {
      // Keys at the top level of a response are category names.
      out[key] = redactConfigTree(entry, entry !== null && typeof entry === "object" && !Array.isArray(entry) ? key : category);
    }
  }
  return out;
}

export const REDACTED_PLACEHOLDER = REDACTED;

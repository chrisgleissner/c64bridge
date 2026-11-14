/**
 * Which VICE resources may be read or written through the MCP tools.
 * Shared by c64_vice and by c64_config on the VICE backend, so neither path
 * can reach a resource the other refuses (several VICE resources hold host
 * file names).
 */
export const RESOURCE_NAME_PATTERN = /^[A-Z][A-Za-z0-9_.-]{0,63}$/;

export const SAFE_RESOURCE_PREFIXES = [
  "C64",
  "Machine",
  "Sid",
  "VIC",
  "VICII",
  "CIA",
  "Joy",
  "Sound",
  "Warp", // WarpMode: a plain on/off switch
] as const;

// VICE looks resource names up case-insensitively, so every test below compares lower-cased names.
/** Resources that name host files or directories, even under a safe prefix (for example SoundRecordDeviceArg). */
const HOST_FILE_RESOURCE_PATTERN = /(file|filename|image|dir|directory|path|arg|name|log|command|cmd|dev)\d*$/;

export type ResourceNameProblem =
  | { readonly kind: "pattern"; readonly message: string }
  | { readonly kind: "prefix"; readonly message: string }
  | { readonly kind: "host_file"; readonly message: string };

/** Returns why a resource name is refused, or undefined when it is allowed. */
export function resourceNameProblem(name: string): ResourceNameProblem | undefined {
  if (!RESOURCE_NAME_PATTERN.test(name)) {
    return {
      kind: "pattern",
      message: "Resource names must start with an uppercase letter and use letters, numbers, dashes, underscores, or periods.",
    };
  }
  if (!SAFE_RESOURCE_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix.toLowerCase()))) {
    return { kind: "prefix", message: `Resource name must start with one of: ${SAFE_RESOURCE_PREFIXES.join(", ")}` };
  }
  if (HOST_FILE_RESOURCE_PATTERN.test(name.toLowerCase())) {
    return { kind: "host_file", message: `Resource '${name}' refers to a host file or directory and cannot be accessed through this tool.` };
  }
  return undefined;
}

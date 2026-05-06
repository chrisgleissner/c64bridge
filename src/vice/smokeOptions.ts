export interface ViceSmokeOptions {
  useMock: boolean;
  configuredPort: number;
  hasExplicitPort: boolean;
  visible: boolean;
  keepOpen: boolean;
  warp: boolean;
  display: string;
  visibleDemo: boolean;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function parseEnvBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

export function resolveViceSmokeOptions(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): ViceSmokeOptions {
  const visibleDemo = argv.includes("--visible-demo") || parseEnvBoolean(env.VICE_VISIBLE_DEMO) === true;
  const useMock = String(env.VICE_TEST_TARGET ?? "").trim().toLowerCase() === "mock";
  const configuredPort = Number(env.VICE_PORT || 6502);
  const hasExplicitPort = typeof env.VICE_PORT === "string" && env.VICE_PORT.trim().length > 0;
  const visible = visibleDemo || parseEnvBoolean(env.VICE_VISIBLE) === true;
  const keepOpen = visibleDemo || parseEnvBoolean(env.VICE_KEEP_OPEN) === true;
  const warpSetting = parseEnvBoolean(env.VICE_WARP);

  return {
    useMock,
    configuredPort,
    hasExplicitPort,
    visible,
    keepOpen,
    warp: useMock ? true : visibleDemo ? false : warpSetting ?? true,
    display: env.DISPLAY || ":99",
    visibleDemo,
  };
}
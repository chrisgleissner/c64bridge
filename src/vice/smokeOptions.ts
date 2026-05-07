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

function parseVicePort(value: string | undefined): { configuredPort: number; hasExplicitPort: boolean } {
  const normalized = value?.trim();
  if (!normalized) {
    return { configuredPort: 6502, hasExplicitPort: false };
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return { configuredPort: 6502, hasExplicitPort: false };
  }

  return { configuredPort: parsed, hasExplicitPort: true };
}

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
  const { configuredPort, hasExplicitPort } = parseVicePort(env.VICE_PORT);
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
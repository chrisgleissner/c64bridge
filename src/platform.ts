import type { ToolDescriptor } from "./tools/types.js";

export type PlatformId = "c64u" | "u2" | "vice";

export interface PlatformStatus {
  readonly id: PlatformId;
  readonly features: readonly string[];
  readonly limitedFeatures: readonly string[];
}

const PLATFORM_FEATURES: Record<PlatformId, { features: readonly string[]; limited: readonly string[] }> = {
  c64u: {
    features: [
      "ultimate-rest-api",
      "hardware-execution",
      "sid-control",
      "drive-management",
      "printer-integration",
      "streaming",
    ],
    limited: [],
  },
  u2: {
    features: ["ultimate-rest-api", "cartridge-execution", "sid-control", "drive-management", "printer-integration"],
    limited: ["no-machine-input", "no-debugreg", "no-poweroff", "no-streaming"],
  },
  vice: {
    features: [
      "software-emulation",
      "binary-monitor",
      "memory-io",
      "screen-capture",
      "system-control",
      "drive-management",
      "runtime-config",
    ],
    limited: ["no-rest-api", "no-firmware-filesystem", "no-flash-config", "limited-sid"],
  },
};

let currentPlatform: PlatformId = process.env.C64_MODE === "vice" ? "vice" : process.env.C64_MODE === "u2" ? "u2" : "c64u";

export function getPlatformStatus(): PlatformStatus {
  const spec = PLATFORM_FEATURES[currentPlatform];
  return {
    id: currentPlatform,
    features: spec.features,
    limitedFeatures: spec.limited,
  };
}

export function setPlatform(target: PlatformId): PlatformStatus {
  if (!PLATFORM_FEATURES[target]) {
    throw new Error(`Unsupported platform id: ${target}`);
  }
  currentPlatform = target;
  return getPlatformStatus();
}

export function isPlatformSupported(
  platform: PlatformId,
  supported?: readonly PlatformId[] | undefined,
): boolean {
  if (!supported || supported.length === 0) {
    return true;
  }
  return supported.includes(platform);
}

export function describePlatformCapabilities(tools: readonly ToolDescriptor[]) {
  const map: Record<PlatformId, { available: string[]; unsupported: string[] }> = {
    c64u: { available: [], unsupported: [] },
    u2: { available: [], unsupported: [] },
    vice: { available: [], unsupported: [] },
  };

  for (const tool of tools) {
    const supported = tool.metadata.platforms ?? ["c64u"];
    for (const id of ["c64u", "u2", "vice"] as const) {
      if (supported.includes(id)) {
        map[id].available.push(tool.name);
      } else {
        map[id].unsupported.push(tool.name);
      }
    }
  }

  return {
    platforms: {
      c64u: {
        features: PLATFORM_FEATURES.c64u.features,
        limited_features: PLATFORM_FEATURES.c64u.limited,
        tools: map.c64u.available.sort(),
        unsupported_tools: map.c64u.unsupported.sort(),
      },
      u2: {
        features: PLATFORM_FEATURES.u2.features,
        limited_features: PLATFORM_FEATURES.u2.limited,
        tools: map.u2.available.sort(),
        unsupported_tools: map.u2.unsupported.sort(),
      },
      vice: {
        features: PLATFORM_FEATURES.vice.features,
        limited_features: PLATFORM_FEATURES.vice.limited,
        tools: map.vice.available.sort(),
        unsupported_tools: map.vice.unsupported.sort(),
      },
    },
  } as const;
}

export function getAllPlatformStatuses(): readonly PlatformStatus[] {
  return (Object.keys(PLATFORM_FEATURES) as PlatformId[]).map((id) => {
    const spec = PLATFORM_FEATURES[id];
    return {
      id,
      features: spec.features,
      limitedFeatures: spec.limited,
    } satisfies PlatformStatus;
  });
}

import type { C64Facade, ViceBackend } from "./device.js";
import { isModern, type ParsedSidwave } from "./sidwave.js";
import { normalizeConfigInventory } from "./tools/meta/configInventory.js";
import { ToolValidationError } from "./tools/errors.js";

type Settings = Record<string, Record<string, string | number>>;
const ADDRESSING = "SID Addressing";
const SOCKETS = "SID Sockets Configuration";
const MIXER = "Audio Mixer";
const SID_STORES = [ADDRESSING, SOCKETS, MIXER, "UltiSID Configuration"];
const DECODERS = ["UltiSID 1", "UltiSID 2", "Socket 1", "Socket 2"];
/** Wait after a socket switch with the mixer channel closed before reopening it (measured: 1 s is silent). */
export const SOCKET_SETTLE_MS = 1000;
const OWNER_WINDOWS = [[0xd400, 0xd480, 0xd500, 0xd580], [0xd420, 0xd4a0, 0xd520, 0xd5a0], [0xd440], [0xd460]];
const hex = (address: number) => `$${address.toString(16).toUpperCase()}`;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function sidwaveNeedsMap(doc: ParsedSidwave): boolean {
  return doc.sids.length > 1 || doc.sids[0]!.address !== 0xd400 || doc.sids.some((sid) => sid.pan !== undefined);
}

function ultimateMap(doc: ParsedSidwave): Settings {
  const addresses = doc.sids.map((sid) => sid.address);
  // See data/ultimate/multisid.md, Owner configurations. Also support subsets
  // of the split map and arbitrary maps that fit the four unsplit decoders.
  const split = addresses.every((address) => OWNER_WINDOWS.some((windows) => windows.includes(address))) &&
    addresses.some((address) => OWNER_WINDOWS.slice(0, 2).some((windows) => windows.slice(1).includes(address)));
  if (!split && addresses.length > 4) {
    throw new ToolValidationError("This explicit SID map requires a manual Ultimate decoder setup. Use an ultisid8 layout or up to four unsplit SIDs.", { path: "$.sids" });
  }
  const groups = split ? OWNER_WINDOWS : addresses.map((address) => [address]);
  const bases = DECODERS.map((_, index) => groups[index]?.some((address) => addresses.includes(address)) ? groups[index]![0] : undefined);
  const map: Settings = {
    [ADDRESSING]: {
      "Auto Address Mirroring": "Disabled",
      "UltiSID Range Split": split ? "1/4 (A7,A8)" : "Off",
      "UltiSID 1 Address": bases[0] === undefined ? "Unmapped" : hex(bases[0]),
      "UltiSID 2 Address": bases[1] === undefined ? "Unmapped" : hex(bases[1]),
      "SID Socket 1 Address": bases[2] === undefined ? "Unmapped" : hex(bases[2]),
      "SID Socket 2 Address": bases[3] === undefined ? "Unmapped" : hex(bases[3]),
      "Ext DualSID Range Split": "Off",
    },
  };
  for (const index of [2, 3]) {
    if (bases[index] !== undefined) (map[SOCKETS] ??= {})[`SID Socket ${index - 1}`] = "Enabled";
  }
  for (const { address, pan } of doc.sids) {
    if (!pan) continue;
    const name = `Pan ${DECODERS[groups.findIndex((group) => group.includes(address))]}`;
    const mixer = map[MIXER] ??= {};
    if (mixer[name] !== undefined && mixer[name] !== pan) {
      throw new ToolValidationError(`Parts of one UltiSID share its mixer pan. Conflicting values for ${name}.`, { path: "$.sids" });
    }
    mixer[name] = pan;
  }
  return map;
}

export function sidwaveSetupWarnings(doc: ParsedSidwave, backend: string): string[] {
  const warnings: string[] = [];
  if (backend !== "vice" && sidwaveNeedsMap(doc)) {
    try {
      const map = ultimateMap(doc);
      const settings = Object.entries(map).map(([store, items]) =>
        `${store}: ${Object.entries(items).map(([name, value]) => `${name}=${value}`).join(", ")}`);
      warnings.push(`Match the device SID map before playback. ${settings.join(". ")}.`);
    } catch (error) {
      warnings.push(`Match the device SID map to ${doc.sids.map((sid) => hex(sid.address)).join(", ")}. ${(error as Error).message}`);
    }
  }
  const models = [...new Set(doc.sids.flatMap((sid) => sid.model ? [sid.model] : []))];
  if (isModern(doc) && backend !== "vice" && models.length) {
    // data/ultimate/multisid.md, Differences in sound: the curve is set per UltiSID in store UltiSID Configuration.
    warnings.push(`Filter cutoffs in Hz assume the declared SID model. Set the filter curve of each UltiSID (store UltiSID Configuration) to ${models.map((m) => m === "8580" ? "8580 Lo for an 8580" : "6581 for a 6581").join(" and ")}; the player does not change it.`);
  }
  if (doc.cpu === "turbo") {
    warnings.push(backend === "vice"
      ? "VICE does not provide Ultimate Turbo Registers. A score above the stock CPU budget will not start."
      : "Set Turbo Control to U64 Turbo Registers (U64) or C64U Turbo Registers (C64U). The PRG selects the speed.");
  }
  return warnings;
}

export interface SidwaveSetup {
  clearsUltimateSidWindows?: boolean;
  apply(): Promise<void>;
  restore(): Promise<void>;
}

function settingsOf(category: string, response: unknown): Record<string, unknown> {
  const reply = object(response);
  const settings = object(reply?.[category]) ?? reply;
  if (!settings || (Array.isArray(reply?.errors) && reply.errors.length)) {
    throw new Error(`Could not snapshot ${category}`);
  }
  return settings;
}

const ADDRESS_BITS: Record<string, number[]> = {
  Off: [], A5: [5], A6: [6], A7: [7], A8: [8], A9: [9],
};
const settingValue = (entry: unknown) => object(entry)?.current ?? entry;

function sidWindows(settings: Record<string, unknown>): number[] {
  const result: number[] = [];
  for (const [i, name] of ["UltiSID 1", "UltiSID 2", "SID Socket 1", "SID Socket 2"].entries()) {
    const address = String(settingValue(settings[`${name} Address`] ?? ""));
    if (!/^\$d[4-7][02468ace]0$/i.test(address)) continue; // Never clear the cartridge I/O space.
    const value = Number.parseInt(address.slice(1), 16);
    const mode = String(settingValue(settings[i < 2 ? "UltiSID Range Split" : "Ext DualSID Range Split"]));
    const bits = ADDRESS_BITS[mode] ?? [...mode.matchAll(/A([5-9])/g)].map((match) => Number(match[1]));
    let offsets = [0];
    let base = value;
    for (const bit of bits) {
      base &= ~(1 << bit);
      offsets = [...offsets, ...offsets.map((offset) => offset | (1 << bit))];
    }
    result.push(...offsets.map((offset) => base | offset));
  }
  return result.filter((address) => address >= 0xd400 && address <= 0xd7e0);
}

export async function readUltimateSidWindows(facade: C64Facade): Promise<number[]> {
  const configured = await facade.configGet(ADDRESSING).then((response) => sidWindows(settingsOf(ADDRESSING, response))).catch(() => []);
  return configured.length ? configured : [0xd400];
}

export async function clearUltimateSidWindows(facade: C64Facade, bases: readonly number[]): Promise<void> {
  const addresses = [...new Set(bases)].filter((base) => base >= 0xd400 && base <= 0xd7e0 && base % 32 === 0).sort((a, b) => a - b);
  for (let i = 0; i < addresses.length;) {
    const first = addresses[i++]!;
    let last = first;
    while (addresses[i] === last + 0x20) last = addresses[i++]!;
    // $00..$18 are writable. Include inter-window padding only when every
    // window in the DMA write is mapped.
    await facade.writeMemory(first, new Uint8Array(last - first + 0x19));
  }
}

async function prepareUltimate(facade: C64Facade, doc: ParsedSidwave): Promise<SidwaveSetup> {
  const inventory = normalizeConfigInventory(await facade.configsList());
  const categories = [...new Set(inventory.map(({ category }) => category))];
  const plan = facade.type === "c64u" || categories.includes(ADDRESSING) || sidwaveNeedsMap(doc) ? ultimateMap(doc) : {};
  const snapshot = new Map<string, Record<string, unknown>>();
  const read = async (category: string) => {
    let values = snapshot.get(category);
    if (!values) {
      values = settingsOf(category, await facade.configGet(category));
      snapshot.set(category, values);
    }
    return values;
  };
  for (const category of SID_STORES) {
    if (categories.includes(category) || plan[category]) await read(category);
  }
  // A socket decoder only sounds with a chip fitted. The firmware reports the detected chip per socket
  // (Ultimate 64 Elite 3.15a: "SID Detected Socket 1" = "6581" or "None").
  for (const index of [1, 2]) {
    if (plan[SOCKETS]?.[`SID Socket ${index}`] !== "Enabled") continue;
    const detected = (await read(SOCKETS))[`SID Detected Socket ${index}`];
    const chip = String(object(detected)?.current ?? detected ?? "None").trim();
    if (!chip || /^none$/i.test(chip)) {
      throw new ToolValidationError(`This SID map needs SID socket ${index}, but no chip is detected there. Use an ultisid8 layout or addresses inside the UltiSID windows.`, { path: "$.sids" });
    }
  }
  if (doc.cpu === "turbo") {
    // The store name can differ by firmware. Prefer the store reported by item
    // inventory or the known Ultimate names, then inspect the remaining stores.
    const candidates = new Set([
      ...inventory.filter(({ item }) => item === "Turbo Control").map(({ category }) => category),
      ...categories.filter((category) => /specific settings|turbo|clock/i.test(category)),
      ...categories,
    ]);
    let found = false;
    for (const category of candidates) {
      const values = await read(category).catch(() => undefined);
      if (!values) continue;
      if (!("Turbo Control" in values) || !("CPU Speed" in values)) continue;
      const item = await facade.configGet(category, "Turbo Control");
      const details = object(settingsOf(category, item)["Turbo Control"]) ?? object(item);
      const mode: unknown = Array.isArray(details?.values) ? details.values.find((value: unknown) =>
        typeof value === "string" && /Turbo Registers/i.test(value)) : undefined;
      if (typeof mode !== "string") throw new Error(`${category} / Turbo Control has no Turbo Registers mode`);
      // $D031 selects speed in registers mode. Preserve the CPU Speed setting.
      (plan[category] ??= {})["Turbo Control"] = mode;
      found = true;
      break;
    }
    if (!found) throw new Error("This backend has no Turbo Control and CPU Speed store");
  }

  const restore: Settings = {};
  for (const [category, items] of Object.entries(plan)) {
    const values = await read(category);
    for (const name of Object.keys(items)) {
      const original = object(values[name])?.current ?? values[name];
      if (typeof original !== "string" && typeof original !== "number") {
        throw new Error(`Could not snapshot ${category} / ${name}`);
      }
      (restore[category] ??= {})[name] = original;
    }
  }
  const before = snapshot.get(ADDRESSING);
  const oldWindows = before ? sidWindows(before) : [];
  const newWindows = plan[ADDRESSING] ? sidWindows(plan[ADDRESSING]) : [];
  const write = async (settings: Settings, action: string) => {
    if (!Object.keys(settings).length) return;
    const result = await facade.configBatchUpdate(settings);
    if (!result.success) throw new Error(`Could not ${action} SIDWAVE settings: ${JSON.stringify(result.details ?? {})}`);
  };
  // Switching a SID socket on or off with its mixer channel open is heard as a pop: on an Ultimate 64 Elite with a
  // 6581 fitted, 0.71 of full scale on enable and 0.72 on disable, measured through the audio stream. With the
  // channel at OFF the switch is silent, and unmuting 1 s later is silent too (peak 0.001). The 1541ultimate
  // firmware notes the same property of the mixer (software/u64/u64_config.cc, u64_mute_sids): it sits after the
  // point where the SID's DC offset is removed, so closing it is itself silent.
  const mixer = snapshot.get(MIXER) ?? (categories.includes(MIXER) ? await read(MIXER) : undefined);
  const toggledSockets = (settings: Settings, currentOf: (name: string) => unknown) => [1, 2].filter((index) => {
    const next = settings[SOCKETS]?.[`SID Socket ${index}`];
    return next !== undefined && String(next) !== String(currentOf(`SID Socket ${index}`)) && mixer?.[`Vol Socket ${index}`] !== undefined;
  });
  const remap = async (settings: Settings, action: string, from: number[], to: number[], sockets: number[]) => {
    const volumes = Object.fromEntries(sockets.map((index) => [`Vol Socket ${index}`, String(settingValue(mixer![`Vol Socket ${index}`]))]));
    if (sockets.length) await write({ [MIXER]: Object.fromEntries(Object.keys(volumes).map((name) => [name, "OFF"])) }, action);
    if (settings[ADDRESSING]) await clearUltimateSidWindows(facade, from);
    try {
      await write(settings, action);
    } finally {
      if (settings[ADDRESSING]) await clearUltimateSidWindows(facade, to);
      if (sockets.length) {
        await new Promise((resolve) => setTimeout(resolve, SOCKET_SETTLE_MS));
        await write({ [MIXER]: volumes }, action);
      }
    }
  };
  const socketsBefore = snapshot.get(SOCKETS) ?? {};
  return {
    clearsUltimateSidWindows: !!plan[ADDRESSING],
    apply: () => remap(plan, "apply", oldWindows, newWindows, toggledSockets(plan, (name) => settingValue(socketsBefore[name]))),
    restore: () => remap(restore, "restore", newWindows, oldWindows, toggledSockets(restore, (name) => plan[SOCKETS]?.[name])),
  };
}

export function validateViceSidwaveMap(doc: ParsedSidwave): void {
  if (doc.sids.length > 8) {
    throw new ToolValidationError("VICE 3.10 supports at most 8 SIDs", { path: "$.sids" });
  }
  if (!doc.sids.some((sid) => sid.address === 0xd400)) {
    throw new ToolValidationError("VICE requires a primary SID at $D400", { path: "$.sids" });
  }
}

async function prepareVice(facade: ViceBackend, doc: ParsedSidwave): Promise<SidwaveSetup> {
  validateViceSidwaveMap(doc);
  // VICE 3.10 src/sid/sid-cmdline-options.c maps -sidextra to SidStereo
  // and -sidNaddress to SidNAddressStart. Probe the resources before writing.
  const extras = doc.sids.filter(({ address }) => address !== 0xd400);
  const count = "SidStereo";
  const addresses = extras.map(({ address }, index) => [`Sid${index + 2}AddressStart`, address] as const);
  const original = await facade.withMonitor(async (monitor) => {
    const values = new Map<string, string | number>();
    for (const name of [count, ...addresses.map(([name]) => name)]) {
      const { value } = await monitor.resourceGet(name);
      if (typeof value !== "number") throw new Error(`VICE resource ${name} did not report an integer`);
      values.set(name, value);
    }
    return values;
  });
  const write = (entries: ReadonlyArray<readonly [string, string | number]>) => facade.withMonitor(async (monitor) => {
    for (const [name, value] of entries) await monitor.resourceSet(name, value);
  });
  return {
    apply: () => write([...addresses, [count, extras.length]]),
    restore: () => write([...addresses.map(([name]) => [name, original.get(name)!] as const), [count, original.get(count)!]]),
  };
}

export function prepareSidwaveSetup(facade: C64Facade, doc: ParsedSidwave, configure: boolean): Promise<SidwaveSetup | undefined> {
  if (facade.type === "vice") return prepareVice(facade as ViceBackend, doc);
  return configure ? prepareUltimate(facade, doc) : Promise.resolve(undefined);
}

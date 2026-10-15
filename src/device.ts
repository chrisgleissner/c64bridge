/*
 * Unified C64 abstraction and backend selection
 */

import axios from "axios";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { Api } from "../generated/c64/index.js";
import type { InputBatch, InputStateResponse } from "../generated/c64/index.js";
import { createLoggingHttpClient } from "./loggingHttpClient.js";
import { ViceClient } from "./vice/viceClient.js";
import { waitForBasicReady } from "./vice/readiness.js";
import { startViceProcess, type ViceProcessHandle, type ViceProcessOptions } from "./vice/process.js";
import { loadConfig, resolveUltimateEndpoint, type ResolvedUltimateEndpoint } from "./config.js";

export type DeviceType = "c64u" | "u2" | "vice";

export interface RunResult {
  success: boolean;
  details?: unknown;
}

export type MachineInputBatch = {
  readonly events: readonly (
    | { readonly kind: "keyboard"; readonly inputs: readonly string[]; readonly transition: "press" | "release" | "tap" }
    | { readonly kind: "joystick"; readonly port: 1 | 2; readonly inputs: readonly string[]; readonly transition: "press" | "release" | "tap" }
    | { readonly kind: "release_all" }
  )[];
};
export type MachineInputState = InputStateResponse;

export interface C64Facade {
  readonly type: DeviceType;
  ping(): Promise<boolean>;
  // Program runners
  runPrg(prg: Uint8Array | Buffer): Promise<RunResult>;
  /** Load PRG bytes into memory without starting them. */
  loadPrg(prg: Uint8Array | Buffer): Promise<RunResult>;
  loadPrgFile(path: string): Promise<RunResult>;
  runPrgFile(path: string): Promise<RunResult>;
  runCrtFile(path: string): Promise<RunResult>;
  sidplayFile(path: string, songnr?: number): Promise<RunResult>;
  sidplayAttachment(sid: Uint8Array | Buffer, options?: { songnr?: number; songlengths?: Uint8Array | Buffer }): Promise<RunResult>;
  // Memory/register access
  readMemory(address: number, length: number): Promise<Uint8Array>;
  writeMemory(address: number, bytes: Uint8Array): Promise<void>;
  writeMemoryBlocks?(blocks: ReadonlyArray<{ address: number; bytes: Uint8Array }>): Promise<void>;
  // System control
  reset(): Promise<RunResult>;
  reboot(): Promise<RunResult>;
  pause(): Promise<RunResult>;
  resume(): Promise<RunResult>;
  poweroff(): Promise<RunResult>;
  powerCycle(): Promise<RunResult>;
  menuButton(): Promise<RunResult>;
  readMenuScreen(): Promise<Uint8Array>;
  getInputState(): Promise<MachineInputState>;
  sendInputEvents(batch: MachineInputBatch): Promise<MachineInputState>;
  debugregRead(): Promise<{ success: boolean; value?: string; details?: unknown }>;
  debugregWrite(value: string): Promise<{ success: boolean; value?: string; details?: unknown }>;
  version(): Promise<unknown>;
  info(): Promise<unknown>;
  // Drives & files
  drivesList(): Promise<unknown>;
  driveMount(drive: string, imagePath: string, options?: { type?: "d64" | "g64" | "d71" | "g71" | "d81"; mode?: "readwrite" | "readonly" | "unlinked" }): Promise<RunResult>;
  driveRemove(drive: string): Promise<RunResult>;
  driveReset(drive: string): Promise<RunResult>;
  driveOn(drive: string): Promise<RunResult>;
  driveOff(drive: string): Promise<RunResult>;
  driveSetMode(drive: string, mode: "1541" | "1571" | "1581"): Promise<RunResult>;
  driveLoadRom(drive: string, romPath: string): Promise<RunResult>;
  streamStart(stream: "video" | "audio" | "debug", ip: string): Promise<RunResult>;
  streamStop(stream: "video" | "audio" | "debug"): Promise<RunResult>;
  configsList(): Promise<unknown>;
  configGet(category: string, item?: string): Promise<unknown>;
  configSet(category: string, item: string, value: string): Promise<RunResult>;
  configBatchUpdate(payload: Record<string, object>): Promise<RunResult>;
  configLoadFromFlash(): Promise<RunResult>;
  configSaveToFlash(): Promise<RunResult>;
  configResetToDefault(): Promise<RunResult>;
  filesInfo(path: string): Promise<unknown>;
  filesCreateD64(path: string, options?: { tracks?: 35 | 40; diskname?: string }): Promise<RunResult>;
  filesCreateD71(path: string, options?: { diskname?: string }): Promise<RunResult>;
  filesCreateD81(path: string, options?: { diskname?: string }): Promise<RunResult>;
  filesCreateDnp(path: string, tracks: number, options?: { diskname?: string }): Promise<RunResult>;
  modplayFile?(path: string): Promise<RunResult>;
}

/** A resolved C64U/U2 endpoint; host/port/password precedence lives in config.ts. */
export type C64uEndpoint = Pick<ResolvedUltimateEndpoint, "baseUrl" | "networkPassword">;
export interface ViceConfig {
  exe?: string;
  host?: string;
  port?: number | string;
  directory?: string;
  visible?: boolean | string;
  warp?: boolean | string;
  args?: string | string[];
  prewarm?: boolean | string | number;
}
interface BackendConfig {
  /** Present when the config document configures the profile (for c64u, also legacy top-level fields). */
  c64u?: C64uEndpoint;
  u2?: C64uEndpoint;
  vice?: ViceConfig;
  /** loadConfig's endpoint per profile, including env overrides and defaults. */
  endpoints: { c64u: C64uEndpoint; u2: C64uEndpoint };
}

interface ViceLaunchResolutionOptions {
  envBinary?: string;
  configBinary?: string;
  envDirectory?: string;
  configDirectory?: string;
}

interface ViceLaunchResolutionDependencies {
  findBinary?: (binary: string) => string | null;
  isResourceDirectory?: (candidate: string) => boolean;
}

interface ManagedViceProcessOptionsInput {
  binary: string;
  directory?: string;
  host: string;
  port: number;
  warp: boolean;
  visible: boolean;
  extraArgs: string[];
}

const DEFAULT_VICE_HOST = "127.0.0.1";
const DEFAULT_VICE_PORT = 6502;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resumeViceMonitor(client: ViceClient, timeoutMs = 250): Promise<void> {
  try {
    const exitMonitor = client.exitMonitor().catch(() => {});
    await Promise.race([
      exitMonitor,
      delay(timeoutMs),
    ]);
  } catch {
    // Ignore resume failures while tearing down a monitor session.
  }
}

function coalesceMemoryWriteBlocks(
  blocks: ReadonlyArray<{ address: number; bytes: Uint8Array }>,
): Array<{ address: number; bytes: Uint8Array }> {
  const merged: Array<{ address: number; bytes: Uint8Array }> = [];

  for (const block of blocks) {
    if (!Number.isInteger(block.address) || block.address < 0 || block.address > 0xffff) {
      throw new Error("Address must be within 0x0000-0xFFFF");
    }
    if (!(block.bytes instanceof Uint8Array) || block.bytes.length === 0) {
      throw new Error("Bytes must be a non-empty Uint8Array");
    }

    const previous = merged[merged.length - 1];
    const previousEnd = previous ? previous.address + previous.bytes.length : -1;
    if (previous && previousEnd === block.address) {
      const bytes = new Uint8Array(previous.bytes.length + block.bytes.length);
      bytes.set(previous.bytes, 0);
      bytes.set(block.bytes, previous.bytes.length);
      previous.bytes = bytes;
      continue;
    }

    merged.push({ address: block.address, bytes: Uint8Array.from(block.bytes) });
  }

  return merged;
}

/** All C64U/U2 endpoints come from loadConfig(), so the MCP server and every
 * backend agree on host, port and password. */
function readConfigFile(): BackendConfig {
  const config = loadConfig();
  const sections = config.backendConfig;
  return {
    c64u: sections.c64u || config.legacyUltimateEndpoint ? config.ultimate.c64u : undefined,
    u2: sections.u2 ? config.ultimate.u2 : undefined,
    vice: sections.vice as ViceConfig | undefined,
    endpoints: config.ultimate,
  };
}

/** Firmware drive ids (route_drives.h DriveToSubsys, matched case-insensitively). */
const FIRMWARE_DRIVE_IDS = new Set(["a", "b", "softiec"]);
/** GET /v1/drives reports the soft IEC drive under this name; the drive routes call it softiec. */
const SOFT_IEC_LISTING_ID = "iec drive";
/** Factory bus numbers of drives a and b, used when the drive listing is unavailable. */
const DEFAULT_DRIVE_BY_BUS_ID: Record<number, string> = { 8: "a", 9: "b" };

/** The firmware reports a mounted image as directory (image_path) plus file name (image_file). */
function driveImage(info: Record<string, unknown>): string | null {
  const file = typeof info.image_file === "string" ? info.image_file : "";
  const dir = typeof info.image_path === "string" ? info.image_path : "";
  if (file) return dir ? `${dir.replace(/\/+$/, "")}/${file}` : file;
  if (dir) return dir;
  return typeof info.image === "string" && info.image ? info.image : null;
}

function uploadFile(bytes: Uint8Array, name: string): File {
  return new File([Uint8Array.from(bytes)], name, { type: "application/octet-stream" });
}

class C64uBackend implements C64Facade {
  readonly type: "c64u" | "u2";
  private readonly baseUrl: string;
  private readonly networkPassword?: string;
  private readonly api: Api<unknown>;

  constructor(endpoint: C64uEndpoint, type: "c64u" | "u2" = "c64u") {
    this.type = type;
    this.baseUrl = endpoint.baseUrl;
    this.networkPassword = endpoint.networkPassword;
    const http = createLoggingHttpClient({
      baseURL: this.baseUrl,
      timeout: 10_000,
      headers: buildC64uHeaders(this.networkPassword),
    });
    this.api = new Api(http);
  }

  private requireC64u(feature: string): void {
    if (this.type === "u2") {
      throw unsupported(`${feature} is unavailable on U2-family cartridges`);
    }
  }

  getBaseUrl(): string { return this.baseUrl; }

  private actionResult(data: unknown): RunResult {
    const errors = data && typeof data === "object" && Array.isArray((data as { errors?: unknown }).errors)
      ? (data as { errors: unknown[] }).errors.filter((error) => error !== undefined && error !== null && String(error).trim() !== "")
      : [];
    return errors.length > 0
      ? { success: false, details: { response: data, errors: errors.map(String) } }
      : { success: true, details: data };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await axios.get(this.baseUrl, {
        timeout: 2000,
        headers: buildC64uHeaders(this.networkPassword),
      });
      return res.status >= 200 && res.status < 500;
    } catch { return false; }
  }

  async runPrg(prg: Uint8Array | Buffer): Promise<RunResult> {
    const payload = Buffer.isBuffer(prg) ? prg : Buffer.from(prg);
    const res = await this.api.v1.runnersRunPrgCreate(":run_prg", payload as any, { headers: { "Content-Type": "application/octet-stream" } });
    return this.actionResult(res.data);
  }
  async loadPrg(prg: Uint8Array | Buffer): Promise<RunResult> {
    const payload = Buffer.isBuffer(prg) ? prg : Buffer.from(prg);
    const res = await this.api.v1.runnersLoadPrgCreate(":load_prg", payload as any, { headers: { "Content-Type": "application/octet-stream" } });
    return this.actionResult(res.data);
  }
  async loadPrgFile(pathStr: string): Promise<RunResult> {
    const res = await this.api.v1.runnersLoadPrgUpdate(":load_prg", { file: pathStr });
    return this.actionResult(res.data);
  }
  async runPrgFile(pathStr: string): Promise<RunResult> {
    const res = await this.api.v1.runnersRunPrgUpdate(":run_prg", { file: pathStr });
    return this.actionResult(res.data);
  }
  async runCrtFile(pathStr: string): Promise<RunResult> {
    const res = await this.api.v1.runnersRunCrtUpdate(":run_crt", { file: pathStr });
    return this.actionResult(res.data);
  }
  async sidplayFile(pathStr: string, songnr?: number): Promise<RunResult> {
    const res = await this.api.v1.runnersSidplayUpdate(":sidplay", { file: pathStr, songnr });
    return this.actionResult(res.data);
  }
  async sidplayAttachment(sid: Uint8Array | Buffer, options?: { songnr?: number; songlengths?: Uint8Array | Buffer }): Promise<RunResult> {
    // The generated multipart builder JSON-encodes anything that is not a Blob,
    // so the bytes must be File parts. The firmware ignores part names and
    // takes the first file as the SID and the second as song lengths; the spec
    // names both `file`. The temp file keeps the upload name, and its extension
    // selects SID versus MUS playback.
    const file = [uploadFile(sid, "upload.sid")];
    if (options?.songlengths) file.push(uploadFile(options.songlengths, "upload.ssl"));
    const res = await this.api.v1.runnersSidplayCreate(":sidplay", { file } as any, options?.songnr !== undefined ? { songnr: options.songnr } : undefined);
    return this.actionResult(res.data);
  }
  async readMemory(address: number, length: number): Promise<Uint8Array> {
    const addrStr = address.toString(16).toUpperCase().padStart(4, "0");
    const response = await this.api.v1.machineReadmemList(
      ":readmem",
      { address: addrStr, length },
      { format: "arraybuffer", headers: { Accept: "application/octet-stream, application/json" } as any },
    );
    const contentType = (response.headers?.["content-type"] ?? "").toString().toLowerCase();
    const body = response.data as unknown;
    if (contentType.includes("application/json")) {
      const text = Buffer.from(body as ArrayBuffer).toString("utf8");
      try { const parsed = JSON.parse(text); return extractBytes(parsed?.data ?? parsed); } catch { return extractBytes(text); }
    }
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return extractBytes(body);
  }
  async writeMemory(address: number, bytes: Uint8Array): Promise<void> {
    const addrStr = address.toString(16).toUpperCase().padStart(4, "0");
    if (bytes.length <= 128) {
      await this.api.v1.machineWritememUpdate(":writemem", { address: addrStr, data: Buffer.from(bytes).toString("hex").toUpperCase() });
    } else {
      await this.api.v1.machineWritememCreate(
        ":writemem",
        { address: addrStr },
        Buffer.from(bytes) as unknown as File,
        { headers: { "Content-Type": "application/octet-stream" } },
      );
    }
  }
  async writeMemoryBlocks(blocks: ReadonlyArray<{ address: number; bytes: Uint8Array }>): Promise<void> {
    const mergedBlocks = coalesceMemoryWriteBlocks(blocks);
    await Promise.all(mergedBlocks.map(({ address, bytes }) => this.writeMemory(address, bytes)));
  }
  async reset(): Promise<RunResult> { const res = await this.api.v1.machineResetUpdate(":reset"); return this.actionResult(res.data); }
  async reboot(): Promise<RunResult> { const res = await this.api.v1.machineRebootUpdate(":reboot"); return this.actionResult(res.data); }
  async pause(): Promise<RunResult> { const res = await this.api.v1.machinePauseUpdate(":pause"); return this.actionResult(res.data); }
  async resume(): Promise<RunResult> { const res = await this.api.v1.machineResumeUpdate(":resume"); return this.actionResult(res.data); }
  async poweroff(): Promise<RunResult> { this.requireC64u("poweroff"); const res = await this.api.v1.machinePoweroffUpdate(":poweroff"); return this.actionResult(res.data); }
  async powerCycle(): Promise<RunResult> { this.requireC64u("powerCycle"); throw unsupported("powerCycle must be coordinated by C64Client"); }
  async menuButton(): Promise<RunResult> { const res = await this.api.v1.machineMenuButtonUpdate(":menu_button"); return this.actionResult(res.data); }
  async readMenuScreen(): Promise<Uint8Array> {
    const response = await this.api.v1.machineMenuScreenList(
      ":menu_screen",
      { format: "arraybuffer", headers: { Accept: "application/octet-stream" } },
    );
    const body = response.data as unknown;
    return body instanceof ArrayBuffer ? new Uint8Array(body) : extractBytes(body);
  }
  async getInputState(): Promise<MachineInputState> {
    this.requireC64u("getInputState");
    const response = await this.api.v1.machineInputList(":input");
    return response.data;
  }
  async sendInputEvents(batch: MachineInputBatch): Promise<MachineInputState> {
    this.requireC64u("sendInputEvents");
    const response = await this.api.v1.machineInputCreate(":input", batch as InputBatch);
    return response.data;
  }
  async debugregRead(): Promise<{ success: boolean; value?: string; details?: unknown }> { this.requireC64u("debugregRead"); const res = await this.api.v1.machineDebugregList(":debugreg"); return { success: true, value: (res.data as any).value, details: res.data }; }
  async debugregWrite(value: string): Promise<{ success: boolean; value?: string; details?: unknown }> { this.requireC64u("debugregWrite"); const res = await this.api.v1.machineDebugregUpdate(":debugreg", { value }); return { success: true, value: (res.data as any).value, details: res.data }; }
  async version(): Promise<unknown> { const res = await this.api.v1.versionList(); return res.data; }
  async info(): Promise<unknown> { const res = await this.api.v1.infoList(); return res.data; }
  private async driveEntries(): Promise<Array<[string, Record<string, unknown>]>> {
    const res = await this.api.v1.drivesList();
    const raw = res.data as { drives?: Array<Record<string, Record<string, unknown>>> | Record<string, Record<string, unknown>> };
    const entries = Array.isArray(raw.drives)
      ? raw.drives
      : raw.drives && typeof raw.drives === "object" ? [raw.drives] : [];
    return entries.flatMap((entry) => Object.entries(entry));
  }
  /**
   * Map a drive id to the firmware's `a`, `b` or `softiec`. Bus numbers such
   * as `drive8` or `8` are looked up by `bus_id` among drives a and b in
   * GET /v1/drives, because a drive letter's bus number is configurable; the
   * factory a=8, b=9 applies only when the listing is unavailable. The soft
   * IEC drive is reachable only by name, never by bus number.
   */
  private async resolveDriveId(drive: string): Promise<string> {
    const lower = drive.trim().toLowerCase();
    if (FIRMWARE_DRIVE_IDS.has(lower)) return lower;
    if (lower === SOFT_IEC_LISTING_ID) return "softiec";
    const match = /^(?:drive)?\s*(\d+)$/.exec(lower);
    if (!match) return drive;
    const busId = Number(match[1]);
    let listed: Array<{ id: string; busId: number; enabled: boolean }> = [];
    try {
      listed = (await this.driveEntries()).flatMap(([id, info]) => {
        const listedBusId = Number(info?.bus_id);
        return (id === "a" || id === "b") && Number.isInteger(listedBusId) ? [{ id, busId: listedBusId, enabled: info?.enabled !== false }] : [];
      });
    } catch {
      listed = [];
    }
    // A disabled drive keeps its bus_id setting, so prefer the enabled drive the C64 actually sees on that bus.
    const onBus = listed.filter((entry) => entry.busId === busId);
    const resolved = listed.length > 0 ? (onBus.find((entry) => entry.enabled) ?? onBus[0])?.id : DEFAULT_DRIVE_BY_BUS_ID[busId];
    if (!resolved) {
      const known = listed.length > 0 ? listed.map((entry) => `${entry.id}=${entry.busId}`).join(", ") : "a=8, b=9";
      throw new Error(`No drive found for '${drive}' (bus IDs: ${known})`);
    }
    return resolved;
  }
  async drivesList(): Promise<unknown> {
    const entries = await this.driveEntries();
    return entries.map(([id, info]) => ({
      id,
      power: info.enabled === true || info.enabled === "on" || info.power === "on" ? "on" : "off",
      image: driveImage(info),
      type: info.type ?? null,
      raw: info,
    }));
  }
  async driveMount(d: string, img: string, options?: { type?: "d64" | "g64" | "d71" | "g71" | "d81"; mode?: "readwrite" | "readonly" | "unlinked" }): Promise<RunResult> { const res = await this.api.v1.drivesMountUpdate(await this.resolveDriveId(d), ":mount", { image: img, type: options?.type, mode: options?.mode }); return this.actionResult(res.data); }
  async driveRemove(d: string): Promise<RunResult> { const res = await this.api.v1.drivesRemoveUpdate(await this.resolveDriveId(d), ":remove"); return this.actionResult(res.data); }
  async driveReset(d: string): Promise<RunResult> { const res = await this.api.v1.drivesResetUpdate(await this.resolveDriveId(d), ":reset"); return this.actionResult(res.data); }
  async driveOn(d: string): Promise<RunResult> { const res = await this.api.v1.drivesOnUpdate(await this.resolveDriveId(d), ":on"); return this.actionResult(res.data); }
  async driveOff(d: string): Promise<RunResult> { const res = await this.api.v1.drivesOffUpdate(await this.resolveDriveId(d), ":off"); return this.actionResult(res.data); }
  async driveSetMode(d: string, mode: "1541" | "1571" | "1581"): Promise<RunResult> { const res = await this.api.v1.drivesSetModeUpdate(await this.resolveDriveId(d), ":set_mode", { mode }); return this.actionResult(res.data); }
  async driveLoadRom(d: string, romPath: string): Promise<RunResult> { const res = await this.api.v1.drivesLoadRomUpdate(await this.resolveDriveId(d), ":load_rom", { file: romPath }); return this.actionResult(res.data); }
  async streamStart(s: "video" | "audio" | "debug", ip: string): Promise<RunResult> { this.requireC64u("streamStart"); const res = await this.api.v1.streamsStartUpdate(s, ":start", { ip }); return this.actionResult(res.data); }
  async streamStop(s: "video" | "audio" | "debug"): Promise<RunResult> { this.requireC64u("streamStop"); const res = await this.api.v1.streamsStopUpdate(s, ":stop"); return this.actionResult(res.data); }
  async configsList(): Promise<unknown> { const res = await this.api.v1.configsList(); return res.data; }
  // The generated client interpolates path parameters unencoded and the firmware
  // splits the path on "/" before decoding, so names such as "Bus Sharing - I/O1"
  // must be percent-encoded here.
  async configGet(cat: string, item?: string): Promise<unknown> { const res = item ? await this.api.v1.configsDetail2(encodeURIComponent(cat), encodeURIComponent(item)) : await this.api.v1.configsDetail(encodeURIComponent(cat)); return res.data; }
  async configSet(cat: string, item: string, value: string): Promise<RunResult> { const res = await this.api.v1.configsUpdate(encodeURIComponent(cat), encodeURIComponent(item), { value }); return this.actionResult(res.data); }
  async configBatchUpdate(payload: Record<string, object>): Promise<RunResult> { const res = await this.api.v1.configsCreate(payload); return this.actionResult(res.data); }
  async configLoadFromFlash(): Promise<RunResult> { const res = await this.api.v1.configsLoadFromFlashUpdate(":load_from_flash"); return this.actionResult(res.data); }
  async configSaveToFlash(): Promise<RunResult> { const res = await this.api.v1.configsSaveToFlashUpdate(":save_to_flash"); return this.actionResult(res.data); }
  async configResetToDefault(): Promise<RunResult> { const res = await this.api.v1.configsResetToDefaultUpdate(":reset_to_default"); return this.actionResult(res.data); }
  async filesInfo(p: string): Promise<unknown> { const res = await this.api.v1.filesInfoDetail(encodeDevicePath(p), ":info"); return res.data; }
  async filesCreateD64(p: string, options?: { tracks?: 35 | 40; diskname?: string }): Promise<RunResult> { const res = await this.api.v1.filesCreateD64Update(encodeDevicePath(p), ":create_d64", { tracks: options?.tracks, diskname: options?.diskname }); return this.actionResult(res.data); }
  async filesCreateD71(p: string, options?: { diskname?: string }): Promise<RunResult> { const res = await this.api.v1.filesCreateD71Update(encodeDevicePath(p), ":create_d71", { diskname: options?.diskname }); return this.actionResult(res.data); }
  async filesCreateD81(p: string, options?: { diskname?: string }): Promise<RunResult> { const res = await this.api.v1.filesCreateD81Update(encodeDevicePath(p), ":create_d81", { diskname: options?.diskname }); return this.actionResult(res.data); }
  async filesCreateDnp(p: string, tracks: number, options?: { diskname?: string }): Promise<RunResult> { const res = await this.api.v1.filesCreateDnpUpdate(encodeDevicePath(p), ":create_dnp", { tracks, diskname: options?.diskname }); return this.actionResult(res.data); }
  async modplayFile(pathStr: string): Promise<RunResult> { const res = await (this.api as any).v1.runnersModplayUpdate(":modplay", { file: pathStr }); return this.actionResult(res.data); }
}

export class ViceBackend implements C64Facade {
  readonly type = "vice" as const;
  private readonly exe: string;
  private readonly host: string;
  private readonly port: number;
  private readonly directory?: string;
  private readonly manageProcess: boolean;
  private readonly mockMode: boolean;
  private readonly warp: boolean;
  private readonly visible: boolean;
  private readonly extraArgs: string[];
  private static readonly supervisors = new Map<string, ViceProcessHandle>();
  private static cleanupRegistered = false;
  private readonly debugEnabled = process.env.VICE_DEVICE_TEST_DEBUG === "1";
  private startupPromise: Promise<void> | null = null;
  private monitorQueue: Promise<void> = Promise.resolve();
  private lastProcessStart = 0;

  constructor(config: ViceConfig) {
    ViceBackend.ensureCleanupRegistration();
    const envBinary = configuredString(process.env.VICE_BINARY);
    const configBinary = config.exe !== undefined
      ? configuredString(config.exe) ?? (typeof config.exe === "string" ? config.exe : String(config.exe))
      : undefined;
    const resolvedLaunch = resolveViceLaunch({
      envBinary,
      configBinary,
      envDirectory: configuredString(process.env.VICE_DIRECTORY),
      configDirectory: configuredString(config.directory),
    });
    this.exe = resolvedLaunch.binary;

    const envHost = normaliseViceHost(process.env.VICE_HOST);
    const envPort = normaliseVicePort(process.env.VICE_PORT);
    this.host = firstDefined(envHost, normaliseViceHost(config.host)) ?? DEFAULT_VICE_HOST;
    this.port = firstDefined(envPort, normaliseVicePort(config.port)) ?? DEFAULT_VICE_PORT;
    this.directory = resolvedLaunch.directory;

    this.mockMode = (process.env.VICE_TEST_TARGET || "").toLowerCase() === "mock";
    const hostLower = this.host.toLowerCase();
    const isLocal = hostLower === "127.0.0.1" || hostLower === "localhost";
    this.manageProcess = !this.mockMode && isLocal;

    const warpEnv = configuredBoolean(process.env.VICE_WARP);
    const visibleEnv = configuredBoolean(process.env.VICE_VISIBLE);
    this.visible = visibleEnv ?? configuredBoolean(config.visible) ?? true;
    this.warp = warpEnv ?? configuredBoolean(config.warp) ?? !this.visible;

    this.extraArgs = resolveViceArgs(config);
  }

  private async tryPingExisting(): Promise<boolean> {
    const client = new ViceClient();
    try {
      if (this.debugEnabled) console.error("[vice-backend] probing existing VICE", this.host, this.port);
      await client.connect(this.port, this.host);
      await client.info();
      try { await client.exitMonitor(); } catch {}
      if (this.debugEnabled) console.error("[vice-backend] existing VICE is reachable");
      return true;
    } catch {
      return false;
    } finally {
      client.close();
    }
  }

  private async waitForResponsiveMonitor(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const client = new ViceClient();
      try {
        await client.connect(this.port, this.host);
        await client.info();
        try { await client.exitMonitor(); } catch {}
        return;
      } catch (error) {
        lastError = error;
        await delay(250);
      } finally {
        client.close();
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`VICE monitor at ${this.host}:${this.port} did not become responsive within ${timeoutMs}ms`);
  }

  private async waitForUsableMachine(timeoutMs = 20_000): Promise<void> {
    const client = new ViceClient();
    try {
      await client.connect(this.port, this.host);
      await client.reset();
      const readiness = await waitForBasicReady(client, { timeoutMs, ensurePrompt: true });
      if (!readiness.pointersOk || !readiness.promptOk) {
        throw new Error(
          `VICE machine at ${this.host}:${this.port} did not reach the BASIC prompt within ${timeoutMs}ms`,
        );
      }
    } finally {
      client.close();
    }
  }

  private async ensureProcessInternal(): Promise<void> {
    if (!this.manageProcess) return;
    const key = `${this.host}:${this.port}`;
    const existing = ViceBackend.supervisors.get(key);
    if (existing) {
      const running = existing.process.exitCode === null && existing.process.signalCode === null;
      if (running) return;
      try { await existing.stop(); } catch {}
      ViceBackend.supervisors.delete(key);
    }
    if (await this.tryPingExisting()) {
      return;
    }
    if (this.debugEnabled) {
      console.error("[vice-backend] starting VICE process", {
        binary: this.exe,
        host: this.host,
        port: this.port,
        warp: this.warp,
        visible: this.visible,
        extraArgs: this.extraArgs,
      });
    }
    const handle = await startViceProcess(buildManagedViceProcessOptions({
      binary: this.exe,
      directory: this.directory,
      host: this.host,
      port: this.port,
      warp: this.warp,
      visible: this.visible,
      extraArgs: this.extraArgs,
    }));
    this.lastProcessStart = Date.now();
    if (this.debugEnabled) {
      console.error("[vice-backend] VICE process started", { pid: handle.process.pid });
    }
    ViceBackend.supervisors.set(key, handle);
    handle.process.once("exit", () => {
      ViceBackend.supervisors.delete(key);
    });
    // Allow VICE to fully initialize its display before connecting to the monitor.
    // Early monitor connection can interfere with the boot sequence.
    await delay(1000);
    await this.waitForResponsiveMonitor(20_000);
    await this.waitForUsableMachine(20_000);
  }

  private async ensureProcess(): Promise<void> {
    if (!this.manageProcess) {
      return;
    }
    if (!this.startupPromise) {
      this.startupPromise = this.ensureProcessInternal().finally(() => {
        this.startupPromise = null;
      });
    }
    await this.startupPromise;
  }

  private static ensureCleanupRegistration(): void {
    if (ViceBackend.cleanupRegistered) {
      return;
    }
    ViceBackend.cleanupRegistered = true;
    const cleanupSync = () => {
      for (const [, handle] of ViceBackend.supervisors) {
        handle.stopSync();
      }
      ViceBackend.supervisors.clear();
    };
    process.once("exit", cleanupSync);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        cleanupSync();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }

  private async withClient<T>(fn: (client: ViceClient) => Promise<T>, options?: { resumeOnClose?: boolean }): Promise<T> {
    const previous = this.monitorQueue;
    let releaseQueue: () => void = () => {};
    this.monitorQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      if (!this.mockMode) await this.ensureProcess();
      const client = new ViceClient();
      if (this.debugEnabled) console.error("[vice-backend] connecting to VICE monitor", { host: this.host, port: this.port });
      await client.connect(this.port, this.host);
      if (this.manageProcess && this.lastProcessStart > 0) {
        const sinceStart = Date.now() - this.lastProcessStart;
        const settleDelay = 500 - sinceStart;
        if (settleDelay > 0) {
          await delay(settleDelay);
        }
      }
      try {
        if (this.debugEnabled) console.error("[vice-backend] connected to VICE monitor");
        return await fn(client);
      } finally {
        if (options?.resumeOnClose !== false) {
          await resumeViceMonitor(client);
        }
        if (this.debugEnabled) console.error("[vice-backend] closing VICE monitor connection");
        client.close();
      }
    } finally {
      releaseQueue();
    }
  }

  async withMonitor<T>(fn: (client: ViceClient) => Promise<T>): Promise<T> {
    return this.withClient(fn);
  }

  async ping(): Promise<boolean> {
    const attempts = 8;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.withClient(async (client) => {
          await client.info();
        });
        return true;
      } catch (error) {
        if (this.debugEnabled) {
          console.error(`[vice-backend] ping failed (attempt ${attempt}/${attempts})`, error);
        }
        if (attempt < attempts) {
          await delay(Math.min(1_000, 200 * attempt));
        }
      }
    }
    return false;
  }

  /**
   * Reset, wait for a usable BASIC prompt, and load PRG bytes into memory.
   * `finish` decides what happens next: a genuine BASIC PRG needs its
   * pointers set and RUN typed, but machine code must never receive either
   * — RUN would misinterpret raw opcodes as tokenized BASIC text, and
   * rewriting TXTTAB/VARTAB/ARYTAB/STREND corrupts the BASIC workspace for
   * an origin that isn't BASIC program text at all.
   */
  private async loadPrgAndFinish(
    buffer: Buffer,
    finish: (client: ViceClient, loadAddress: number, programEnd: number) => Promise<void>,
  ): Promise<void> {
    if (buffer.length < 2) throw new Error("PRG data too short");
    const loadAddress = buffer.readUInt16LE(0);
    const body = buffer.subarray(2);
    await this.withClient(async (client) => {
      await client.reset();
      await waitForBasicReady(client, { timeoutMs: 10_000, ensurePrompt: true });
      if (body.length > 0) await client.memSet(loadAddress, body);
      await finish(client, loadAddress, loadAddress + body.length);
      await client.exitMonitor();
    });
  }

  private async injectPrg(buffer: Buffer): Promise<void> {
    await this.loadPrgAndFinish(buffer, async (client, loadAddress, programEnd) => {
      const ptrs = Buffer.alloc(8);
      ptrs.writeUInt16LE(loadAddress, 0);
      ptrs.writeUInt16LE(programEnd, 2);
      ptrs.writeUInt16LE(programEnd, 4);
      ptrs.writeUInt16LE(programEnd, 6);
      await client.memSet(0x002B, ptrs);
      await client.keyboardFeed("RUN\r");
    });
  }

  async runPrg(prg: Uint8Array | Buffer): Promise<RunResult> {
    const buffer = Buffer.isBuffer(prg) ? prg : Buffer.from(prg);
    await this.injectPrg(buffer);
    return { success: true };
  }

  /** Load PRG bytes without starting them — the caller decides how to enter
   * the code (e.g. a subsequent typed `SYS <entry>` for machine code). */
  async loadPrg(prg: Uint8Array | Buffer): Promise<RunResult> {
    const buffer = Buffer.isBuffer(prg) ? prg : Buffer.from(prg);
    await this.loadPrgAndFinish(buffer, async () => {});
    return { success: true };
  }

  async loadPrgFile(_path: string): Promise<RunResult> { throw unsupported("loadPrgFile"); }

  async runPrgFile(prgPath: string): Promise<RunResult> {
    const data = fs.readFileSync(prgPath);
    await this.injectPrg(data);
    return { success: true };
  }
  async runCrtFile(_path: string): Promise<RunResult> { throw unsupported("runCrtFile"); }
  async sidplayFile(_p: string): Promise<RunResult> { throw unsupported("sidplayFile"); }
  async sidplayAttachment(_sid: Uint8Array | Buffer): Promise<RunResult> { throw unsupported("sidplayAttachment"); }

  async readMemory(address: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new Error("Address must be within 0x0000-0xFFFF");
    }
    if (!Number.isInteger(length) || length <= 0) {
      throw new Error("Length must be positive");
    }
    const end = Math.min(0xffff, address + length - 1);
    return await this.withClient(async (client) => {
      const buf = await client.memGet(address, end);
      return buf.subarray(0, Math.min(buf.length, length));
    });
  }

  async writeMemory(address: number, bytes: Uint8Array): Promise<void> {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new Error("Address must be within 0x0000-0xFFFF");
    }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error("Bytes must be a non-empty Uint8Array");
    }
    await this.withClient(async (client) => {
      await client.memSet(address, Buffer.from(bytes));
    });
  }

  async writeMemoryBlocks(blocks: ReadonlyArray<{ address: number; bytes: Uint8Array }>): Promise<void> {
    const mergedBlocks = coalesceMemoryWriteBlocks(blocks);
    await this.withClient(async (client) => {
      for (const { address, bytes } of mergedBlocks) {
        await client.memSet(address, Buffer.from(bytes));
      }
    });
  }

  async reset(): Promise<RunResult> {
    let readiness: Awaited<ReturnType<typeof waitForBasicReady>> | undefined;
    // Overridable only for deterministic tests of the readiness-failure path;
    // production always uses the 20s default.
    const resetReadinessTimeoutMs = Number(process.env.C64BRIDGE_VICE_RESET_TIMEOUT_MS) || 20_000;
    await this.withClient(async (client) => {
      await client.reset();
      const opts = this.debugEnabled
        ? {
            timeoutMs: resetReadinessTimeoutMs,
            ensurePrompt: true,
            onPointersSample: (p: { tx: number; va: number; ar: number; st: number }) => {
              console.error("[vice-backend] BASIC pointers", p);
            },
          }
        : { timeoutMs: resetReadinessTimeoutMs, ensurePrompt: true };
      readiness = await waitForBasicReady(client, opts);
      if (this.debugEnabled) console.error("[vice-backend] waitForBasicReady result", readiness);
    });
    const ready = Boolean(readiness?.pointersOk && readiness?.promptOk);
    return ready
      ? { success: true, details: readiness }
      : { success: false, details: { readiness, message: "VICE reset completed but BASIC READY was not observed. Reset again or inspect the emulator monitor." } };
  }

  async reboot(): Promise<RunResult> { return this.reset(); }

  async pause(): Promise<RunResult> {
    return {
      success: false,
      details: {
        code: "UNSUPPORTED",
        message: "VICE pause is not implemented as a durable machine stop; use per-operation monitor access instead.",
      },
    };
  }

  async resume(): Promise<RunResult> {
    return {
      success: false,
      details: {
        code: "UNSUPPORTED",
        message: "VICE resume is unavailable because durable pause is not supported.",
      },
    };
  }
  async poweroff(): Promise<RunResult> {
    const key = this.supervisorKey();
    const managedHandle = this.manageProcess ? ViceBackend.supervisors.get(key) : null;
    try {
      await this.withClient(async (client) => {
        try {
          await client.quit();
        } catch {
          // Ignore transport errors during quit; the emulator will terminate regardless.
        }
      }, { resumeOnClose: false });
      if (managedHandle) {
        try {
          await managedHandle.stop();
        } catch {}
        ViceBackend.supervisors.delete(key);
      }
      return { success: true };
    } catch (error) {
      const details = error instanceof Error
        ? { message: error.message }
        : error;
      return { success: false, details };
    }
  }
  async powerCycle(): Promise<RunResult> { return this.nuclearReset(); }
  async nuclearReset(): Promise<RunResult> {
    if (!this.manageProcess) {
      return {
        success: false,
        details: {
          code: "UNSUPPORTED",
          message: "VICE nuclear reset requires a managed process; unmanaged instances can only be powered off.",
        },
      };
    }
    const poweroffResult = await this.poweroff();
    if (!poweroffResult.success) {
      return poweroffResult;
    }
    try {
      await this.ensureProcess();
      return { success: true };
    } catch (error) {
      const details = error instanceof Error
        ? { message: error.message }
        : error;
      return { success: false, details };
    }
  }

  async menuButton(): Promise<RunResult> { throw unsupported("menuButton"); }
  async readMenuScreen(): Promise<Uint8Array> { throw unsupported("readMenuScreen"); }
  async getInputState(): Promise<MachineInputState> { throw unsupported("getInputState"); }
  async sendInputEvents(_batch: MachineInputBatch): Promise<MachineInputState> { throw unsupported("sendInputEvents"); }
  async debugregRead(): Promise<{ success: boolean; value?: string; details?: unknown }> { throw unsupported("debugregRead"); }
  async debugregWrite(_v: string): Promise<{ success: boolean; value?: string; details?: unknown }> { throw unsupported("debugregWrite"); }
  async version(): Promise<unknown> { return { emulator: "vice", host: this.host, port: this.port }; }

  async info(): Promise<unknown> {
    return await this.withClient(async (client) => {
      await client.info();
      return { emulator: "vice", host: this.host, port: this.port };
    });
  }

  getEndpoint(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  // VICE has no "drive enabled" or "attached image" resource. A drive is off
  // when Drive<n>Type is 0, and images attached through this backend are
  // remembered here because VICE cannot report them.
  private readonly attachedImages = new Map<number, string>();
  private readonly savedDriveTypes = new Map<number, number>();

  async drivesList(): Promise<unknown> {
    return await this.withClient(async (client) => {
      const drives = [];
      for (const n of [8, 9, 10, 11]) {
        try {
          const typeRes = await client.resourceGet(`Drive${n}Type`);
          const type = typeRes.type === "int" ? typeRes.value : Number(typeRes.value);
          drives.push({
            id: `drive${n}`,
            power: type !== 0 ? "on" : "off",
            image: this.attachedImages.get(n) ?? null,
            type,
          });
        } catch {
          drives.push({ id: `drive${n}`, power: "off", image: null, type: 0 });
        }
      }
      return drives;
    });
  }

  async driveMount(drive: string, imagePath: string, options?: { type?: "d64" | "g64" | "d71" | "g71" | "d81"; mode?: "readwrite" | "readonly" | "unlinked" }): Promise<RunResult> {
    if (options?.type !== undefined || options?.mode !== undefined) {
      throw unsupported("driveMount type/mode overrides; omit these options on VICE");
    }
    const n = parseDriveNumber(drive);
    if (n !== 8) {
      // The Binary Monitor's only attach path is autostart, which always uses drive 8.
      throw unsupported(`driveMount on drive ${n}; VICE can attach images over the Binary Monitor only to drive 8`);
    }
    await this.withClient(async (client) => {
      await this.ensureDriveOn(client, n);
      await client.autostart(imagePath, { run: false });
    });
    this.attachedImages.set(n, imagePath);
    return { success: true, details: { drive, image: imagePath, note: "VICE attaches images through autoload, which also LOADs the first program without running it." } };
  }

  async driveRemove(_drive: string): Promise<RunResult> {
    throw unsupported("driveRemove; the VICE Binary Monitor has no command to detach a disk image");
  }

  async driveReset(drive: string): Promise<RunResult> {
    const n = parseDriveNumber(drive);
    await this.withClient(async (client) => {
      await client.resetDrive(n as 8 | 9 | 10 | 11);
    });
    return { success: true, details: { drive } };
  }

  async driveOn(drive: string): Promise<RunResult> {
    const n = parseDriveNumber(drive);
    await this.withClient(async (client) => {
      await this.ensureDriveOn(client, n);
    });
    return { success: true, details: { drive, power: "on" } };
  }

  async driveOff(drive: string): Promise<RunResult> {
    const n = parseDriveNumber(drive);
    await this.withClient(async (client) => {
      const current = await client.resourceGet(`Drive${n}Type`);
      const type = current.type === "int" ? current.value : Number(current.value);
      if (type !== 0) this.savedDriveTypes.set(n, type);
      await client.resourceSet(`Drive${n}Type`, 0);
    });
    return { success: true, details: { drive, power: "off" } };
  }

  /** Switch a drive on by giving it a type again: the one it had before driveOff, or a 1541. */
  private async ensureDriveOn(client: ViceClient, n: number): Promise<void> {
    const current = await client.resourceGet(`Drive${n}Type`);
    const type = current.type === "int" ? current.value : Number(current.value);
    if (type === 0) {
      await client.resourceSet(`Drive${n}Type`, this.savedDriveTypes.get(n) ?? 1541);
    }
  }

  async driveSetMode(drive: string, mode: "1541" | "1571" | "1581"): Promise<RunResult> {
    const n = parseDriveNumber(drive);
    // Drive<n>Type takes the model number itself (DRIVE_TYPE_1541 = 1541 in VICE's drive.h).
    const DRIVE_TYPE: Record<string, number> = { "1541": 1541, "1571": 1571, "1581": 1581 };
    const typeNum = DRIVE_TYPE[mode];
    if (typeNum === undefined) throw new Error(`Unknown drive mode: ${mode}`);
    await this.withClient(async (client) => {
      await client.resourceSet(`Drive${n}Type`, typeNum);
    });
    return { success: true, details: { drive, mode } };
  }

  async driveLoadRom(): Promise<RunResult> { throw unsupported("driveLoadRom"); }
  async streamStart(): Promise<RunResult> { throw unsupported("streamStart"); }
  async streamStop(): Promise<RunResult> { throw unsupported("streamStop"); }

  async configsList(): Promise<unknown> {
    return {
      categories: [
        {
          name: "VICE",
          // Only resources that exist in VICE 3.10; checked against a running x64sc.
          // VICE has no warp, drive-enable or attached-image resources.
          items: [
            "SoundVolume", "Drive8Type", "Drive9Type", "Drive10Type", "Drive11Type",
            "VICIIBorderMode", "VICIIFullscreen", "MachineVideoStandard", "SidModel",
          ],
        },
      ],
    };
  }

  async configGet(_category: string, item?: string): Promise<unknown> {
    if (!item) {
      if (_category !== "VICE") throw new Error(`Unknown VICE configuration category '${_category}'`);
      const inventory = await this.configsList() as { categories: Array<{ items: string[] }> };
      return this.withClient(async (client) => {
        const values: Record<string, string | number> = {};
        for (const name of inventory.categories[0]!.items) {
          values[name] = (await client.resourceGet(name)).value;
        }
        return values;
      });
    }
    return await this.withClient(async (client) => {
      const res = await client.resourceGet(item as string);
      return { category: _category, item, value: res.value, type: res.type };
    });
  }

  async configSet(_category: string, item: string, value: string): Promise<RunResult> {
    let parsed: string | number = value;
    await this.withClient(async (client) => {
      const current = await client.resourceGet(item);
      parsed = parseViceConfigValue(value, current.type, item);
      await client.resourceSet(item, parsed);
    });
    return { success: true, details: { item, value: parsed } };
  }

  async configBatchUpdate(payload: Record<string, object>): Promise<RunResult> {
    const results: Array<{ item: string; success: boolean; error?: string }> = [];
    await this.withClient(async (client) => {
      for (const [category, items] of Object.entries(payload)) {
        for (const [item, value] of Object.entries(items as Record<string, unknown>)) {
          try {
            const current = await client.resourceGet(item);
            const parsed = parseViceConfigValue(value, current.type, item);
            await client.resourceSet(item, parsed);
            results.push({ item: `${category}/${item}`, success: true });
          } catch (err) {
            results.push({ item: `${category}/${item}`, success: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    });
    return { success: results.every((r) => r.success), details: { results } };
  }

  async configLoadFromFlash(): Promise<RunResult> { throw unsupported("configLoadFromFlash"); }
  async configSaveToFlash(): Promise<RunResult> { throw unsupported("configSaveToFlash"); }
  async configResetToDefault(): Promise<RunResult> { throw unsupported("configResetToDefault"); }
  async filesInfo(): Promise<unknown> { throw unsupported("filesInfo"); }
  async filesCreateD64(): Promise<RunResult> { throw unsupported("filesCreateD64"); }
  async filesCreateD71(): Promise<RunResult> { throw unsupported("filesCreateD71"); }
  async filesCreateD81(): Promise<RunResult> { throw unsupported("filesCreateD81"); }
  async filesCreateDnp(): Promise<RunResult> { throw unsupported("filesCreateDnp"); }
  private supervisorKey(): string {
    return `${this.host}:${this.port}`;
  }
}

function parseViceConfigValue(value: unknown, type: string, item: string): string | number {
  if (type !== "int") return String(value ?? "");
  const parsed = value === true || value === "true" ? 1
    : value === false || value === "false" ? 0 : Number(value);
  if (!Number.isInteger(parsed) || parsed < -0x80000000 || parsed > 0x7fffffff) {
    throw new Error(`VICE resource '${item}' requires a 32-bit integer value`);
  }
  return parsed;
}

function unsupported(name: string): Error { const err = new Error(`Operation '${name}' is not supported by the VICE backend`); (err as any).code = "UNSUPPORTED"; return err; }

/** Ultimate file APIs treat slash as a path separator. Encode each name once,
 * preserving leading and nested separators for firmware routing. */
function encodeDevicePath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** C64U drive letters with their factory bus numbers, so one drive id works on both backends. */
const VICE_DRIVE_LETTERS: Record<string, number> = { a: 8, b: 9 };

function parseDriveNumber(drive: string): number {
  const key = drive.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VICE_DRIVE_LETTERS, key)) return VICE_DRIVE_LETTERS[key]!;
  const match = /\d+/.exec(drive);
  const n = match ? parseInt(match[0], 10) : NaN;
  if (isNaN(n) || n < 8 || n > 11) throw new Error(`Invalid drive specification: ${drive}`);
  return n;
}

function extractBytes(data: unknown): Uint8Array {
  if (!data) return new Uint8Array();
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") { try { return Uint8Array.from(Buffer.from(data, "base64")); } catch { return Uint8Array.from(Buffer.from(data, "hex")); } }
  if (Array.isArray((data as any)?.data)) return Uint8Array.from(((data as any).data) ?? []);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data === "object" && data !== null) {
    const maybe = (data as Record<string, unknown>).data;
    if (typeof maybe === "string") return Uint8Array.from(Buffer.from(maybe, "base64"));
    if (Array.isArray(maybe)) return Uint8Array.from(maybe as number[]);
  }
  return new Uint8Array();
}

function which(binary: string): string | null {
  const hasSep = binary.includes("/") || binary.includes("\\");
  if (hasSep) { try { if (fs.existsSync(binary)) return binary; } catch {} return null; }
  const envPath = process.env.PATH || "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

function resolveViceBinary(
  options: { envBinary?: string; configBinary?: string },
  findBinary: (binary: string) => string | null = which,
): string {
  const explicit = firstDefined(options.envBinary, options.configBinary);
  if (explicit) {
    const resolvedExplicit = findBinary(explicit);
    if (resolvedExplicit) {
      return resolvedExplicit;
    }
  }

  for (const candidate of ["/usr/local/bin/x64sc", "/usr/local/bin/x64"]) {
    if (findBinary(candidate)) {
      return candidate;
    }
  }

  return findBinary("x64sc") ?? findBinary("x64") ?? "x64sc";
}

function resolveViceLaunch(
  options: ViceLaunchResolutionOptions,
  dependencies: ViceLaunchResolutionDependencies = {},
): { binary: string; directory?: string } {
  const findBinary = dependencies.findBinary ?? which;
  const isResourceDirectory = dependencies.isResourceDirectory ?? isViceResourceDirectory;
  const explicitBinary = firstDefined(options.envBinary, options.configBinary);
  const explicitDirectory = firstDefined(
    resolveViceDirectoryWithValidator(options.envDirectory, isResourceDirectory),
    resolveViceDirectoryWithValidator(options.configDirectory, isResourceDirectory),
  );

  let binary = resolveViceBinary(
    { envBinary: options.envBinary, configBinary: options.configBinary },
    findBinary,
  );

  if (explicitDirectory) {
    return { binary, directory: explicitDirectory };
  }

  const adjacentDirectory = findViceResourceDirectory(binary, {
    allowGlobalFallback: false,
    isResourceDirectory,
  });
  if (adjacentDirectory) {
    return { binary, directory: adjacentDirectory };
  }

  if (explicitBinary) {
    return {
      binary,
      directory: findViceResourceDirectory(binary, {
        allowGlobalFallback: true,
        isResourceDirectory,
      }),
    };
  }

  return {
    binary,
    directory: findViceResourceDirectory(binary, {
      allowGlobalFallback: true,
      isResourceDirectory,
    }),
  };
}

function buildManagedViceProcessOptions(input: ManagedViceProcessOptionsInput): ViceProcessOptions {
  return {
    binary: input.binary,
    directory: input.directory,
    host: input.host,
    port: input.port,
    warp: input.warp,
    visible: input.visible,
    extraArgs: input.extraArgs.length > 0 ? input.extraArgs : undefined,
  };
}

export function __resolveViceBinaryForTests(
  options: { envBinary?: string; configBinary?: string },
  findBinary?: (binary: string) => string | null,
): string {
  return resolveViceBinary(options, findBinary ?? which);
}

export function __resolveViceLaunchForTests(
  options: ViceLaunchResolutionOptions,
  dependencies?: ViceLaunchResolutionDependencies,
): { binary: string; directory?: string } {
  return resolveViceLaunch(options, dependencies);
}

export function __buildViceProcessOptionsForTests(input: ManagedViceProcessOptionsInput): ViceProcessOptions {
  return buildManagedViceProcessOptions(input);
}

export interface FacadeSelection { facade: C64Facade; selected: DeviceType; reason: string; details?: Record<string, unknown> }

export interface FacadeOptions {
  preferredC64uBaseUrl?: string;
  preferredC64uNetworkPassword?: string;
}

export interface AllFacadesResult {
  primary: FacadeSelection;
  facades: ReadonlyMap<DeviceType, C64Facade>;
}

export async function createFacade(logger?: { info: (...a: any[]) => void }, options?: FacadeOptions): Promise<FacadeSelection> {
  const envMode = (process.env.C64_MODE || "").toLowerCase().trim();
  // Caller-forced preference: use c64u with provided base URL (used by tests and server wiring)
  if (options?.preferredC64uBaseUrl) {
    const type = envMode === "u2" ? "u2" : "c64u";
    const backend = new C64uBackend(resolveUltimateEndpoint(type, {
      baseUrl: options.preferredC64uBaseUrl,
      networkPassword: options.preferredC64uNetworkPassword,
    }), type);
    logger?.info?.(`Active backend: ${type} (forced by caller)`);
    return { facade: backend, selected: type, reason: "forced by caller", details: { baseUrl: options.preferredC64uBaseUrl } };
  }
  const cfg = readConfigFile();
  const hasC64u = Boolean(cfg.c64u);
  const hasU2 = Boolean(cfg.u2);
  const hasVice = Boolean(cfg.vice);

  if (envMode === "c64u") {
    const backend = new C64uBackend(cfg.endpoints.c64u);
    logger?.info?.("Active backend: c64u (from env override)");
    return { facade: backend, selected: "c64u", reason: "env override", details: { baseUrl: backend.getBaseUrl?.() } };
  }
  if (envMode === "u2") {
    const backend = new C64uBackend(cfg.endpoints.u2, "u2");
    logger?.info?.("Active backend: u2 (from env override)");
    return { facade: backend, selected: "u2", reason: "env override", details: { baseUrl: backend.getBaseUrl?.() } };
  }
  if (envMode === "vice") {
    const backend = new ViceBackend(cfg.vice ?? {});
    logger?.info?.("Active backend: vice (from env override)");
    const endpoint = backend.getEndpoint();
    return { facade: backend, selected: "vice", reason: "env override", details: { host: endpoint.host, port: endpoint.port } };
  }

  if (hasC64u) {
    const backend = new C64uBackend(cfg.c64u!);
    logger?.info?.("Active backend: c64u (from config)");
    return { facade: backend, selected: "c64u", reason: hasVice ? "both defined (prefer c64u)" : "config only", details: { baseUrl: backend.getBaseUrl?.() } };
  }
  if (hasU2) {
    const backend = new C64uBackend(cfg.u2!, "u2");
    logger?.info?.("Active backend: u2 (from config)");
    return { facade: backend, selected: "u2", reason: "config only", details: { baseUrl: backend.getBaseUrl?.() } };
  }
  if (hasVice) {
    const backend = new ViceBackend(cfg.vice!);
    logger?.info?.("Active backend: vice (from config)");
    const endpoint = backend.getEndpoint();
    return { facade: backend, selected: "vice", reason: "config only", details: { host: endpoint.host, port: endpoint.port } };
  }
  // No configuration
  const probeBase = cfg.endpoints.c64u.baseUrl;
  try {
    const res = await axios.get(probeBase, { timeout: 1500 });
    if (res.status >= 200 && res.status < 500) {
      const backend = new C64uBackend(cfg.endpoints.c64u);
      logger?.info?.("Active backend: c64u (fallback – hardware reachable)");
      return { facade: backend, selected: "c64u", reason: "fallback (reachable)", details: { baseUrl: probeBase } };
    }
  } catch {}
  const backend = new ViceBackend(cfg.vice ?? {});
  logger?.info?.("Active backend: vice (fallback – hardware unavailable)");
  const endpoint = backend.getEndpoint();
  return { facade: backend, selected: "vice", reason: "fallback (hardware unavailable)", details: { host: endpoint.host, port: endpoint.port } };
}

export async function createAllFacades(
  logger?: { info: (...a: any[]) => void },
  options?: FacadeOptions,
): Promise<AllFacadesResult> {
  // C64U/VICE preserve config-file selection semantics. U2 needs the
  // caller-provided endpoint because it is selected through C64_MODE=u2.
  const primary = await createFacade(
    logger,
    process.env.C64_MODE?.toLowerCase().trim() === "u2" ? options : undefined,
  );
  const config = readConfigFile();
  const facades = new Map<DeviceType, C64Facade>([[primary.selected, primary.facade]]);
  if (config.c64u && primary.selected !== "c64u") {
    facades.set("c64u", new C64uBackend(config.c64u));
  }
  if (config.u2 && primary.selected !== "u2") {
    facades.set("u2", new C64uBackend(config.u2, "u2"));
  }
  if (config.vice && primary.selected !== "vice") {
    facades.set("vice", new ViceBackend(config.vice));
  }
  // Reached only without a configured c64u profile, so the caller's endpoint applies.
  if (!facades.has("c64u") && !config.u2 && shouldProvisionSecondaryC64u(config, options) && primary.selected !== "u2") {
    facades.set("c64u", new C64uBackend(resolveUltimateEndpoint("c64u", {
      baseUrl: options?.preferredC64uBaseUrl,
      networkPassword: options?.preferredC64uNetworkPassword,
    })));
  }
  return { primary, facades };
}

function shouldProvisionSecondaryC64u(config: BackendConfig, options?: FacadeOptions): boolean {
  return Boolean(
    config.c64u
    || options?.preferredC64uBaseUrl
    || configuredString(process.env.C64U_HOST)
    || configuredPort(process.env.C64U_PORT)
    || configuredString(process.env.C64U_PASSWORD),
  );
}

function configuredString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function configuredBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const input = configuredString(value);
  if (!input) return undefined;
  const normalised = input.toLowerCase();
  if (normalised === "1" || normalised === "true" || normalised === "yes" || normalised === "on") {
    return true;
  }
  if (normalised === "0" || normalised === "false" || normalised === "no" || normalised === "off") {
    return false;
  }
  return undefined;
}

function resolveViceArgs(config: ViceConfig): string[] {
  const argsEnv = configuredString(process.env.VICE_ARGS);
  if (argsEnv) {
    return parseArgsList(argsEnv);
  }
  if (Array.isArray(config.args)) {
    return config.args
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  if (typeof config.args === "string") {
    return parseArgsList(config.args);
  }
  return [];
}

function resolveViceDirectory(value?: string): string | undefined {
  const input = configuredString(value);
  if (!input) {
    return undefined;
  }
  return isViceResourceDirectory(input) ? input : undefined;
}

function resolveViceDirectoryWithValidator(
  value: string | undefined,
  isResourceDirectory: (candidate: string) => boolean,
): string | undefined {
  const input = configuredString(value);
  if (!input) {
    return undefined;
  }
  return isResourceDirectory(input) ? input : undefined;
}

function findViceResourceDirectory(
  binaryPath: string,
  options: { allowGlobalFallback?: boolean; isResourceDirectory?: (candidate: string) => boolean } = {},
): string | undefined {
  const isResourceDirectory = options.isResourceDirectory ?? isViceResourceDirectory;
  const candidates = new Set<string>();
  const resolvedBinary = configuredString(binaryPath);
  if (resolvedBinary) {
    const binaryDir = path.dirname(resolvedBinary);
    candidates.add(path.resolve(binaryDir, "..", "share", "vice"));
    candidates.add(path.resolve(binaryDir, "..", "..", "share", "vice"));
  }
  if (options.allowGlobalFallback !== false) {
    candidates.add("/usr/local/share/vice");
    candidates.add("/usr/share/vice");
    candidates.add("/opt/homebrew/share/vice");
    candidates.add("/opt/local/share/vice");
  }

  for (const candidate of candidates) {
    if (isResourceDirectory(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isViceResourceDirectory(candidate: string): boolean {
  const normalized = configuredString(candidate);
  if (!normalized) {
    return false;
  }
  const requiredFiles = [
    path.join(normalized, "C64", "kernal-901227-03.bin"),
    path.join(normalized, "C64", "basic-901226-01.bin"),
    path.join(normalized, "C64", "chargen-901225-01.bin"),
  ];
  return requiredFiles.every((filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  });
}

function configuredPort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return undefined;
}

function buildC64uHeaders(networkPassword?: string): Record<string, string> | undefined {
  return networkPassword ? { "X-Password": networkPassword } : undefined;
}

function parseArgsList(input: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    args.push(value.replace(/\\(["'\\])/g, "$1"));
  }
  return args;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normaliseViceHost(input?: string): string | undefined {
  const trimmed = configuredString(input);
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normaliseVicePort(value?: string | number): number | undefined {
  return configuredPort(value);
}

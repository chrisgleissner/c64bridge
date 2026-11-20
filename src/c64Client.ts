/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import axios from "axios";
import { basicToPrg } from "./tools/translation/basicTokenizer.js";
import { assemblyToPrgDetailed, prgEntryAddress } from "./tools/translation/assembler.js";
import { stripHexByteSeparators } from "./tools/hex.js";
import { SIDWAVE_PLAY_ADDRESS } from "./sidwaveCompiler.js";
import { petsciiToAscii, screenCodesToAscii } from "./petscii.js";
import { resolveAddressSymbol } from "./knowledge.js";
import { assertNotBareHex, parseNumericLiteral } from "./numericArg.js";
import { ToolValidationError } from "./tools/errors.js";
import {
  C64Facade,
  createAllFacades,
  createFacade,
  type DeviceType,
  type MachineInputBatch,
  type MachineInputState,
  ViceBackend,
  screenLayoutFromRegisters,
} from "./device.js";
import { Api, HttpClient } from "../generated/c64/index.js";
import { createLoggingHttpClient, RequestQueue } from "./loggingHttpClient.js";
import { withDiagnosticSpan, writeDiagnosticEvent } from "./diagnostics.js";
import {
  analyzeStereoStream,
  normalizeAudioDuration,
  recordAndAnalyzeAudio,
  type AnalysisResult,
  type RecordAndAnalyzeParams,
} from "./audio/record_and_analyze_audio.js";
import type {
  ViceClient,
  ViceCheckpoint,
  ViceCheckpointCreateOptions,
  ViceMemspace,
  ViceRegisterMetadata,
  ViceRegisterValue,
  ViceRegisterWrite,
  ViceResourceValue,
} from "./vice/viceClient.js";
import { forgetUserStream, rememberUserStream, userStreamTarget, withStreamLock } from "./streamTargets.js";
import {
  C64U_NTSC_AUDIO_SAMPLE_RATE,
  C64U_PAL_AUDIO_SAMPLE_RATE,
  VideoFrameAssembler,
  parseAudioPacket,
  parseVideoPacket,
  type CapturedFrame,
} from "./streamCapture.js";
import {
  buildVicBitmapRegisters,
  resolveVicBitmapMemoryLayout,
  type PreparedVicBitmap,
} from "./vicBitmap.js";

export interface RunBasicResult {
  success: boolean;
  details?: unknown;
}

export interface MemoryReadResult {
  success: boolean;
  data?: string;
  details?: unknown;
}

export interface C64ClientOptions {
  networkPassword?: string;
  forceC64uFacade?: boolean;
}

/** Raised when the KERNAL keyboard buffer did not drain before another chunk
 * could safely be queued. Callers must report this as partial delivery.
 * `delivered` counts the bytes handed to the keyboard queue, including the
 * `pending` ones still waiting there; only the bytes after `delivered` need
 * to be sent again. */
export class KeyboardQueueDrainTimeoutError extends Error {
  readonly delivered: number;
  readonly requested: number;
  readonly timeoutMs: number;
  readonly pending: number | undefined;

  constructor(delivered: number, requested: number, timeoutMs: number, pending?: number) {
    const queued = pending === undefined || pending <= 0
      ? ""
      : delivered === 0
        ? ` The keyboard queue still holds ${pending} byte(s) from earlier input, so nothing was queued.`
        : ` ${pending} of them are still queued and are typed when the machine reads the keyboard; do not send them again.`;
    super(`Keyboard queue did not drain after ${timeoutMs}ms; delivered ${delivered} of ${requested} byte(s).${queued} Resume the machine, then send only the remaining ${requested - delivered} byte(s).`);
    this.name = "KeyboardQueueDrainTimeoutError";
    this.delivered = delivered;
    this.requested = requested;
    this.timeoutMs = timeoutMs;
    this.pending = pending;
  }
}

export type NativeEndpointAvailability = "available" | "unavailable" | "unknown";

export interface NativeEndpointCapabilities {
  readonly machineInput: NativeEndpointAvailability;
  /** Menu-screen support cannot be probed without an active Ultimate menu. */
  readonly machineMenuScreen: NativeEndpointAvailability;
}

export interface FrameCaptureResult {
  readonly backend: "c64u" | "vice";
  readonly frames: readonly CapturedFrame[];
  /** Non-fatal problems, for example a failed stream stop after a successful capture. */
  readonly warnings?: readonly string[];
}

export interface SampleCaptureResult {
  readonly backend: "c64u";
  readonly channels: 2;
  readonly sampleRateHz: number;
  readonly samplePairs: number;
  readonly samples: Int16Array;
  /** Non-fatal notes, for example that a stream started with c64_stream was restarted. */
  readonly warnings?: readonly string[];
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/** JOYPORT_ID_IO_SIMULATION in joyport.h (the same in VICE 3.9 and 3.10). */
const VICE_JOYPORT_IO_SIMULATION = 37;
const C64U_SYSTEM_MODE_CATEGORY = "U64 Specific Settings";
const C64U_SYSTEM_MODE_ITEM = "System Mode";
// System Mode values that run the machine clock at the NTSC frequency
// (VIDEO_FMT_NTSC_FREQ in the firmware colour timings); the other values use the PAL clock.
const NTSC_CLOCK_SYSTEM_MODES = new Set(["NTSC", "PAL-60", "PAL-60/L"]);

/**
 * Reads the current System Mode from a config response. The firmware answers
 * `{ "<category>": { "<item>": { "current": "PAL", ... } } }`; a bare `{ value }` is also accepted.
 */
export function readSystemMode(response: unknown): string | null {
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const category = record(record(response)?.[C64U_SYSTEM_MODE_CATEGORY]);
  const node = category?.[C64U_SYSTEM_MODE_ITEM] ?? response;
  const raw = typeof node === "string" ? node : record(node)?.current ?? record(node)?.value;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export function audioSampleRateForSystemMode(mode: string | null): number {
  return mode !== null && NTSC_CLOCK_SYSTEM_MODES.has(mode.toUpperCase())
    ? C64U_NTSC_AUDIO_SAMPLE_RATE
    : C64U_PAL_AUDIO_SAMPLE_RATE;
}

/** Longest wait for the first audio datagram after the stream started. */
const AUDIO_FIRST_DATAGRAM_TIMEOUT_MS = 1_500;

/**
 * Time allowed for an audio capture: three times its duration at the stream's sample rate plus
 * 1.5 s for the stream to start. (The stream delivers about 48,000 pairs per second.)
 */
export function audioCaptureTimeoutMs(samplePairs: number, sampleRateHz: number): number {
  return Math.ceil((samplePairs / sampleRateHz) * 3_000) + 1_500;
}

// A partial capture must still hold one analysis window (2048 stereo frames).
const MIN_PARTIAL_AUDIO_VALUES = 2048 * 2;
const STREAM_HOST_RESOLVE_ERROR = "Network Host Resolve Error";
const NEIGHBOR_PRIME_TIMEOUT_MS = 4_000;

/**
 * The Ultimate firmware resolves a unicast stream target through its ARP cache
 * and answers 404 "Network Host Resolve Error" immediately when the client is
 * not cached. Accepts both a thrown HTTP error and an unsuccessful result.
 */
function isStreamHostResolveFailure(failure: unknown): boolean {
  const body = axios.isAxiosError(failure) ? failure.response?.data : failure;
  if (body === undefined || body === null) {
    return false;
  }
  try {
    return JSON.stringify(body).includes(STREAM_HOST_RESOLVE_ERROR);
  } catch {
    return false;
  }
}

/** Hostnames come from configuration; accept only plain host or address characters so they cannot act as ping options. */
export function pingableHost(hostname: string): string | null {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  return /^[A-Za-z0-9][A-Za-z0-9._:%-]*$/.test(host) ? host : null;
}

/** True when `host` is an address of one of this machine's network interfaces. */
export function isLocalAddress(host: string): boolean {
  const wanted = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return Object.values(networkInterfaces()).some((entries) =>
    (entries ?? []).some((entry) => entry.address.toLowerCase() === wanted),
  );
}

/** Host part of a `host:port` stream target, or null when it cannot be split. */
export function streamTargetHost(target: string): string | null {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(target);
  if (bracketed) {
    return bracketed[1]!;
  }
  const colon = target.indexOf(":");
  if (colon === -1) {
    return target.length > 0 ? target : null;
  }
  // Exactly one colon separates host and port; several colons are a bare IPv6 address.
  if (colon !== target.lastIndexOf(":")) {
    return target;
  }
  return colon > 0 ? target.slice(0, colon) : null;
}

function neighborPrimeArgs(host: string): string[] {
  switch (process.platform) {
    case "win32":
      return ["-n", "1", "-w", "2000", host];
    case "darwin":
      return ["-c", "1", "-t", "2", host];
    default:
      return ["-c", "1", "-W", "2", host];
  }
}

function menuMatrixIncludes(matrix: Uint8Array, expected: string): boolean {
  // Firmware supplies the character matrix followed by its colour matrix. The
  // documented wire format is raw bytes, so only inspect the first 40×25
  // character cells when that complete layout is present.
  const characters = matrix.length >= 2_000 ? matrix.subarray(0, 1_000) : matrix;
  const normalizedExpected = expected.replace(/\s+/g, " ").toUpperCase();
  return [screenCodesToAscii(characters), petsciiToAscii(characters)]
    .some((text) => text.replace(/\s+/g, " ").toUpperCase().includes(normalizedExpected));
}

function selectedMenuRow(matrix: Uint8Array): number | null {
  // The firmware contract exposes a 40x25 character matrix followed by its
  // colour matrix. A selected menu row is rendered with one uniform colour
  // distinct from the normal rows. Reject malformed/ambiguous matrices.
  if (matrix.length < 2_000) return null;
  const colours = matrix.subarray(1_000, 2_000);
  const rows: number[] = [];
  for (let row = 0; row < 25; row += 1) {
    const cells = colours.subarray(row * 40, row * 40 + 40);
    if (cells.length === 40 && cells.every((value) => value === cells[0])) rows.push(row);
  }
  if (rows.length === 0) return null;
  const normal = new Map<number, number>();
  for (const row of rows) normal.set(colours[row * 40]!, (normal.get(colours[row * 40]!) ?? 0) + 1);
  const [colour, count] = [...normal.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (colour === undefined || count === undefined) return null;
  const selected = rows.filter((row) => colours[row * 40] !== colour);
  return selected.length === 1 ? selected[0]! : null;
}

function selectedMenuRowIncludes(matrix: Uint8Array, expected: string): boolean {
  const row = selectedMenuRow(matrix);
  if (row === null) return false;
  const text = [screenCodesToAscii(matrix.subarray(row * 40, row * 40 + 40)), petsciiToAscii(matrix.subarray(row * 40, row * 40 + 40))]
    .map((value) => value.replace(/\s+/g, " ").toUpperCase());
  return text.some((value) => value.includes(expected.replace(/\s+/g, " ").toUpperCase()));
}

function isMissingEndpoint(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404;
}

interface C64uVideoCaptureSession {
  readonly facade: C64Facade;
  readonly socket: Socket;
  readonly bindAddress: string;
  readonly target: string;
  /** Frames being assembled; holds at most VIDEO_SESSION_MAX_PACKETS packets of incomplete frames. */
  readonly assembler: VideoFrameAssembler;
  /** The most recent complete frames, at most VIDEO_SESSION_MAX_FRAMES. */
  readonly frames: Array<{ readonly frame: CapturedFrame; readonly firstPacketIndex: number }>;
  readonly waiters: Array<{
    count: number;
    /** Index of the first packet this waiter may use: a frame qualifies when its first packet is at or after it. */
    startIndex: number;
    resolve: (frames: readonly CapturedFrame[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  stopTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  error: Error | null;
}

/**
 * Packets a reusable video capture session keeps. A frame is 68 packets at the firmware geometry
 * (at most 512 for one-line packets), so this covers several requested frames; older packets can
 * no longer complete a frame a waiter needs, and the stream must not grow memory while it stays open.
 */
export const VIDEO_SESSION_MAX_PACKETS = 4096;

/** Complete frames a reusable session keeps for waiters (the capture count is at most 32). */
const VIDEO_SESSION_MAX_FRAMES = 64;

/** Shortest interval between two diagnostic records about ignored video datagrams. */
const IGNORED_VIDEO_REPORT_INTERVAL_MS = 10_000;

export interface BitmapDisplayResult {
  readonly mode: "hires" | "multicolor";
  readonly bank: number;
  readonly bitmapAddress: string;
  readonly screenAddress: string;
  readonly colorRamAddress: string;
  readonly registers: {
    readonly dd00: number;
    readonly d011: number;
    readonly d016: number;
    readonly d018: number;
    readonly d020: number;
    readonly d021: number;
  };
  readonly bitmapBytes: number;
  readonly screenBytes: number;
  readonly colorRamBytes: number;
}

export interface SpriteDisplayResult {
  /** VIC bank in use (0-3, bank n starts at n * $4000); the sprite is placed in it. */
  readonly bank: number;
  readonly spriteAddress: string;
  readonly screenAddress: string;
  readonly pointerAddress: string;
  readonly pointerValue: number;
  /** Sprite registers after the write; the VIC bank and screen mode registers are left as they were. */
  readonly registers: {
    readonly dd00: number;
    readonly d011: number;
    readonly d018: number;
    readonly d010: number;
    readonly d015: number;
    readonly d01c: number;
  };
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly color: number;
  readonly multicolour: boolean;
  readonly spriteByteLength: number;
  readonly warnings?: readonly string[];
}

const TEXT_SCREEN_COLUMNS = 40;
const TEXT_SCREEN_ROWS = 25;
const TEXT_SCREEN_SIZE = TEXT_SCREEN_COLUMNS * TEXT_SCREEN_ROWS;
const TEXT_SCREEN_ADDRESS = 0x0400;
const TEXT_COLOR_RAM_ADDRESS = 0xD800;
const SPRITE_DATA_BASE_ADDRESS = 0x2000;
const DEFAULT_TEXT_FOREGROUND = 1;
const DEFAULT_BORDER_COLOR = 6;
const DEFAULT_BACKGROUND_COLOR = 0;
const SPACE_SCREEN_CODE = 0x20;

function validateMemoryRange(address: number, length: number): void {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new Error("Address must be within 0x0000 - 0xFFFF");
  }
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error("Length must be greater than zero");
  }
  if (address + length - 1 > 0xffff) {
    throw new Error("Memory range must stay within 0x0000 - 0xFFFF");
  }
}

/** Capability probes use a short timeout so an offline device does not hold the request queue for a full request timeout. */
const CAPABILITY_PROBE_TIMEOUT_MS = 2_000;

export class C64Client {
  private readonly baseUrl: string;
  private readonly http: HttpClient<unknown>;
  private readonly api: Api<unknown>;
  private readonly allFacades = new Map<DeviceType, Promise<C64Facade>>();
  private readonly warmupPromises = new Map<DeviceType, Promise<boolean>>();
  private readonly greetingDd00Cache = new Map<DeviceType, number>();
  private readonly greetingDd00Warmups = new Map<DeviceType, Promise<number>>();
  private readonly machineInputCapabilityProbes = new Map<DeviceType, Promise<NativeEndpointAvailability>>();
  private c64uVideoCaptureSession: C64uVideoCaptureSession | null = null;
  /** VICE joyport device ids to restore when a joystick press ends. */
  private readonly viceJoyportSavedDevice = new Map<1 | 2, number>();
  private readonly initPromise: Promise<void>;
  private activeType: DeviceType = "c64u";
  private facadePromise: Promise<C64Facade>;

  constructor(baseUrl: string, options: C64ClientOptions = {}) {
    this.baseUrl = baseUrl;
    const headers = options.networkPassword ? { "X-Password": options.networkPassword } : undefined;
    // Shares the device queue with the C64U backend: the fallback REST calls made through this client must not overlap its requests.
    this.http = createLoggingHttpClient({ baseURL: baseUrl, timeout: 10_000, headers }, undefined, RequestQueue.forDevice(baseUrl));
    this.api = new Api(this.http);
    const forceC64uFacade = options.forceC64uFacade ?? true;
    if (forceC64uFacade) {
      this.facadePromise = createFacade(undefined, {
        preferredC64uBaseUrl: baseUrl,
        preferredC64uNetworkPassword: options.networkPassword,
      }).then((sel) => sel.facade);
      this.allFacades.set("c64u", this.facadePromise);
      this.initPromise = Promise.resolve();
      return;
    }

    const allFacadesPromise = createAllFacades(undefined, {
      preferredC64uBaseUrl: baseUrl,
      preferredC64uNetworkPassword: options.networkPassword,
    });
    this.facadePromise = allFacadesPromise.then(({ primary }) => primary.facade);
    this.initPromise = allFacadesPromise.then(({ primary, facades }) => {
      const primaryPromise = Promise.resolve(primary.facade);
      this.activeType = primary.selected;
      this.facadePromise = primaryPromise;
      this.allFacades.set(primary.selected, primaryPromise);
      for (const [type, facade] of facades) {
        if (type !== primary.selected) {
          this.allFacades.set(type, Promise.resolve(facade));
        }
      }
    });
  }

  private async requireViceBackend(): Promise<ViceBackend> {
    const facade = await this.facadePromise;
    if (facade.type !== "vice") {
      throw new Error("VICE-specific operation requested while connected to Ultimate hardware");
    }
    return facade as ViceBackend;
  }

  async getBackendType(): Promise<DeviceType> {
    return this.getActiveBackendType();
  }

  /**
   * Snapshot the facade currently active for this invocation. A multi-step
   * flow (pause/read/write/resume, or repeated polling) must resolve the
   * facade once and reuse that same instance for every step, so a concurrent
   * `switchBackend` cannot retarget an operation already underway.
   */
  async pinFacade(): Promise<C64Facade> {
    return this.facadePromise;
  }

  async getActiveBackendType(): Promise<DeviceType> {
    await this.initPromise;
    return this.activeType;
  }

  /**
   * Discover native endpoint availability without changing machine state.
   * `machine:input` has a safe GET probe; `machine:menu_screen` is only
   * distinguishable from an inactive menu once a menu is visible.
   */
  async getNativeEndpointCapabilities(): Promise<NativeEndpointCapabilities> {
    const facade = await this.facadePromise;
    if (facade.type === "vice") {
      return { machineInput: "unavailable", machineMenuScreen: "unavailable" };
    }
    if (facade.type === "u2") {
      return { machineInput: "unavailable", machineMenuScreen: "unknown" };
    }

    let probe = this.machineInputCapabilityProbes.get(facade.type);
    if (!probe) {
      probe = facade.getInputState({ timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS })
        .then(() => "available" as const)
        .catch((error) => isMissingEndpoint(error) ? "unavailable" as const : "unknown" as const);
      this.machineInputCapabilityProbes.set(facade.type, probe);
      // A transport error is not a capability result. Keep confirmed states,
      // but make a later resource read retry rather than poisoning the cache.
      void probe.then((result) => {
        if (result === "unknown" && this.machineInputCapabilityProbes.get(facade.type) === probe) {
          this.machineInputCapabilityProbes.delete(facade.type);
        }
      });
    }
    return { machineInput: await probe, machineMenuScreen: "unknown" };
  }

  getAvailableBackends(): DeviceType[] {
    return Array.from(this.allFacades.keys());
  }

  async prewarmBackends(types?: readonly DeviceType[]): Promise<Record<string, boolean>> {
    return withDiagnosticSpan("client", "prewarm_backends", { types: types ?? null }, async () => {
      await this.initPromise;
      const targets = (types && types.length > 0 ? [...types] : this.getAvailableBackends()).filter(
        (type, index, all) => all.indexOf(type) === index,
      );
      const entries = await Promise.all(targets.map(async (type) => {
        let warmup = this.warmupPromises.get(type);
        if (!warmup) {
          const facadePromise = this.allFacades.get(type);
          if (!facadePromise) {
            throw new Error(`Backend '${type}' is not configured`);
          }
          warmup = facadePromise.then((facade) => facade.ping()).catch(() => false);
          this.warmupPromises.set(type, warmup);
        }
        return [type, await warmup] as const;
      }));
      return Object.fromEntries(entries);
    });
  }

  switchBackend(type: DeviceType): void {
    const nextFacade = this.allFacades.get(type);
    if (!nextFacade) {
      throw new Error(`Backend '${type}' is not configured`);
    }
    // Platform state is owned by the caller so tool-level flows can update global routing explicitly.
    this.facadePromise = nextFacade;
    this.activeType = type;
    if (type !== "c64u" && this.c64uVideoCaptureSession) {
      void this.releaseVideoCapture().catch(() => {});
    }
    writeDiagnosticEvent("client_switch_backend", { backend: type });
  }

  private async withViceMonitor<T>(fn: (client: ViceClient) => Promise<T>): Promise<T> {
    const backend = await this.requireViceBackend();
    return backend.withMonitor(fn);
  }

  /**
   * Generate a BASIC program that opens the printer (device 4), prints the provided text,
   * and closes the channel. Assumes Commodore MPS (PETSCII) by default.
   */
  async printTextOnPrinterAndRun(options: {
    text: string;
    target?: "commodore" | "epson"; // default: commodore
    secondaryAddress?: 0 | 7; // MPS only; 0 = upper/graphics, 7 = lower/upper
    formFeed?: boolean; // if true, send FF (CHR$(12)) at end
  }): Promise<RunBasicResult> {
    const program = buildPrinterBasicProgram(options);
    return this.uploadAndRunBasic(program);
  }

  /**
   * Generate and run a Commodore MPS Bit Image Mode (BIM) program for one bitmap row,
   * optionally repeated.
   */
  async printBitmapOnCommodoreAndRun(options: {
    columns: number[];
    repeats?: number;
    useSubRepeat?: number; // if provided, uses BIM SUB to repeat next byte
    secondaryAddress?: 0 | 7;
    ensureMsb?: boolean; // default true (set bit7)
  }): Promise<RunBasicResult> {
    const program = buildCommodoreBitmapBasicProgram(options);
    return this.uploadAndRunBasic(program);
  }

  /**
   * Generate and run an Epson FX ESC/P bitmap program for one row (repeated lines).
   */
  async printBitmapOnEpsonAndRun(options: {
    columns: number[];
    mode?: "K" | "L" | "Y" | "Z" | "*";
    density?: number; // used with '*'
    repeats?: number;
    timesPerLine?: number;
  }): Promise<RunBasicResult> {
    const program = buildEpsonBitmapBasicProgram(options);
    return this.uploadAndRunBasic(program);
  }

  /**
   * Generate and run a Commodore MPS DLL (custom characters) program. On emulator this
   * is ignored but we still verify generation and transmission.
   */
  async defineCustomCharsOnCommodoreAndRun(options: {
    firstChar: number; // 33..126
    chars: Array<{ a?: 0 | 1; columns: number[] }>; // 11 columns per char
    secondaryAddress?: 0 | 7;
  }): Promise<RunBasicResult> {
    const program = buildCommodoreDllBasicProgram(options);
    return this.uploadAndRunBasic(program);
  }

  async uploadAndRunBasic(program: string): Promise<RunBasicResult> {
    return withDiagnosticSpan("client", "upload_run_basic", { programLength: program.length }, async () => {
      const prg = basicToPrg(program);
      return this.runPrg(prg);
    });
  }

  /**
   * Render a sprite directly by writing sprite data, screen memory, and VIC-II registers.
   */
  async generateAndRunSpritePrg(options: {
    spriteBytes: Uint8Array | Buffer;
    spriteIndex?: number;
    x?: number;
    y?: number;
    color?: number;
    multicolour?: boolean;
    dataAddress?: number;
  }): Promise<RunBasicResult> {
    return this.displaySprite(options);
  }

  /**
   * Build a BASIC program that draws a PETSCII screen (optionally set border/bg colours),
   * then upload and run it.
   */
  async renderPetsciiScreenAndRun(options: {
    text: string;
    borderColor?: number;
    backgroundColor?: number;
  }): Promise<RunBasicResult> {
    const program = buildPetsciiScreenBasic(options);
    return this.uploadAndRunBasic(program);
  }

  async renderGreetingScreen(options: {
    readonly message: string;
    readonly borderColor?: number;
    readonly backgroundColor?: number;
  }): Promise<RunBasicResult> {
    return withDiagnosticSpan("client", "render_greeting_screen", { messageLength: options.message.length }, async () => {
      try {
        const facade = await this.facadePromise;
        const currentDd00 = await this.getGreetingDd00(facade.type, facade);
        const textRegisters = buildVicTextRegisters({
          currentDd00,
          borderColor: options.borderColor ?? DEFAULT_BORDER_COLOR,
          backgroundColor: options.backgroundColor ?? DEFAULT_BACKGROUND_COLOR,
        });
        const { screenRam, rows, warnings } = buildGreetingScreenRam(options.message);
        const colorRam = new Uint8Array(TEXT_SCREEN_SIZE).fill(DEFAULT_TEXT_FOREGROUND);

        const writes = [
          { address: TEXT_SCREEN_ADDRESS, bytes: screenRam },
          { address: TEXT_COLOR_RAM_ADDRESS, bytes: colorRam },
          { address: 0xDD00, bytes: Uint8Array.of(textRegisters.dd00) },
          { address: 0xD011, bytes: Uint8Array.of(textRegisters.d011) },
          { address: 0xD016, bytes: Uint8Array.of(textRegisters.d016) },
          { address: 0xD018, bytes: Uint8Array.of(textRegisters.d018) },
          { address: 0xD020, bytes: Uint8Array.of(textRegisters.d020) },
          { address: 0xD021, bytes: Uint8Array.of(textRegisters.d021) },
        ] as const;

        if (typeof facade.writeMemoryBlocks === "function") {
          await facade.writeMemoryBlocks(writes);
        } else {
          for (const write of writes) {
            await facade.writeMemory(write.address, write.bytes);
          }
        }

        return {
          success: true,
          details: {
            mode: "direct_screen_write",
            screenAddress: this.formatAddress(TEXT_SCREEN_ADDRESS),
            colorRamAddress: this.formatAddress(TEXT_COLOR_RAM_ADDRESS),
            registers: textRegisters,
            message: options.message,
            rows,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
        };
      } catch (error) {
        return {
          success: false,
          details: this.normaliseError(error),
        };
      }
    });
  }

  /**
   * Shows a sprite in the VIC bank and screen mode the machine currently uses: it writes the
   * 64-byte sprite block, its pointer and the sprite's own registers, and leaves $DD00, $D011,
   * $D016, $D018 and the colours alone. `dataAddress` (a multiple of 64 inside the current bank)
   * chooses where the block goes; by default it goes to bank + $2000, $3000 or $0800 (+ 64 per
   * sprite index), the first one clear of the screen, character set and bitmap in use.
   */
  async displaySprite(options: {
    readonly spriteBytes: Uint8Array | Buffer;
    readonly spriteIndex?: number;
    readonly x?: number;
    readonly y?: number;
    readonly color?: number;
    readonly multicolour?: boolean;
    readonly dataAddress?: number;
  }): Promise<RunBasicResult & { details?: SpriteDisplayResult | unknown }> {
    try {
      const index = Math.max(0, Math.min(7, Math.floor(options.spriteIndex ?? 0)));
      const x = Math.max(0, Math.min(511, Math.floor(options.x ?? 100)));
      const y = Math.max(0, Math.min(255, Math.floor(options.y ?? 100)));
      const color = normaliseColorNibble(options.color ?? 1);
      const multicolour = options.multicolour === true;
      const spriteBytes = Buffer.from(options.spriteBytes);
      if (spriteBytes.length !== 63) {
        throw new Error("spriteBytes must be exactly 63 bytes");
      }

      const spriteSlot = Buffer.alloc(64, 0x00);
      spriteBytes.copy(spriteSlot, 0, 0, 63);

      const facade = await this.facadePromise;
      const warnings: string[] = [];
      // $D010-$D01C in one read; it stops before the collision registers $D01E/$D01F, which clear when read.
      let vic: Uint8Array | undefined;
      let dd00: number | undefined;
      try {
        dd00 = (await facade.readMemory(0xDD00, 1))[0];
        vic = await facade.readMemory(0xD010, 13);
      } catch (error) {
        warnings.push(`The VIC registers could not be read (${error instanceof Error ? error.message : String(error)}); the default screen at $0400 in bank 0 was assumed.`);
      }
      const reg = (address: number): number => vic?.[address - 0xD010] ?? 0;
      const layout = screenLayoutFromRegisters(vic ? reg(0xD018) : undefined, dd00);
      const screenAddress = layout.baseAddress;
      const bankBase = screenAddress & 0xC000;
      const bank = bankBase >> 14;
      const d011 = reg(0xD011);
      const d018 = layout.registers ? reg(0xD018) : 0x14;

      const spriteAddress = options.dataAddress === undefined
        ? defaultSpriteDataAddress(bankBase, index, { screenAddress, d011, d018 })
        : checkedSpriteDataAddress(options.dataAddress, bankBase);
      const pointerAddress = screenAddress + 0x03F8 + index;
      if (pointerAddress >= 0xD000 && pointerAddress <= 0xDFFF) {
        throw new Error(`The screen at $${hex4(screenAddress)} lies under the I/O area, so its sprite pointer at $${hex4(pointerAddress)} cannot be written.`);
      }
      const pointerValue = (spriteAddress & 0x3FFF) >> 6;
      const bitMask = 1 << index;
      const d010 = (reg(0xD010) & ~bitMask) | (x > 0xFF ? bitMask : 0);
      const d015 = reg(0xD015) | bitMask;
      const d01c = (reg(0xD01C) & ~bitMask) | (multicolour ? bitMask : 0);

      await this.writeBlocks(facade, [
        { address: spriteAddress, bytes: spriteSlot },
        { address: pointerAddress, bytes: Uint8Array.of(pointerValue) },
        { address: 0xD000 + index * 2, bytes: Uint8Array.of(x & 0xFF, y) },
        { address: 0xD010, bytes: Uint8Array.of(d010) },
        { address: 0xD015, bytes: Uint8Array.of(d015) },
        { address: 0xD01C, bytes: Uint8Array.of(d01c) },
        { address: 0xD027 + index, bytes: Uint8Array.of(color) },
      ]);

      return {
        success: true,
        details: {
          bank,
          spriteAddress: this.formatAddress(spriteAddress),
          screenAddress: this.formatAddress(screenAddress),
          pointerAddress: this.formatAddress(pointerAddress),
          pointerValue,
          registers: { dd00: dd00 ?? 0, d011, d018, d010, d015, d01c },
          index,
          x,
          y,
          color,
          multicolour,
          spriteByteLength: spriteBytes.length,
          ...(warnings.length > 0 ? { warnings } : {}),
        } satisfies SpriteDisplayResult,
      };
    } catch (error) {
      return {
        success: false,
        details: this.normaliseError(error),
      };
    }
  }

  /** Writes blocks in order: one call when the backend can batch them, else one write per block. */
  private async writeBlocks(facade: C64Facade, blocks: ReadonlyArray<{ address: number; bytes: Uint8Array }>): Promise<void> {
    if (typeof facade.writeMemoryBlocks === "function") {
      await facade.writeMemoryBlocks(blocks);
      return;
    }
    for (const block of blocks) {
      await facade.writeMemory(block.address, block.bytes);
    }
  }

  async displayBitmap(bitmap: PreparedVicBitmap, options?: {
    readonly bitmapAddress?: number;
    readonly screenAddress?: number;
  }): Promise<RunBasicResult & { details?: BitmapDisplayResult | unknown }> {
    try {
      const layout = resolveVicBitmapMemoryLayout(
        options?.bitmapAddress ?? 0x2000,
        options?.screenAddress ?? 0x0400,
      );
      const facade = await this.facadePromise;
      let currentDd00 = 0;
      try {
        const dd00 = await facade.readMemory(0xDD00, 1);
        currentDd00 = dd00[0] ?? 0;
      } catch {
        currentDd00 = 0;
      }

      const registers = buildVicBitmapRegisters(layout, {
        mode: bitmap.mode,
        backgroundColor: bitmap.backgroundColor,
        borderColor: bitmap.borderColor,
        currentDd00,
      });

      // Data first, then the registers that make the VIC-II show it.
      await this.writeBlocks(facade, [
        { address: layout.bitmapAddress, bytes: bitmap.bitmapData },
        { address: layout.screenAddress, bytes: bitmap.screenRam },
        { address: layout.colorRamAddress, bytes: bitmap.colorRam },
        { address: 0xDD00, bytes: Uint8Array.of(registers.dd00) },
        { address: 0xD011, bytes: Uint8Array.of(registers.d011) },
        { address: 0xD016, bytes: Uint8Array.of(registers.d016) },
        { address: 0xD018, bytes: Uint8Array.of(registers.d018) },
        { address: 0xD020, bytes: Uint8Array.of(registers.d020, registers.d021) },
      ]);

      return {
        success: true,
        details: {
          mode: bitmap.mode,
          bank: layout.bank,
          bitmapAddress: this.formatAddress(layout.bitmapAddress),
          screenAddress: this.formatAddress(layout.screenAddress),
          colorRamAddress: this.formatAddress(layout.colorRamAddress),
          registers,
          bitmapBytes: bitmap.bitmapData.length,
          screenBytes: bitmap.screenRam.length,
          colorRamBytes: bitmap.colorRam.length,
        } satisfies BitmapDisplayResult,
      };
    } catch (error) {
      return {
        success: false,
        details: this.normaliseError(error),
      };
    }
  }

  /**
   * Assemble, load, and execute a pure machine-code program. Loading a PRG
   * with LOAD+RUN (the generic path used by {@link runPrg}) is only correct
   * for tokenized BASIC text: RUN misinterprets raw 6510 opcodes as BASIC
   * tokens, and setting BASIC's TXTTAB/VARTAB/ARYTAB/STREND to the code
   * range corrupts the workspace. Instead this loads the assembled bytes
   * without running them, then types `SYS <entry>` to transfer control
   * to the entry point: the target of a leading SYS stub at $0801, or else
   * the first assembled instruction.
   */
  async uploadAndRunAsm(program: string, assembledProgram?: ReturnType<typeof assemblyToPrgDetailed>): Promise<RunBasicResult> {
    try {
      const assembled = assembledProgram ?? assemblyToPrgDetailed(program);
      const prg = assembled.prg;
      if (prg.length < 2) {
        return { success: false, details: { message: "Assembled program produced no output" } };
      }
      const entryAddress = assembled.entryAddress;
      if (prg.readUInt16LE(0) === 0x0801 && prgEntryAddress(prg) === 0x0801) {
        // Loading makes BASIC relink $0801 as program lines, which overwrites raw code there.
        return {
          success: false,
          details: {
            message: "Machine code at $0801 is overwritten when BASIC relinks the loaded program. Omit the origin to get a BASIC SYS stub automatically, start the code with a BASIC SYS line, or assemble at another address such as $C000.",
          },
        };
      }
      const facade = await this.facadePromise;
      const loadResult = await facade.loadPrg(prg);
      if (!loadResult.success) {
        return { success: false, details: loadResult.details };
      }
      const sysCommand = Buffer.from(`SYS${entryAddress}\r`, "ascii");
      const injectResult = await this.injectKeyboardQueue(sysCommand, { pinnedFacade: facade });
      const keyboard = injectResult.status === undefined
        ? undefined
        : {
            status: injectResult.status,
            ...(injectResult.pending === undefined ? {} : { pending: injectResult.pending }),
            ...(injectResult.stoppedAt === undefined ? {} : { stoppedAt: injectResult.stoppedAt }),
          };
      if (injectResult.status === "stopped") {
        // A checkpoint hit while SYS was typed: the program is loaded but was not started.
        return {
          success: false,
          details: {
            message: `The program was loaded, but typing SYS${entryAddress} was stopped by a checkpoint${injectResult.stoppedAt === undefined ? "" : ` at $${injectResult.stoppedAt.toString(16).toUpperCase().padStart(4, "0")}`}; it was not started.`,
            started: false,
            load: loadResult.details,
            entryAddress,
            delivered: injectResult.delivered,
            keyboard,
          },
        };
      }
      return {
        success: true,
        details: { load: loadResult.details, entryAddress, delivered: injectResult.delivered, ...(keyboard ? { keyboard } : {}) },
      };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async runPrg(prg: Uint8Array | Buffer): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.runPrg(prg);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async loadPrg(prg: Uint8Array | Buffer): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.loadPrg(prg);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  /** Upload a SID binary and instruct firmware to play it (attachment mode). */
  async sidplayAttachment(sid: Uint8Array | Buffer, options?: { songnr?: number; songlengths?: Uint8Array | Buffer }): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.sidplayAttachment(sid, options);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async loadPrgFile(path: string): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.loadPrgFile(path);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async runPrgFile(path: string): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.runPrgFile(path);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async runCrtFile(path: string): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.runCrtFile(path);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  /** Uploads a cartridge image and runs it (Ultimate only). */
  async runCrt(crt: Uint8Array | Buffer): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      if (!facade.runCrt) throw new Error("Uploading a CRT image is not supported by the selected backend");
      const res = await facade.runCrt(crt);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async sidplayFile(path: string, songnr?: number): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.sidplayFile(path, songnr);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async modplayFile(path: string): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      if (!facade.modplayFile) throw new Error("modplay not supported by selected backend");
      const res = await facade.modplayFile(path);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async readScreen(): Promise<string> {
    return (await this.readScreenDetailed()).text;
  }

  /**
   * Reads the text screen where the VIC-II currently shows it: the screen
   * base comes from $D018 bits 4-7 and the VIC bank from $DD00 bits 0-1, and
   * $D018 bit 1 selects the lower-case character set. Reads of both registers
   * that fail, or that both return $00 (not a usable VIC state), fall back to
   * the default $0400 and the upper-case set.
   */
  async readScreenDetailed(): Promise<{ text: string; baseAddress: number; charset: "upper" | "lower"; registers?: { d018: number; dd00: number } }> {
    return withDiagnosticSpan("client", "read_screen", {}, async () => {
      const facade = await this.facadePromise;
      if (facade.readScreenState) {
        const state = await facade.readScreenState();
        const text = screenCodesToAscii(state.bytes, { columns: 40, rows: 25, charset: state.charset });
        return { text, baseAddress: state.baseAddress, charset: state.charset, ...(state.registers ? { registers: { ...state.registers } } : {}) };
      }
      let baseAddress = 0x0400;
      let charset: "upper" | "lower" = "upper";
      let registers: { d018: number; dd00: number } | undefined;
      try {
        const d018 = (await this.readMemoryRaw(0xd018, 1, facade))[0];
        const dd00 = (await this.readMemoryRaw(0xdd00, 1, facade))[0];
        const layout = screenLayoutFromRegisters(d018, dd00);
        baseAddress = layout.baseAddress;
        charset = layout.charset;
        if (layout.registers) registers = { ...layout.registers };
      } catch {
        // Keep the defaults when the VIC registers cannot be read.
      }
      const length = Math.min(0x03e8, 0x10000 - baseAddress);
      // All three reads use the facade resolved above, so a backend switch cannot mix two machines.
      const bytes = await this.readMemoryRaw(baseAddress, length, facade);
      const text = screenCodesToAscii(bytes, { columns: 40, rows: 25, charset });
      return { text, baseAddress, charset, ...(registers ? { registers } : {}) };
    });
  }

  async reset(): Promise<{ success: boolean; details?: unknown }> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.reset();
      if (!res.success) return { success: res.success, details: res.details };
      if (facade.type === "vice" || !this.pauseStateFor(facade).explicit) {
        this.clearExplicitPause(facade);
        return { success: res.success, details: res.details };
      }
      return await this.resumeAfterUltimateReset(facade, res);
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  /**
   * On Ultimate hardware a reset issued while the machine is paused leaves the
   * CPU stopped until a resume is sent (a reboot does not). Send the resume so
   * the machine runs again, then clear the explicit-pause flag. If a running
   * tool call still holds an owned pause, the machine stays paused for that
   * call and its release sends the resume. If the resume fails, the explicit
   * pause stays recorded because the CPU is still stopped, and the result
   * carries a warning.
   */
  private async resumeAfterUltimateReset(facade: C64Facade, res: RunBasicResult): Promise<{ success: boolean; details?: unknown }> {
    const state = this.pauseStateFor(facade);
    if (state.depth > 0) {
      state.explicit = false;
      return { success: res.success, details: res.details };
    }
    // Pause acquisition and explicit pause wait on resetResume, so no pause can be skipped
    // against the explicit flag while this resume is pending and then lose it when the flag clears.
    const pendingResume = facade.resume().catch((error): RunBasicResult => ({ success: false, details: this.normaliseError(error) }));
    state.resetResume = pendingResume;
    let resumed: RunBasicResult;
    try { resumed = await pendingResume; } finally { if (state.resetResume === pendingResume) state.resetResume = undefined; }
    if (resumed.success) {
      state.explicit = false;
      return { success: res.success, details: res.details };
    }
    const base = res.details && typeof res.details === "object" && !Array.isArray(res.details) ? res.details as Record<string, unknown> : { response: res.details };
    return {
      success: res.success,
      details: {
        ...base,
        warning: "The reset succeeded, but the machine was paused and could not be resumed afterwards, so the CPU may still be stopped. Run c64_system resume.",
        resumeError: resumed.details,
      },
    };
  }

  async reboot(): Promise<{ success: boolean; details?: unknown }> {
    try {
      const facade = await this.facadePromise;
      const res = await facade.reboot();
      if (res.success) this.clearExplicitPause(facade);
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async readMemory(addressInput: string, lengthInput: string, pinnedFacade?: C64Facade): Promise<MemoryReadResult> {
    try {
      const resolved = resolveAddressSymbol(addressInput);
      const address = resolved ?? this.parseNumeric(addressInput);
      const length = this.parseNumeric(lengthInput);
      validateMemoryRange(address, length);

      const rawBytes = await this.readMemoryRaw(address, length, pinnedFacade);
      const bytes = rawBytes.slice(0, length);

      return {
        success: true,
        data: this.bytesToHex(bytes),
        details: {
          address: this.formatAddress(address),
          length,
        },
      };
    } catch (error) {
      return {
        success: false,
        details: this.normaliseError(error),
      };
    }
  }

  async writeMemory(addressInput: string, bytesInput: string, pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    try {
      const resolved = resolveAddressSymbol(addressInput);
      const address = resolved ?? this.parseNumeric(addressInput);
      const dataBuffer = this.hexStringToBuffer(bytesInput);
      validateMemoryRange(address, dataBuffer.length);

      // Prefer PUT with hex data for up to 128 bytes; fall back to POST binary for larger writes
      const addrStr = this.formatAddress(address);
      try {
        const facade = pinnedFacade ?? await this.facadePromise;
        await facade.writeMemory(address, dataBuffer);
        return {
          success: true,
          details: {
            address: addrStr,
            bytes: this.bytesToHex(dataBuffer),
          },
        };
      } catch (facadeError) {
        if (!(facadeError instanceof Error) || (facadeError as any).code !== "UNSUPPORTED") {
          throw facadeError;
        }
      }

      let response: unknown;
      if (dataBuffer.length <= 128) {
        const put = await this.api.v1.machineWritememUpdate(":writemem", {
          address: addrStr,
          data: this.bytesToHex(dataBuffer, false),
        });
        response = put.data;
      } else {
        const post = await this.api.v1.machineWritememCreate(
          ":writemem",
          { address: addrStr },
          Buffer.from(dataBuffer) as unknown as File,
          { headers: { "Content-Type": "application/octet-stream" } },
        );
        response = post.data;
      }

      return {
        success: true,
        details: {
          address: addrStr,
          bytes: this.bytesToHex(dataBuffer),
          response,
        },
      };
    } catch (error) {
      return {
        success: false,
        details: this.normaliseError(error),
      };
    }
  }

  // --- SID/Music helpers ---

  /**
   * Writes $D418. Its low nibble is the volume; bits 4-6 select the low-, band- and high-pass
   * filter and bit 7 turns voice 3 off. The register is write-only, so the upper bits cannot be
   * kept: they are `filterMode` (0-15, bit 0 = low-pass ... bit 3 = voice 3 off), or 0, which
   * switches the filter modes off. The result states the value written.
   */
  async sidSetVolume(volume: number, pinnedFacade?: C64Facade, options?: { readonly filterMode?: number }): Promise<RunBasicResult> {
    const clamped = Math.max(0, Math.min(15, Math.floor(volume)));
    const filterMode = options?.filterMode === undefined ? undefined : Math.max(0, Math.min(15, Math.floor(options.filterMode)));
    const value = ((filterMode ?? 0) << 4) | clamped;
    const result = await this.writeMemory("$D418", this.bytesToHex(Uint8Array.of(value)), pinnedFacade);
    if (!result.success) return result;
    const details = (result.details && typeof result.details === "object" ? result.details : {}) as Record<string, unknown>;
    return {
      ...result,
      details: {
        ...details,
        value,
        ...(filterMode === undefined
          ? { notice: "$D418 is write-only, so its filter mode bits 4-7 were set to 0: a low-, band- or high-pass filter in use is now off and voice 3 is on." }
          : {}),
      },
    };
  }

  async sidReset(hard = false): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      // Unhooking a running SIDWAVE player is best-effort: a failed read must not stop the SID being silenced.
      const stoppedSidwavePlayer = await this.stopSidwaveIrqPlayer(facade).catch(() => false);
      this.sidControl.delete(facade);
      if (hard) {
        const span = 0x19;
        await this.writeBlocks(facade, [
          { address: 0xd400, bytes: Buffer.alloc(span, 0xff) },
          { address: 0xd400, bytes: Buffer.alloc(span, 0x00) },
        ]);
        return { success: true, ...(stoppedSidwavePlayer ? { details: { stoppedSidwavePlayer } } : {}) };
      }
      // Gate and waveform off on all three voices, then volume 0, in one batch.
      await this.writeBlocks(facade, [
        { address: 0xd404, bytes: Uint8Array.of(0x00) },
        { address: 0xd40b, bytes: Uint8Array.of(0x00) },
        { address: 0xd412, bytes: Uint8Array.of(0x00) },
        { address: 0xd418, bytes: Uint8Array.of(0x00) },
      ]);
      return { success: true, ...(stoppedSidwavePlayer ? { details: { stoppedSidwavePlayer } } : {}) };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  /**
   * A SIDWAVE PRG keeps playing from the IRQ after the SID is silenced. Its
   * IRQ handler is "JSR play / JMP $EA31", and its play vector at $0813 is
   * "JMP play". When $0314 points at such a handler, point it back at the
   * KERNAL handler so silencing sticks; other programs' IRQ handlers are left
   * alone. Both vector bytes go in one write.
   */
  private async stopSidwaveIrqPlayer(facade: C64Facade): Promise<boolean> {
    const vector = await facade.readMemory(0x0314, 2);
    const handler = (vector[0] ?? 0) | ((vector[1] ?? 0) << 8);
    // A handler too close to $FFFF cannot hold the 6-byte SIDWAVE handler (and the read would cross $FFFF).
    if (handler === 0xea31 || handler > 0xfffa) return false;
    const code = await facade.readMemory(handler, 6);
    const playVector = await facade.readMemory(SIDWAVE_PLAY_ADDRESS, 3);
    const isSidwaveHandler = code[0] === 0x20 && code[3] === 0x4c && code[4] === 0x31 && code[5] === 0xea
      && playVector[0] === 0x4c && playVector[1] === code[1] && playVector[2] === code[2];
    if (!isSidwaveHandler) return false;
    await facade.writeMemory(0x0314, Uint8Array.of(0x31, 0xea));
    return true;
  }

  async sidNoteOn(options: {
    voice?: 1 | 2 | 3;
    note?: string; // e.g. "A4", "C#5", "Bb3"
    frequencyHz?: number;
    system?: "PAL" | "NTSC";
    waveform?: "pulse" | "saw" | "tri" | "noise";
    pulseWidth?: number; // 0..4095 (12-bit)
    attack?: number; // 0..15
    decay?: number; // 0..15
    sustain?: number; // 0..15
    release?: number; // 0..15
  }, pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    const voice = options.voice ?? 1;
    if (voice < 1 || voice > 3) {
      return { success: false, details: { message: "Voice must be 1..3" } };
    }
    const system = options.system ?? "PAL";
    // The tool schema documents that a note name overrides frequencyHz.
    const hz = options.note ? this.noteNameToHz(options.note) : options.frequencyHz ?? 440;
    // The 16-bit frequency register tops out at about 3848 Hz on PAL and 3995 Hz
    // on NTSC (B7 is already above the PAL limit); report it instead of clamping.
    const maxHz = (0xffff * (system === "PAL" ? 985_248 : 1_022_727)) / 16_777_216;
    if (hz > maxHz + 0.5) {
      return {
        success: false,
        details: { message: `${options.note ?? `${hz} Hz`} (${hz.toFixed(1)} Hz) is above the SID's highest ${system} frequency of ${maxHz.toFixed(1)} Hz` },
      };
    }
    const freq16 = this.hzToSidFrequency(hz, system);
    const freqLo = freq16 & 0xff;
    const freqHi = (freq16 >> 8) & 0xff;

    const pulseWidth = Math.max(0, Math.min(0x0fff, Math.floor(options.pulseWidth ?? 0x0800)));
    const pwLo = pulseWidth & 0xff;
    const pwHi = (pulseWidth >> 8) & 0x0f; // upper 4 bits used

    const waveform = options.waveform ?? "pulse";
    let ctrl = 0x00;
    if (waveform === "tri") ctrl |= 1 << 4;
    else if (waveform === "saw") ctrl |= 1 << 5;
    else if (waveform === "pulse") ctrl |= 1 << 6;
    else if (waveform === "noise") ctrl |= 1 << 7;
    ctrl |= 1 << 0; // GATE on

    const attack = Math.max(0, Math.min(15, Math.floor(options.attack ?? 0x1)));
    const decay = Math.max(0, Math.min(15, Math.floor(options.decay ?? 0x1)));
    const sustain = Math.max(0, Math.min(15, Math.floor(options.sustain ?? 0xf)));
    const release = Math.max(0, Math.min(15, Math.floor(options.release ?? 0x3)));
    const ad = (attack << 4) | decay;
    const sr = (sustain << 4) | release;

    const base = 0xd400 + (voice - 1) * 7;
    const bytes = Buffer.from([freqLo, freqHi, pwLo, pwHi, ctrl, ad, sr]);
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      await facade.writeMemory(base, bytes);
      this.sidControlFor(facade)[voice - 1] = ctrl;
      return { success: true };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async sidNoteOff(voice: 1 | 2 | 3, pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    if (voice < 1 || voice > 3) {
      return { success: false, details: { message: "Voice must be 1..3" } };
    }
    const ctrlAddr = 0xd400 + (voice - 1) * 7 + 4;
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      // Clearing only the gate bit starts the release phase with the waveform still sounding.
      // The SID registers are write-only, so the control byte is the one note_on last wrote.
      const last = this.sidControlFor(facade)[voice - 1];
      const control = last === undefined ? 0x00 : last & 0xfe;
      await facade.writeMemory(ctrlAddr, Uint8Array.of(control));
      if (last === undefined) {
        return { success: true, details: { control, notice: "No note_on was sent to this voice through this server, so the waveform is unknown; the control register was set to $00, which ends the note without a release." } };
      }
      this.sidControlFor(facade)[voice - 1] = control;
      return { success: true, details: { control } };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  /** Control register values ($D404, $D40B, $D412) last written by sidNoteOn/sidNoteOff, per backend. */
  private readonly sidControl = new WeakMap<C64Facade, Array<number | undefined>>();

  private sidControlFor(facade: C64Facade): Array<number | undefined> {
    let control = this.sidControl.get(facade);
    if (!control) {
      control = [undefined, undefined, undefined];
      this.sidControl.set(facade, control);
    }
    return control;
  }

  async sidSilenceAll(): Promise<RunBasicResult> {
    return this.sidReset(false);
  }

  // --- Additional API wrappers to cover full REST surface ---

  async version(): Promise<unknown> {
    const facade = await this.facadePromise;
    return facade.version();
  }

  async info(): Promise<unknown> {
    const facade = await this.facadePromise;
    return facade.info();
  }

  async pause(pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      return await facade.pause();
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async resume(pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    try {
      const facade = pinnedFacade ?? await this.facadePromise; return await facade.resume();
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  /**
   * Pause bookkeeping per facade. Tools that pause for their own purpose
   * (acquirePause/releasePause) share one device pause: it is sent when the
   * owned depth goes 0 -> 1 and the machine is not already explicitly paused,
   * and the device resume is sent only when the depth returns to 0 and no
   * explicit `c64_system pause` is in effect. An explicit pause is cleared
   * only by an explicit resume.
   */
  private readonly pauseStates = new WeakMap<C64Facade, { depth: number; explicit: boolean; devicePause?: Promise<RunBasicResult>; skippedDevicePause?: boolean; resetResume?: Promise<unknown> }>();

  private pauseStateFor(facade: C64Facade) {
    let state = this.pauseStates.get(facade);
    if (!state) {
      const created: { depth: number; explicit: boolean; devicePause?: Promise<RunBasicResult>; skippedDevicePause?: boolean; resetResume?: Promise<unknown> } = { depth: 0, explicit: false };
      state = created;
      this.pauseStates.set(facade, state);
      // The VICE session can end the pause by itself (c64_debug continue_execution, a lost
      // session, a restart); the explicit flag must follow or tools would skip their own pause.
      if (facade instanceof ViceBackend) facade.setPauseClearedListener(() => { created.explicit = false; });
    }
    return state;
  }

  /** A failed resume leaves the CPU possibly paused: keep that visible as an explicit pause so later tools do not assume a running machine, and warn. */
  private afterResume(state: { explicit: boolean }, result: RunBasicResult): RunBasicResult {
    if (result.success) return result;
    state.explicit = true;
    const details = (result.details && typeof result.details === "object" ? result.details : { message: String(result.details ?? "") }) as Record<string, unknown>;
    return { ...result, details: { ...details, warning: "The resume failed; the machine may still be paused. Call c64_system resume once the device is reachable." } };
  }

  /** Owned pause for one tool call. Pass the facade pinned at call start; pair with releasePause. A failed result holds no pause and needs no release. */
  async acquirePause(pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      const state = this.pauseStateFor(facade);
      // A reset's post-reset resume decides the explicit flag; wait for it so the pause below is sent when needed.
      while (state.resetResume) await state.resetResume;
      state.depth += 1;
      if (state.depth === 1 && !state.explicit) {
        // A debugger stop already holds the CPU; the tool call must neither add a pause nor end that stop on release.
        state.skippedDevicePause = facade instanceof ViceBackend && facade.isCpuStopped();
        if (!state.skippedDevicePause) {
          const request = facade instanceof ViceBackend ? facade.pauseOwned() : facade.pause();
          const pending = request.catch((error): RunBasicResult => ({ success: false, details: this.normaliseError(error) })).then((result) => {
            // A debugger stop arrived while the pause waited its turn: it is that stop that holds the CPU, so release must not resume.
            if (result.success && (result.details as { debugStop?: boolean } | undefined)?.debugStop === true) state.skippedDevicePause = true;
            return result;
          });
          state.devicePause = pending;
        }
      }
      const result = state.devicePause ? await state.devicePause : { success: true } as RunBasicResult;
      if (!result.success) {
        state.depth -= 1;
        if (state.depth === 0) state.devicePause = undefined;
        return result;
      }
      return result;
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  /** Release one owned pause. The device resume is sent only by the last release and not while an explicit pause is in effect. */
  async releasePause(pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      const state = this.pauseStateFor(facade);
      if (state.depth === 0) return { success: true, details: { resumed: false, reason: "no owned pause" } };
      state.depth -= 1;
      if (state.depth > 0) return { success: true, details: { resumed: false, reason: "pause still held by another call" } };
      state.devicePause = undefined;
      if (state.skippedDevicePause) {
        state.skippedDevicePause = false;
        return { success: true, details: { resumed: false, reason: "the CPU was already stopped by the debugger" } };
      }
      if (state.explicit) return { success: true, details: { resumed: false, reason: "machine was paused explicitly" } };
      return this.afterResume(state, await facade.resume());
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  /** `c64_system pause`: stays in effect until an explicit resume, whatever tools acquire or release meanwhile. */
  async explicitPause(pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      const state = this.pauseStateFor(facade);
      while (state.resetResume) await state.resetResume;
      if (state.depth > 0 && !state.explicit && state.devicePause) {
        // Wait for the tool call's own pause: it may still fail, and then nothing holds the CPU.
        const devicePause = state.devicePause;
        const pending = await devicePause;
        // The owning call may have released (and resumed) while this call waited; then pause the device here.
        if (pending.success && state.depth > 0 && state.devicePause === devicePause) {
          state.explicit = true;
          return { success: true, details: { alreadyPaused: true } };
        }
      } else if (state.depth > 0 && !state.explicit) {
        state.explicit = true; // a debugger stop already holds the CPU
        return { success: true, details: { alreadyPaused: true } };
      }
      const result = await facade.pause();
      if (result.success) state.explicit = true;
      return result;
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  /** `c64_system resume`: clears the explicit pause. While a tool call still holds an owned pause, the device resume is left to its release. */
  async explicitResume(pinnedFacade?: C64Facade): Promise<RunBasicResult> {
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      const state = this.pauseStateFor(facade);
      state.explicit = false;
      if (state.depth > 0) return { success: true, details: { resumed: false, reason: "a running tool call still holds a pause; it resumes the machine when it finishes" } };
      return this.afterResume(state, await facade.resume());
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async poweroff(): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      const result = await facade.poweroff();
      if (result.success) this.clearExplicitPause(facade);
      return result;
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  /**
   * A reset, reboot, power-off or power cycle restarts the CPU, so an explicit
   * `c64_system pause` no longer holds. Without clearing the flag, later tool
   * calls would skip their own pause and read or write a running machine.
   */
  private clearExplicitPause(facade: C64Facade): void {
    this.pauseStateFor(facade).explicit = false;
  }

  /**
   * Start from a clean machine state. C64U/U64 firmware exposes this only in
   * the Tool Menu; U2-family firmware uses its equivalent REST reboot and
   * VICE is restarted when it is managed by c64bridge.
   */
  async powerCycle(): Promise<RunBasicResult> {
    let facade: C64Facade | undefined;
    try { facade = await this.facadePromise; } catch { facade = undefined; }
    const result = await this.powerCycleActiveBackend();
    if (result.success && facade) this.clearExplicitPause(facade);
    return result;
  }

  private async powerCycleActiveBackend(): Promise<RunBasicResult> {
    let menuOpened = false;
    let cleanup: RunBasicResult | undefined;
    let pinnedFacade: C64Facade | undefined;
    try {
      const facade = await this.facadePromise;
      pinnedFacade = facade;
      if (facade.type === "u2") {
        const result = await facade.reboot();
        return { ...result, details: { strategy: "reboot", result: result.details } };
      }
      if (facade.type === "vice") {
        const result = await facade.powerCycle();
        return { ...result, details: { strategy: "fresh_start", result: result.details } };
      }

      const endpoints = await this.getNativeEndpointCapabilities();
      if (endpoints.machineInput !== "available") {
        return {
          success: false,
          details: {
            code: "native_input_unavailable",
            message: "C64U/U64 Power Cycle requires machine:input and machine:menu_screen, which this firmware does not currently expose.",
            fallback: "Use c64_system reboot if a firmware reboot is acceptable, or power cycle from the device itself.",
          },
        };
      }

      const menuResult = await facade.menuButton();
      if (!menuResult.success) {
        throw new Error("Unable to open the Ultimate menu for power cycling");
      }
      menuOpened = true;
      const initial = await this.readVerifiedMenuScreen(facade, "open Ultimate menu");
      await this.requirePowerCycleInput(facade, ["f1"]);
      await this.readVerifiedMenuScreen(facade, "open Tool Menu", "TOOL MENU", initial);
      await this.requirePowerCycleInput(facade, ["return"]);
      let current = await this.readVerifiedMenuScreen(facade, "enter Tool Menu", "POWER CYCLE");
      for (let index = 0; index < 4; index += 1) {
        await this.requirePowerCycleInput(facade, ["cursor_up_down"]);
        current = await this.readVerifiedMenuScreen(
          facade,
          `move to Power Cycle (${index + 1}/4)`,
          "POWER CYCLE",
          current,
        );
      }
      if (!selectedMenuRowIncludes(current, "POWER CYCLE")) {
        throw new Error("Unable to verify that POWER CYCLE is the selected Tool Menu item; final RETURN was not sent.");
      }
      await this.requirePowerCycleInput(facade, ["return"]);
      return { success: true, details: { strategy: "tool_menu", verifiedMenu: "Tool Menu", selectedItem: "Power Cycle" } };
    } catch (error) {
      if (menuOpened) {
        try { cleanup = await pinnedFacade?.menuButton() ?? { success: false, details: "No facade available for menu cleanup" }; } catch (cleanupError) { cleanup = { success: false, details: this.normaliseError(cleanupError) }; }
      }
      if (isMissingEndpoint(error)) {
        return {
          success: false,
          details: {
            code: "native_menu_screen_unavailable",
            message: "C64U/U64 Power Cycle could not verify Tool Menu navigation because machine:menu_screen is unavailable.",
            fallback: "Use c64_system reboot if a firmware reboot is acceptable, or power cycle from the device itself.",
          },
        };
      }
      return { success: false, details: { error: this.normaliseError(error), cleanup: cleanup ?? { success: false, details: "menu cleanup was not attempted" } } };
    }
  }

  private async requirePowerCycleInput(facade: C64Facade, inputs: readonly string[]): Promise<void> {
    await facade.sendInputEvents({ events: [{ kind: "keyboard", inputs, transition: "tap" }] });
  }

  private async readVerifiedMenuScreen(
    facade: C64Facade,
    phase: string,
    requiredText?: string,
    previous?: Uint8Array,
  ): Promise<Uint8Array> {
    const matrix = await facade.readMenuScreen();
    if (matrix.length === 0) {
      throw new Error(`Unable to ${phase}: machine:menu_screen returned an empty matrix`);
    }
    if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(matrix)) === 0) {
      throw new Error(`Unable to ${phase}: machine:menu_screen did not change after menu input`);
    }
    if (requiredText && !menuMatrixIncludes(matrix, requiredText)) {
      throw new Error(`Unable to ${phase}: machine:menu_screen did not contain '${requiredText}'`);
    }
    return matrix;
  }

  async menuButton(): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise; return await facade.menuButton();
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async readMenuScreen(): Promise<Uint8Array> {
    const facade = await this.facadePromise;
    return facade.readMenuScreen();
  }

  async getInputState(): Promise<MachineInputState> {
    const facade = await this.facadePromise;
    return facade.getInputState();
  }

  async sendInputEvents(batch: MachineInputBatch): Promise<MachineInputState> {
    const facade = await this.facadePromise;
    return facade.sendInputEvents(batch);
  }

  async debugregRead(): Promise<{ success: boolean; value?: string; details?: unknown }> {
    try {
      const facade = await this.facadePromise; return await facade.debugregRead();
    } catch (error) { return { success: false, details: this.normaliseError(error) } as any; }
  }

  async debugregWrite(value: string): Promise<{ success: boolean; value?: string; details?: unknown }> {
    try {
      const facade = await this.facadePromise; return await facade.debugregWrite(value);
    } catch (error) { return { success: false, details: this.normaliseError(error) } as any; }
  }

  async drivesList(): Promise<unknown> {
    const facade = await this.facadePromise; return facade.drivesList();
  }

  async driveMount(
    drive: string,
    imagePath: string,
    options?: { type?: "d64" | "g64" | "d71" | "g71" | "d81"; mode?: "readwrite" | "readonly" | "unlinked" },
  ): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.driveMount(drive, imagePath, options); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  /** Uploads a disk image and mounts it (Ultimate only). */
  async driveMountImage(
    drive: string,
    image: Uint8Array | Buffer,
    options: { type: "d64" | "g64" | "d71" | "g71" | "d81"; mode?: "readwrite" | "readonly" | "unlinked" },
  ): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      if (!facade.driveMountImage) throw new Error("Uploading a disk image is not supported by the selected backend");
      return await facade.driveMountImage(drive, image, options);
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async driveRemove(drive: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.driveRemove(drive); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async driveReset(drive: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.driveReset(drive); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async driveOn(drive: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.driveOn(drive); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async driveOff(drive: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.driveOff(drive); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async driveLoadRom(drive: string, path: string): Promise<RunBasicResult> {
    try {
      if (!drive || !path) throw new Error("Drive and path are required");
      const facade = await this.facadePromise;
      const result = await facade.driveLoadRom(drive, path);
      return { success: result.success, details: result.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async driveSetMode(drive: string, mode: "1541" | "1571" | "1581"): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.driveSetMode(drive, mode); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async streamStart(stream: "video" | "audio" | "debug", ip: string): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      return await withStreamLock(stream, async () => {
        if (stream === "video") await this.stopC64uVideoCaptureSession(false);
        const result = await this.startStreamResolvingHost(facade, stream, ip);
        if (result.success) rememberUserStream(stream, ip);
        return result;
      });
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async streamStop(stream: "video" | "audio" | "debug"): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      return await withStreamLock(stream, async () => {
        if (stream === "video") await this.stopC64uVideoCaptureSession(false);
        const result = await facade.streamStop(stream);
        if (result.success) forgetUserStream(stream);
        return result;
      });
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async prepareVideoCapture(options?: { readonly keepAliveMs?: number }): Promise<void> {
    const keepAliveMs = Math.max(0, Math.trunc(options?.keepAliveMs ?? 1_000));
    const facade = await this.facadePromise;
    if (facade.type !== "c64u") {
      throw new Error("Reusable video capture is only available on C64 Ultimate");
    }
    await withStreamLock("video", async () => {
      await this.ensureC64uVideoCaptureSession(facade);
      this.scheduleC64uVideoCaptureStop(keepAliveMs);
    });
  }

  async releaseVideoCapture(): Promise<void> {
    await withStreamLock("video", () => this.stopC64uVideoCaptureSession());
  }

  /**
   * Captures video frames. On VICE a frame is cropped to the inner screen area VICE reports
   * (offset and size from Display Get); `includeBorder: true` returns the whole canvas VICE renders.
   */
  async captureFrames(options?: { readonly count?: number; readonly reuseSession?: boolean; readonly keepAliveMs?: number; readonly includeBorder?: boolean }): Promise<FrameCaptureResult> {
    return withDiagnosticSpan("client", "capture_frames", { count: options?.count ?? 1, reuseSession: options?.reuseSession === true }, async () => {
      const requestedCount = Math.max(1, Math.min(32, Math.trunc(options?.count ?? 1)));
      const facade = await this.facadePromise;
      if (facade.type === "vice") {
        return this.captureViceFrames(facade as ViceBackend, requestedCount, options?.includeBorder === true);
      }

      if (facade.type !== "c64u") {
        throw new Error("Video frame capture is only available on C64U/U64 and VICE; U2 has no video stream");
      }
      return this.captureC64uVideoFrames(facade, requestedCount, {
        reuseSession: options?.reuseSession === true,
        keepAliveMs: Math.max(0, Math.trunc(options?.keepAliveMs ?? 0)),
      });
    });
  }

  async captureSamples(options?: { readonly count?: number; readonly signal?: AbortSignal }): Promise<SampleCaptureResult> {
    options?.signal?.throwIfAborted();
    const requestedPairs = Math.max(1, Math.min(65_536, Math.trunc(options?.count ?? 256)));
    const facade = await this.facadePromise;
    if (facade.type !== "c64u") {
      throw new Error("Audio sample capture is only available on C64 Ultimate");
    }
    return this.captureC64uAudioSamples(facade, requestedPairs, { signal: options?.signal });
  }

  /**
   * Records and analyzes audio. On the C64 Ultimate the PCM comes from the
   * device audio stream; other backends have no stream, so the host microphone is used.
   */
  async recordAndAnalyzeAudio(params: RecordAndAnalyzeParams): Promise<AnalysisResult> {
    params.signal?.throwIfAborted();
    const durationSeconds = normalizeAudioDuration(params.durationSeconds);
    const facade = await this.facadePromise;
    if (facade.type !== "c64u") {
      return recordAndAnalyzeAudio(params);
    }

    const sampleRateHz = await this.getC64uAudioSampleRate(facade);
    const samplePairs = Math.ceil(durationSeconds * sampleRateHz);
    const capture = await this.captureC64uAudioSamples(facade, samplePairs, {
      timeoutMs: Math.ceil(durationSeconds * 1_500) + 2_000,
      sampleRateHz,
      acceptPartial: true,
      signal: params.signal,
    });
    return analyzeStereoStream(capture.samples, capture.sampleRateHz, params.expectedSidwave);
  }

  async configsList(): Promise<unknown> {
    const facade = await this.facadePromise;
    return facade.configsList();
  }

  async configGet(category: string, item?: string): Promise<unknown> {
    const facade = await this.facadePromise;
    return facade.configGet(category, item);
  }

  async configSet(category: string, item: string, value: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configSet(category, item, value); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async configBatchUpdate(payload: Record<string, object>): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configBatchUpdate(payload); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async configLoadFromFlash(category?: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configLoadFromFlash(category); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async configSaveToFlash(category?: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configSaveToFlash(category); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async configResetToDefault(category?: string): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configResetToDefault(category); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async filesInfo(path: string): Promise<unknown> {
    const facade = await this.facadePromise; return facade.filesInfo(path);
  }

  async filesCreateD64(path: string, options?: { tracks?: number; diskname?: string }): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.filesCreateD64(path, options); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async filesCreateD71(path: string, options?: { diskname?: string }): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.filesCreateD71(path, options); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async filesCreateD81(path: string, options?: { diskname?: string }): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.filesCreateD81(path, options); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async filesCreateDnp(path: string, tracks: number, options?: { diskname?: string }): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.filesCreateDnp(path, tracks, options); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  private extractBytes(data: unknown): Uint8Array {
    if (!data) {
      return new Uint8Array();
    }

    // Raw binary (ArrayBuffer) response
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }

    // Node.js Buffer
    if (Buffer.isBuffer(data)) {
      return new Uint8Array(data);
    }

    // Already a Uint8Array
    if (data instanceof Uint8Array) {
      return data;
    }

    if (typeof data === "string") {
      try {
        return Uint8Array.from(Buffer.from(data, "base64"));
      } catch {
        return Uint8Array.from(Buffer.from(data, "hex"));
      }
    }

    if (Array.isArray((data as { data?: unknown }).data)) {
      return Uint8Array.from(((data as { data?: number[] }).data) ?? []);
    }

    if (Array.isArray(data)) {
      return Uint8Array.from(data as number[]);
    }

    if (typeof data === "object" && data !== null) {
      const maybe = (data as Record<string, unknown>).data;
      if (typeof maybe === "string") {
        return Uint8Array.from(Buffer.from(maybe, "base64"));
      }
      if (Array.isArray(maybe)) {
        return Uint8Array.from(maybe as number[]);
      }
    }

    return new Uint8Array();
  }

  private async captureC64uVideoFrames(
    facade: C64Facade,
    count: number,
    options: { readonly reuseSession?: boolean; readonly keepAliveMs?: number } = {},
  ): Promise<FrameCaptureResult> {
    return withStreamLock("video", async () => {
      if (options.reuseSession) {
        try {
          const session = await this.ensureC64uVideoCaptureSession(facade);
          const frames = await this.collectFramesFromC64uVideoCaptureSession(session, count, { fresh: true });
          this.scheduleC64uVideoCaptureStop(options.keepAliveMs ?? 0);
          return { backend: "c64u", frames };
        } catch (error) {
          // ensureSession cancelled the keepalive timer. A failed collection
          // must close that session rather than leaving its stream alive forever.
          try { await this.stopC64uVideoCaptureSession(); }
          catch (cleanupError) {
            writeDiagnosticEvent("video_capture_stop_failed", { error: this.normaliseError(cleanupError) });
          }
          throw error;
        }
      }
      // A one-shot stream replaces the reusable socket's target. Invalidate that
      // session first so the next reusable capture starts a live stream again.
      await this.stopC64uVideoCaptureSession(false);
      let result: FrameCaptureResult | undefined;
      try {
        result = await this.captureC64uVideoFramesOnce(facade, count);
      } finally {
        const notes = await this.restoreUserStream(facade, "video");
        if (result && notes.length > 0) result = { ...result, warnings: [...(result.warnings ?? []), ...notes] };
      }
      return result;
    });
  }

  /** Restarts a stream the user started with c64_stream start after a capture replaced and stopped it. */
  private async restoreUserStream(facade: C64Facade, stream: "video" | "audio"): Promise<string[]> {
    const target = userStreamTarget(stream);
    if (!target) return [];
    try {
      await this.ensureStreamSuccess(await this.startStreamResolvingHost(facade, stream, target), `restart ${stream} stream`);
      return [`The ${stream} stream started with c64_stream was restarted toward ${target} after the capture.`];
    } catch (error) {
      writeDiagnosticEvent("user_stream_restart_failed", { stream, error: this.normaliseError(error) });
      return [`The ${stream} stream started with c64_stream could not be restarted toward ${target}: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  private async captureC64uVideoFramesOnce(facade: C64Facade, count: number): Promise<FrameCaptureResult> {
    const host = new URL(this.baseUrl).hostname;
    const { bindAddress, acceptsSource } = await this.resolveCaptureEndpoint(host);
    const socket = createSocket("udp4");
    const assembler = new VideoFrameAssembler(VIDEO_SESSION_MAX_PACKETS);
    const completed: CapturedFrame[] = [];
    let stopError: Error | null = null;
    let captureFailed = false;
    let streamAttempted = false;
    let stopped = false;
    // Stops the stream once. A failure is reported as a warning (success path)
    // or as a diagnostic (failure path); it never replaces the capture outcome.
    const stopOneShotVideoStream = async (): Promise<{ warnings?: string[] }> => {
      if (stopped) return {};
      stopped = true;
      try {
        await this.ensureStreamSuccess(await facade.streamStop("video"), "stop video stream");
        return {};
      } catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
        writeDiagnosticEvent("video_capture_stop_failed", { error: this.normaliseError(stopError) });
        return { warnings: [`Video stream stop failed after the capture: ${stopError.message}`] };
      }
    };

    try {
      await this.bindCaptureSocket(socket, bindAddress);
      const target = this.socketEndpoint(socket, bindAddress);
      streamAttempted = true;
      await this.ensureStreamSuccess(await this.startStreamResolvingHost(facade, "video", target), "start video stream");

      const frames = await new Promise<readonly CapturedFrame[]>((resolve, reject) => {
        const timeoutMs = Math.max(1_500, count * 750);
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms while capturing ${count} video frame(s)`));
        }, timeoutMs);

        socket.on("message", (msg, rinfo) => {
          if (!acceptsSource(rinfo.address)) return;
          try {
            const packet = this.parseVideoPacketOrNull(Buffer.from(msg));
            if (!packet) {
              return;
            }
            const assembled = assembler.add(packet);
            if (!assembled) {
              return;
            }
            completed.push(assembled.frame);
            if (completed.length >= count) {
              clearTimeout(timer);
              resolve(completed.slice(0, count));
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });

        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      return { backend: "c64u", frames, ...(await stopOneShotVideoStream()) };
    } catch (error) {
      captureFailed = true;
      throw error;
    } finally {
      if (captureFailed && streamAttempted) {
        // Keep the capture error; the stop failure is only a diagnostic.
        await stopOneShotVideoStream();
      }
      socket.close();
    }
  }

  private async ensureC64uVideoCaptureSession(facade: C64Facade): Promise<C64uVideoCaptureSession> {
    const existing = this.c64uVideoCaptureSession;
    if (existing && !existing.closed && existing.facade === facade) {
      if (existing.stopTimer) {
        clearTimeout(existing.stopTimer);
        existing.stopTimer = null;
      }
      if (existing.error) {
        throw existing.error;
      }
      return existing;
    }

    await this.stopC64uVideoCaptureSession();

    const host = new URL(this.baseUrl).hostname;
    const { bindAddress, acceptsSource } = await this.resolveCaptureEndpoint(host);
    const socket = createSocket("udp4");
    let target: string;
    try {
      await this.bindCaptureSocket(socket, bindAddress);
      target = this.socketEndpoint(socket, bindAddress);
    } catch (error) {
      // A socket whose bind failed still holds a handle under Node; close it so it does not leak.
      closeQuietly(socket);
      throw error;
    }

    const session: C64uVideoCaptureSession = {
      facade,
      socket,
      bindAddress,
      target,
      assembler: new VideoFrameAssembler(VIDEO_SESSION_MAX_PACKETS),
      frames: [],
      waiters: [],
      stopTimer: null,
      closed: false,
      error: null,
    };

    socket.on("message", (msg, rinfo) => {
      if (session.closed || !acceptsSource(rinfo.address)) {
        return;
      }
      const packet = this.parseVideoPacketOrNull(Buffer.from(msg));
      if (!packet) {
        return;
      }
      try {
        const assembled = session.assembler.add(packet);
        if (!assembled) {
          return;
        }
        session.frames.push(assembled);
        if (session.frames.length > VIDEO_SESSION_MAX_FRAMES) {
          session.frames.splice(0, session.frames.length - VIDEO_SESSION_MAX_FRAMES);
        }
        this.flushC64uVideoCaptureWaiters(session);
      } catch (error) {
        this.rejectC64uVideoCaptureWaiters(session, error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      session.error = err;
      this.rejectC64uVideoCaptureWaiters(session, err);
    });

    try {
      await this.ensureStreamSuccess(await this.startStreamResolvingHost(facade, "video", target), "start video stream");
    } catch (error) {
      session.closed = true;
      socket.close();
      throw error;
    }

    this.c64uVideoCaptureSession = session;
    return session;
  }

  private async collectFramesFromC64uVideoCaptureSession(
    session: C64uVideoCaptureSession,
    count: number,
    options: { readonly fresh?: boolean } = {},
  ): Promise<readonly CapturedFrame[]> {
    if (session.error) {
      throw session.error;
    }
    const startIndex = options.fresh ? session.assembler.packetsSeen : 0;
    const existingFrames = this.sessionFramesFrom(session, startIndex, count);
    if (existingFrames.length >= count) {
      return existingFrames;
    }

    return await new Promise<readonly CapturedFrame[]>((resolve, reject) => {
      const timeoutMs = Math.max(1_500, count * 750);
      const timer = setTimeout(() => {
        const waiterIndex = session.waiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          session.waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`Timed out after ${timeoutMs}ms while capturing ${count} video frame(s)`));
      }, timeoutMs);

      const waiter = {
        count,
        startIndex,
        resolve: (frames: readonly CapturedFrame[]) => {
          clearTimeout(timer);
          resolve(frames);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      };

      session.waiters.push(waiter);
      this.flushC64uVideoCaptureWaiters(session);
    });
  }

  private flushC64uVideoCaptureWaiters(session: C64uVideoCaptureSession): void {
    for (let index = session.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = session.waiters[index];
      const frames = this.sessionFramesFrom(session, waiter.startIndex, waiter.count);
      if (frames.length >= waiter.count) {
        session.waiters.splice(index, 1);
        waiter.resolve(frames);
      }
    }
  }

  /** The first `count` complete frames of the session whose packets all arrived at or after `startIndex`. */
  private sessionFramesFrom(session: C64uVideoCaptureSession, startIndex: number, count: number): CapturedFrame[] {
    const frames: CapturedFrame[] = [];
    for (const entry of session.frames) {
      if (entry.firstPacketIndex < startIndex) continue;
      frames.push(entry.frame);
      if (frames.length >= count) break;
    }
    return frames;
  }

  private rejectC64uVideoCaptureWaiters(session: C64uVideoCaptureSession, error: Error): void {
    while (session.waiters.length > 0) {
      const waiter = session.waiters.pop();
      if (waiter) {
        waiter.reject(error);
      }
    }
  }

  private scheduleC64uVideoCaptureStop(keepAliveMs: number): void {
    const session = this.c64uVideoCaptureSession;
    if (!session || session.closed) {
      return;
    }
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    const timer = setTimeout(() => {
      void withStreamLock("video", async () => {
        // The timer may have expired while another capture held the lock and
        // subsequently extended the session. Do not close its renewed stream.
        if (this.c64uVideoCaptureSession === session && session.stopTimer === timer) {
          await this.stopC64uVideoCaptureSession();
        }
      }).catch(() => {});
    }, Math.max(0, keepAliveMs));
    session.stopTimer = timer;
  }

  private async stopC64uVideoCaptureSession(restoreUser = true): Promise<void> {
    const session = this.c64uVideoCaptureSession;
    if (!session) {
      return;
    }
    this.c64uVideoCaptureSession = null;
    session.closed = true;
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }

    let stopError: Error | null = null;
    try {
      await this.ensureStreamSuccess(await session.facade.streamStop("video"), "stop video stream");
    } catch (error) {
      stopError = error instanceof Error ? error : new Error(String(error));
    } finally {
      session.socket.close();
      this.rejectC64uVideoCaptureWaiters(session, stopError ?? new Error("Video capture session closed"));
      if (restoreUser) await this.restoreUserStream(session.facade, "video");
    }

    if (stopError) {
      throw stopError;
    }
  }

  private async captureViceFrames(viceFacade: ViceBackend, count: number, includeBorder: boolean): Promise<FrameCaptureResult> {
    const frames: CapturedFrame[] = [];
    const warnings = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const snapshot = await this.captureViceDisplaySnapshot(viceFacade);
      const { frame, warning } = this.normaliseViceDisplaySnapshot(snapshot, includeBorder);
      frames.push(frame);
      if (warning) warnings.add(warning);
    }

    return { backend: "vice", frames, ...(warnings.size > 0 ? { warnings: [...warnings] } : {}) };
  }

  /**
   * Reads the VICE display. Only an empty frame (VICE has not rendered one yet) is retried; a
   * monitor error, a timeout or a lost session is reported at once.
   */
  private async captureViceDisplaySnapshot(viceFacade: ViceBackend): Promise<{
    readonly debugWidth: number;
    readonly debugHeight: number;
    readonly offsetX?: number;
    readonly offsetY?: number;
    readonly innerWidth?: number;
    readonly innerHeight?: number;
    readonly bitsPerPixel: number;
    readonly pixels: Uint8Array | Buffer;
  }> {
    const attempts = 8;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const snapshot = await viceFacade.withMonitor((client) => client.displayGet({}));
      if (snapshot.pixels.length > 0) {
        return snapshot;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 150 * attempt)));
      }
    }
    throw new Error(`VICE display capture returned an empty frame ${attempts} times`);
  }

  private async captureC64uAudioSamples(
    facade: C64Facade,
    samplePairs: number,
    options?: { readonly timeoutMs?: number; readonly sampleRateHz?: number; readonly acceptPartial?: boolean; readonly signal?: AbortSignal },
  ): Promise<SampleCaptureResult> {
    return withStreamLock("audio", async () => {
      let result: SampleCaptureResult | undefined;
      try {
        result = await this.captureC64uAudioSamplesOnce(facade, samplePairs, options);
      } finally {
        const notes = await this.restoreUserStream(facade, "audio");
        if (result && notes.length > 0) result = { ...result, warnings: notes };
      }
      return result;
    }, options?.signal);
  }

  private async captureC64uAudioSamplesOnce(
    facade: C64Facade,
    samplePairs: number,
    options?: { readonly timeoutMs?: number; readonly sampleRateHz?: number; readonly acceptPartial?: boolean; readonly signal?: AbortSignal },
  ): Promise<SampleCaptureResult> {
    options?.signal?.throwIfAborted();
    const host = new URL(this.baseUrl).hostname;
    const { bindAddress, acceptsSource } = await this.resolveCaptureEndpoint(host);
    const socket = createSocket("udp4");
    const chunks: Int16Array[] = [];
    let collectedValues = 0;
    const neededValues = samplePairs * 2;
    let captureError: Error | null = null;
    let captureSettled = false;
    let notifyCapture: () => void = () => {};
    let streamAttempted = false;
    let failed = false;
    let datagramSeen = false;

    // The firmware can emit UDP before its REST response reaches us. Listen
    // before starting, and cap collection even while start/config/stop requests are pending.
    const onMessage = (msg: Buffer, rinfo: { address: string }) => {
      if (!acceptsSource(rinfo.address)) return;
      datagramSeen = true;
      if (captureSettled || captureError || collectedValues >= neededValues) return;
      try {
        const packet = parseAudioPacket(msg);
        if (packet.samples.length % 2 !== 0) throw new Error("Audio packet contains an incomplete stereo sample pair");
        const samples = packet.samples.subarray(0, neededValues - collectedValues);
        chunks.push(samples);
        collectedValues += samples.length;
      } catch (error) {
        captureError = error instanceof Error ? error : new Error(String(error));
      }
      notifyCapture();
    };
    const onError = (error: Error) => {
      captureError = error;
      notifyCapture();
    };
    const onAbort = () => {
      captureError = new DOMException("Audio capture was cancelled by the client", "AbortError");
      notifyCapture();
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.bindCaptureSocket(socket, bindAddress);
      options?.signal?.throwIfAborted();
      const target = this.socketEndpoint(socket, bindAddress);
      streamAttempted = true;
      await this.ensureStreamSuccess(await this.startStreamResolvingHost(facade, "audio", target), "start audio stream");

      await new Promise<void>((resolve, reject) => {
        const sampleRateHz = options?.sampleRateHz ?? C64U_NTSC_AUDIO_SAMPLE_RATE;
        const timeoutMs = options?.timeoutMs ?? audioCaptureTimeoutMs(samplePairs, sampleRateHz);
        // The stream sends a datagram every few milliseconds; none at all means UDP from the device does not arrive.
        const silenceTimer = setTimeout(() => {
          if (captureSettled || datagramSeen) return;
          captureSettled = true;
          clearTimeout(timer);
          reject(new Error(`No audio datagram arrived within ${AUDIO_FIRST_DATAGRAM_TIMEOUT_MS}ms after the audio stream started. Check that UDP from the device reaches this host (firewall, network route).`));
        }, Math.min(AUDIO_FIRST_DATAGRAM_TIMEOUT_MS, timeoutMs));
        const timer = setTimeout(() => {
          clearTimeout(silenceTimer);
          captureSettled = true;
          // UDP drops packets, so a count-based capture can fall short. Analysis accepts what arrived.
          if (options?.acceptPartial && collectedValues >= MIN_PARTIAL_AUDIO_VALUES) {
            resolve();
            return;
          }
          reject(new Error(`Timed out after ${timeoutMs}ms while capturing ${samplePairs} audio sample pair(s)`));
        }, timeoutMs);

        notifyCapture = () => {
          if (captureSettled) return;
          if (captureError || collectedValues >= neededValues) {
            captureSettled = true;
            clearTimeout(timer);
            clearTimeout(silenceTimer);
            if (captureError) reject(captureError);
            else resolve();
          }
        };
        notifyCapture();
      });

      const capturedPairs = Math.min(samplePairs, Math.floor(collectedValues / 2));
      const samples = new Int16Array(capturedPairs * 2);
      let offset = 0;
      for (const chunk of chunks) {
        const remaining = samples.length - offset;
        if (remaining <= 0) {
          break;
        }
        samples.set(chunk.subarray(0, remaining), offset);
        offset += Math.min(chunk.length, remaining);
      }

      return {
        backend: "c64u",
        channels: 2,
        sampleRateHz: options?.sampleRateHz ?? await this.getC64uAudioSampleRate(facade),
        samplePairs: capturedPairs,
        samples,
      };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      captureSettled = true;
      notifyCapture = () => {};
      options?.signal?.removeEventListener("abort", onAbort);
      socket.off("message", onMessage);
      // Also after a failed bind: the socket still holds a handle under Node.
      closeQuietly(socket);
      try {
        if (streamAttempted) await this.ensureStreamSuccess(await facade.streamStop("audio"), "stop audio stream");
      } catch (error) {
        // Preserve the capture/start error, while still reporting cleanup diagnostics.
        if (!failed) throw error;
        writeDiagnosticEvent("audio_capture_stop_failed", { error: this.normaliseError(error) });
      }
    }
  }

  private async getC64uAudioSampleRate(facade: C64Facade): Promise<number> {
    try {
      const response = await facade.configGet(C64U_SYSTEM_MODE_CATEGORY, C64U_SYSTEM_MODE_ITEM);
      return audioSampleRateForSystemMode(readSystemMode(response));
    } catch {
      // Fall back to PAL below.
    }
    return C64U_PAL_AUDIO_SAMPLE_RATE;
  }

  /**
   * Local address to bind the capture socket to, and a filter that accepts UDP
   * packets only from the device. The device host is resolved once here. A
   * device on loopback (the mock) is reached and heard on loopback.
   */
  private async resolveCaptureEndpoint(remoteHost: string): Promise<{ bindAddress: string; acceptsSource: (address: string) => boolean }> {
    const loopback = isLoopbackHost(remoteHost);
    let deviceAddresses: string[];
    try {
      const resolved = await lookup(remoteHost, { all: true, family: 4 });
      deviceAddresses = resolved.map((entry) => entry.address);
    } catch (error) {
      if (!loopback) {
        throw new Error(`Cannot resolve the device host '${remoteHost}' to an IPv4 address for stream capture: ${error instanceof Error ? error.message : String(error)}`);
      }
      deviceAddresses = ["127.0.0.1"];
    }
    const deviceIsLoopback = loopback || deviceAddresses.every((address) => address.startsWith("127."));
    const acceptsSource = (address: string) => deviceIsLoopback
      ? address.startsWith("127.")
      : deviceAddresses.includes(address.replace(/^::ffff:/i, ""));
    return { bindAddress: await this.resolveLocalCaptureAddress(remoteHost, deviceIsLoopback), acceptsSource };
  }

  private async resolveLocalCaptureAddress(remoteHost: string, deviceIsLoopback = isLoopbackHost(remoteHost)): Promise<string> {
    const socket = createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.connect(64, remoteHost, () => {
          socket.off("error", reject);
          resolve();
        });
      });
      const address = socket.address();
      if (typeof address === "object" && address.address) {
        return address.address;
      }
    } catch {
      // Handled below.
    } finally {
      socket.close();
    }
    // Falling back to loopback would tell the device to stream to itself, and
    // the caller would only see a capture timeout.
    if (deviceIsLoopback) return "127.0.0.1";
    throw new Error(`Cannot find a local network address that reaches the device at ${remoteHost}; the stream target must be an address the device can send to. Check the network route to the device.`);
  }

  private async bindCaptureSocket(socket: Socket, bindAddress: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, bindAddress, () => {
        socket.off("error", reject);
        resolve();
      });
    });
  }

  private socketEndpoint(socket: Socket, bindAddress: string): string {
    const address = socket.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine UDP capture socket endpoint");
    }
    return `${bindAddress}:${address.port}`;
  }

  /**
   * Starts a stream. When the device answers "Network Host Resolve Error", sends
   * one ICMP echo to the device so it has to address a reply to this host, then
   * retries the start once.
   */
  private async startStreamResolvingHost(
    facade: C64Facade,
    stream: "video" | "audio" | "debug",
    target: string,
  ): Promise<RunBasicResult> {
    let firstResult: RunBasicResult | undefined;
    let firstError: unknown;
    try {
      const result = await facade.streamStart(stream, target);
      if (result.success || !isStreamHostResolveFailure(result.details)) {
        return result;
      }
      firstResult = result;
    } catch (error) {
      if (!isStreamHostResolveFailure(error)) {
        throw error;
      }
      firstError = error;
    }

    // A ping from this host only helps when the stream target is this host: the device then has to
    // address the echo reply to it and learns its address. Any other target stays unresolvable.
    const targetHost = streamTargetHost(target);
    if (targetHost === null || !isLocalAddress(targetHost)) {
      if (firstResult) {
        return firstResult;
      }
      throw firstError;
    }

    const host = new URL(this.baseUrl).hostname;
    writeDiagnosticEvent("stream_start_host_resolve_retry", { stream, target, host });
    await this.primeDeviceNeighborCache(host);

    try {
      const retry = await facade.streamStart(stream, target);
      if (retry.success || !isStreamHostResolveFailure(retry.details)) {
        return retry;
      }
    } catch (error) {
      if (!isStreamHostResolveFailure(error)) {
        throw error;
      }
    }
    throw new Error(
      `The Ultimate at ${host} could not resolve stream target ${target} (${STREAM_HOST_RESOLVE_ERROR}) even after pinging it from this host. ` +
        "Check that this host is on the same network as the device, or use a multicast target.",
    );
  }

  /** Best effort: ping failure (missing binary, blocked ICMP) is ignored and the caller retries anyway. */
  private async primeDeviceNeighborCache(host: string): Promise<void> {
    const pingHost = pingableHost(host);
    if (!pingHost) {
      writeDiagnosticEvent("stream_start_ping_failed", { host, message: "host is not a plain hostname or address" });
      return;
    }
    await new Promise<void>((resolve) => {
      execFile("ping", neighborPrimeArgs(pingHost), { timeout: NEIGHBOR_PRIME_TIMEOUT_MS, windowsHide: true }, (error) => {
        if (error) {
          writeDiagnosticEvent("stream_start_ping_failed", { host, message: error.message });
        }
        resolve();
      });
    });
  }

  private async ensureStreamSuccess(result: RunBasicResult, action: string): Promise<void> {
    if (result.success) {
      return;
    }
    throw new Error(`Failed to ${action}: ${JSON.stringify(result.details ?? null)}`);
  }

  /** Ignored video datagrams not yet reported, and when the last report was written. */
  private ignoredVideoPackets = 0;
  private ignoredVideoReportAt = 0;

  private parseVideoPacketOrNull(payload: Buffer): ReturnType<typeof parseVideoPacket> | null {
    try {
      return parseVideoPacket(payload);
    } catch (error) {
      // A hostile stream can send thousands of bad datagrams per second: report at most one record
      // per interval, carrying the number ignored since the previous record and the latest reason.
      this.ignoredVideoPackets += 1;
      const now = Date.now();
      if (now - this.ignoredVideoReportAt >= IGNORED_VIDEO_REPORT_INTERVAL_MS) {
        writeDiagnosticEvent("capture_video_packet_ignored", {
          message: error instanceof Error ? error.message : String(error),
          bytes: payload.length,
          ignoredPackets: this.ignoredVideoPackets,
        });
        this.ignoredVideoPackets = 0;
        this.ignoredVideoReportAt = now;
      }
      return null;
    }
  }

  /**
   * Crops a VICE display snapshot to the inner area VICE reports (XO, YO, IW, IH of Display Get),
   * so the geometry does not depend on what the screen shows. With `includeBorder`, or when the
   * snapshot cannot be cropped, the whole canvas is returned; an unusable inner area is reported.
   */
  private normaliseViceDisplaySnapshot(snapshot: {
    readonly debugWidth: number;
    readonly debugHeight: number;
    readonly offsetX?: number;
    readonly offsetY?: number;
    readonly innerWidth?: number;
    readonly innerHeight?: number;
    readonly bitsPerPixel: number;
    readonly pixels: Uint8Array | Buffer;
  }, includeBorder = false): { frame: CapturedFrame; warning?: string } {
    const bytesPerPixel = snapshot.bitsPerPixel > 0 && snapshot.bitsPerPixel % 8 === 0
      ? snapshot.bitsPerPixel / 8
      : 0;
    const pixels = Uint8Array.from(snapshot.pixels);
    const whole: CapturedFrame = {
      frameNumber: null,
      width: snapshot.debugWidth,
      height: snapshot.debugHeight,
      bitsPerPixel: snapshot.bitsPerPixel,
      pixels,
      complete: true,
    };
    const canCrop = bytesPerPixel > 0
      && snapshot.debugWidth > 0
      && snapshot.debugHeight > 0
      && pixels.length >= snapshot.debugWidth * snapshot.debugHeight * bytesPerPixel;
    if (includeBorder || !canCrop) {
      return { frame: whole };
    }

    const left = snapshot.offsetX ?? 0;
    const top = snapshot.offsetY ?? 0;
    const width = snapshot.innerWidth ?? 0;
    const height = snapshot.innerHeight ?? 0;
    if (width <= 0 || height <= 0 || left + width > snapshot.debugWidth || top + height > snapshot.debugHeight) {
      return {
        frame: whole,
        warning: `VICE reported an inner screen area (${width} x ${height} at ${left},${top}) outside its ${snapshot.debugWidth} x ${snapshot.debugHeight} canvas; the whole canvas was returned.`,
      };
    }

    const rowStride = snapshot.debugWidth * bytesPerPixel;
    const croppedRowStride = width * bytesPerPixel;
    const cropped = new Uint8Array(croppedRowStride * height);
    for (let row = 0; row < height; row += 1) {
      const sourceStart = ((top + row) * rowStride) + (left * bytesPerPixel);
      cropped.set(pixels.subarray(sourceStart, sourceStart + croppedRowStride), row * croppedRowStride);
    }

    return {
      frame: {
        frameNumber: null,
        width,
        height,
        bitsPerPixel: snapshot.bitsPerPixel,
        pixels: cropped,
        complete: true,
      },
    };
  }

  /**
   * Low-level memory read that transparently handles devices returning either
   * raw binary bytes or JSON with a base64 payload.
   * Public to allow advanced polling and monitoring use cases.
   */
  async readMemoryRaw(address: number, length: number, pinnedFacade?: C64Facade): Promise<Uint8Array> {
    validateMemoryRange(address, length);
    try {
      const facade = pinnedFacade ?? await this.facadePromise;
      const bytes = await facade.readMemory(address, length);
      if (bytes.length !== length) {
        throw new Error(`Memory read at ${this.formatAddress(address)} returned ${bytes.length} bytes instead of ${length}`);
      }
      return bytes;
    } catch (facadeError) {
      if (!(facadeError instanceof Error) || (facadeError as any).code !== "UNSUPPORTED") {
        throw facadeError;
      }
    }

    const addrStr = this.formatAddress(address);
    const response = await this.api.v1.machineReadmemList(
      ":readmem",
      { address: addrStr, length },
      { format: "arraybuffer", headers: { Accept: "application/octet-stream, application/json" } as any },
    );
    const contentType = (response.headers?.["content-type"] ?? "").toString().toLowerCase();
    const body = response.data as unknown;
    let bytes: Uint8Array;
    if (contentType.includes("application/json")) {
      const text = Buffer.from(body as ArrayBuffer).toString("utf8");
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      if (parsed !== undefined && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && !("data" in parsed)) {
        const errors = (parsed as { errors?: unknown }).errors;
        throw new Error(`Memory read at ${addrStr} returned a JSON body without data${Array.isArray(errors) && errors.length > 0 ? `: ${errors.map(String).join("; ")}` : ""}`);
      }
      bytes = parsed === undefined ? this.extractBytes(text) : this.extractBytes((parsed as { data?: unknown } | null)?.data ?? parsed);
    } else {
      bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : this.extractBytes(body);
    }
    if (bytes.length !== length) {
      throw new Error(`Memory read at ${addrStr} returned ${bytes.length} bytes instead of ${length}`);
    }
    return bytes;
  }

  /**
   * Low-level memory write that delegates to the active backend's facade.
   * Public so tools that need to drive cross-platform machine state (e.g.
   * keyboard-buffer injection) can avoid backend-specific paths.
   */
  async writeMemoryRaw(address: number, bytes: Uint8Array | Buffer, pinnedFacade?: C64Facade): Promise<void> {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new Error("Address must be within 0x0000 - 0xFFFF");
    }
    const facade = pinnedFacade ?? await this.facadePromise;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    validateMemoryRange(address, buf.length);
    await facade.writeMemory(address, buf);
  }

  /**
   * Inject a sequence of PETSCII byte values into the KERNAL keyboard buffer
   * using shared memory writes. Works on both C64U and VICE because both
   * backends expose `writeMemory`/`readMemory` against the C64 zero-page and
   * the keyboard queue at $0277.
   *
   * The KERNAL buffer ($0277-$0280) holds 10 bytes; $00C6 (NDX) tracks the
   * number of pending characters. We chunk the input, then poll NDX until
   * the kernel has consumed each chunk before queueing the next one.
   *
   * @param bytes      Raw PETSCII bytes (already token-expanded by caller)
   * @param options    Optional knobs for chunk size, drain timing, and total
   *                   timeout. The defaults mirror KERNAL behavior.
   */
  async injectKeyboardQueue(
    bytes: Uint8Array | Buffer | readonly number[],
    options?: {
      readonly chunkSize?: number;
      readonly drainPollMs?: number;
      readonly drainTimeoutMs?: number;
      readonly pinnedFacade?: C64Facade;
      /** Stops waiting for the queue to drain (and aborts the VICE feed) when the request is cancelled. */
      readonly signal?: AbortSignal;
    },
  ): Promise<{ delivered: number; status?: "drained" | "queued" | "stopped"; pending?: number; stoppedAt?: number }> {
    const data = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    if (data.length === 0) {
      return { delivered: 0 };
    }
    const chunkSize = Math.max(1, Math.min(10, options?.chunkSize ?? 10));
    const pollMs = Math.max(1, options?.drainPollMs ?? 8);

    const facade = options?.pinnedFacade ?? await this.facadePromise;
    // One injection per machine at a time: two calls writing the queue in turn would mix or drop each other's bytes.
    return this.withKeyboardLock(facade, async () => {
      if (facade.feedKeyboard) {
        // VICE counts the bytes it queues (a NUL is dropped) and needs about 150 ms per key at least.
        const queuedBytes = data.reduce((count, byte) => count + (byte === 0 ? 0 : 1), 0);
        const timeoutMs = Math.max(50, options?.drainTimeoutMs ?? Math.max(2_000, queuedBytes * 150));
        const fed = await facade.feedKeyboard(data, { drainTimeoutMs: timeoutMs, ...(options?.signal ? { signal: options.signal } : {}) });
        if (fed.status === "timeout") {
          throw new KeyboardQueueDrainTimeoutError(fed.delivered, data.length, timeoutMs, fed.pending);
        }
        return {
          delivered: fed.delivered,
          status: fed.status,
          pending: fed.pending,
          ...(fed.stoppedAt === undefined ? {} : { stoppedAt: fed.stoppedAt }),
        };
      }
      const totalTimeoutMs = Math.max(50, options?.drainTimeoutMs ?? 2000);
      const KEYD = 0x0277; // KERNAL keyboard buffer base
      const NDX = 0x00C6;  // pending byte count

      /** Waits until NDX is 0 and returns 0, or returns the count still pending at the timeout. */
      const waitForEmptyQueue = async (): Promise<number> => {
        const drainStart = Date.now();
        for (;;) {
          options?.signal?.throwIfAborted();
          const ndx = (await facade.readMemory(NDX, 1))[0] ?? 0;
          if (ndx === 0) return 0;
          if (Date.now() - drainStart >= totalTimeoutMs) return ndx;
          await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        }
      };

      // Bytes still queued from earlier input (a keypress, a call that timed out) must not be overwritten.
      let pending = await waitForEmptyQueue();
      if (pending > 0) {
        throw new KeyboardQueueDrainTimeoutError(0, data.length, totalTimeoutMs, pending);
      }
      let delivered = 0;
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const slice = data.subarray(offset, Math.min(data.length, offset + chunkSize));
        // Write the bytes into the queue first so KERNAL never reads a stale
        // length+old-byte combination.
        await facade.writeMemory(KEYD, Buffer.from(slice));
        await facade.writeMemory(NDX, Buffer.from([slice.length]));
        delivered += slice.length;

        // Drain before another write. Overwriting a non-empty KERNAL queue loses
        // user input, so a timeout is an explicit partial-delivery failure.
        pending = await waitForEmptyQueue();
        if (pending > 0) {
          throw new KeyboardQueueDrainTimeoutError(delivered, data.length, totalTimeoutMs, pending);
        }
      }
      return { delivered };
    });
  }

  /** Keyboard injections per facade, chained so each starts after the previous one ended. */
  private readonly keyboardLocks = new WeakMap<C64Facade, Promise<unknown>>();

  private async withKeyboardLock<T>(facade: C64Facade, fn: () => Promise<T>): Promise<T> {
    const previous = this.keyboardLocks.get(facade) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const settled = run.catch(() => undefined);
    this.keyboardLocks.set(facade, settled);
    try {
      return await run;
    } finally {
      if (this.keyboardLocks.get(facade) === settled) this.keyboardLocks.delete(facade);
    }
  }

    /** `continue_execution`: lets the CPU run and ends the explicit pause and any debugger stop. */
    async viceExitMonitor(): Promise<void> {
      const backend = await this.requireViceBackend();
      const result = await backend.continueExecution();
      const warning = (result.details as { warning?: string } | undefined)?.warning;
      if (warning) throw new Error(warning);
    }

    /** Waits until the VICE session tracks the CPU as stopped (a checkpoint hit or step). */
    async viceWaitForStop(timeoutMs: number, signal?: AbortSignal): Promise<{ session: boolean; stopped: boolean }> {
      const backend = await this.requireViceBackend();
      return backend.waitForStop(timeoutMs, signal);
    }

    async viceKeyboardFeed(text: string): Promise<void> {
      await this.withViceMonitor((client) => client.keyboardFeed(text));
    }

    async viceMemSet(address: number, bytes: Uint8Array | Buffer): Promise<void> {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await this.withViceMonitor((client) => client.memSet(address, buf));
    }

    async viceJoyportSet(port: 1 | 2, activeLowMask: number): Promise<void> {
      await this.withViceMonitor((client) => client.joyportSet(port, activeLowMask));
    }

    /**
     * Hold joystick lines on a VICE control port. Binary Monitor command 0xA2
     * only drives VICE's "I/O simulation" joyport device, so that device is
     * attached for the duration of the press and the previous device is
     * restored on release. The device reads bits 5-7 as low, which the
     * keyboard scan sees as extra keys, so it must not stay attached.
     *
     * While a press is held: on port 1 the keyboard scan sees phantom keys
     * (for example SHIFT+C=, which toggles the character set); on port 2,
     * $DC00 reads with bits 5-7 clear (up = $1E where a joystick gives $7E),
     * so programs that compare the whole byte will not see the input.
     */
    async viceJoystickPress(port: 1 | 2, activeLowMask: number): Promise<void> {
      await this.withViceMonitor(async (client) => {
        const resource = `JoyPort${port}Device`;
        // Read the device every time: after a VICE restart the saved state is stale.
        const current = await client.resourceGet(resource);
        const currentId = current.type === "int" ? current.value : Number(current.value);
        if (currentId !== VICE_JOYPORT_IO_SIMULATION) {
          this.viceJoyportSavedDevice.set(port, currentId);
          await client.resourceSet(resource, VICE_JOYPORT_IO_SIMULATION);
        }
        // Attaching the device clears its lines to 0 (everything pressed), so set them in the same monitor session.
        await client.joyportSet(port, activeLowMask);
      });
    }

    /** Release a VICE control port and restore the joyport device it had before the press. */
    async viceJoystickRelease(port: 1 | 2): Promise<void> {
      await this.withViceMonitor(async (client) => {
        await client.joyportSet(port, 0xff);
        const saved = this.viceJoyportSavedDevice.get(port);
        if (saved !== undefined) {
          await client.resourceSet(`JoyPort${port}Device`, saved);
          this.viceJoyportSavedDevice.delete(port);
        }
      });
    }

    async viceMemGet(address: number, length: number): Promise<Buffer> {
      const end = (address + length - 1) & 0xffff;
      return this.withViceMonitor((client) => client.memGet(address, end));
    }

    async viceNuclearReset(): Promise<{ success: boolean; details?: unknown }> {
      const backend = await this.requireViceBackend();
      return await backend.nuclearReset();
    }

    async viceCheckpointList(): Promise<ViceCheckpoint[]> {
      return this.withViceMonitor((client) => client.checkpointList());
    }

    async viceCheckpointGet(id: number): Promise<ViceCheckpoint> {
      return this.withViceMonitor((client) => client.checkpointGet(id));
    }

    async viceCheckpointCreate(options: ViceCheckpointCreateOptions): Promise<ViceCheckpoint> {
      const payload: ViceCheckpointCreateOptions =
        options.memspace === undefined
          ? options
          : { ...options, memspace: this.normaliseMemspace(options.memspace) };
      return (await this.requireViceBackend()).checkpointOperation((client) => client.checkpointCreate(payload));
    }

    async viceCheckpointDelete(id: number): Promise<void> {
      await (await this.requireViceBackend()).checkpointOperation((client) => client.checkpointDelete(id));
    }

    async viceCheckpointToggle(id: number, enabled: boolean): Promise<void> {
      await (await this.requireViceBackend()).checkpointOperation((client) => client.checkpointToggle(id, enabled));
    }

    async viceCheckpointSetCondition(id: number, expression: string): Promise<void> {
      await (await this.requireViceBackend()).checkpointOperation((client) => client.checkpointSetCondition(id, expression));
    }

    async viceRegistersAvailable(memspace: number = 0): Promise<ViceRegisterMetadata[]> {
      const space = this.normaliseMemspace(memspace);
      return this.withViceMonitor((client) => client.registersAvailable(space));
    }

    async viceRegistersGet(memspace: number = 0): Promise<ViceRegisterValue[]> {
      const space = this.normaliseMemspace(memspace);
      return this.withViceMonitor((client) => client.registersGet(space));
    }

    async viceRegistersSet(
      writes: readonly ViceRegisterWrite[],
      options?: { readonly memspace?: number; readonly metadata?: readonly ViceRegisterMetadata[] },
    ): Promise<ViceRegisterValue[]> {
      let payload: { readonly memspace?: ViceMemspace; readonly metadata?: readonly ViceRegisterMetadata[] } | undefined;
      if (options) {
        payload = {
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.memspace !== undefined ? { memspace: this.normaliseMemspace(options.memspace) } : {}),
        };
      }
      return this.withViceMonitor((client) => client.registersSet(writes, payload));
    }

    async viceStepInstructions(count = 1, options?: { readonly stepOver?: boolean }): Promise<{ stopped: boolean; pc?: number }> {
      let stopped = true;
      await (await this.requireViceBackend()).debugStopOperation(async (client) => { stopped = await client.stepInstructions(count, { ...options, waitForStopMs: 2_000 }); });
      return await this.viceStepOutcome(stopped);
    }

    async viceStepReturn(): Promise<{ stopped: boolean; pc?: number }> {
      let stopped = true;
      await (await this.requireViceBackend()).debugStopOperation(async (client) => { stopped = await client.stepReturn({ waitForStopMs: 2_000 }); });
      return await this.viceStepOutcome(stopped);
    }

    /** After a step: when the CPU did not stop in time, the session has stopped it; report the PC it was stopped at. */
    private async viceStepOutcome(stopped: boolean): Promise<{ stopped: boolean; pc?: number }> {
      if (stopped) return { stopped };
      try {
        const [metadata, values] = await Promise.all([this.viceRegistersAvailable(0), this.viceRegistersGet(0)]);
        const pcId = metadata.find((m) => m.name.toUpperCase() === "PC")?.id;
        const pc = pcId === undefined ? undefined : values.find((v) => v.id === pcId)?.value;
        return pc === undefined ? { stopped } : { stopped, pc };
      } catch {
        return { stopped };
      }
    }

    async viceResourceGet(name: string): Promise<ViceResourceValue> {
      return this.withViceMonitor((client) => client.resourceGet(name));
    }

    async viceResourceSet(name: string, value: string | number): Promise<void> {
      await this.withViceMonitor((client) => client.resourceSet(name, value));
    }

    private normaliseMemspace(value: number | undefined): ViceMemspace {
      const allowed: readonly ViceMemspace[] = [0, 1, 2, 3, 4];
      if (value === undefined) {
        return 0;
      }
      const numeric = Number(value);
      if (allowed.includes(numeric as ViceMemspace)) {
        return numeric as ViceMemspace;
      }
      return 0;
    }

  private normaliseError(error: unknown): unknown {
    if (axios.isAxiosError(error)) {
      return {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      };
    }

    if (error instanceof Error) {
      return { message: error.message };
    }

    return error;
  }

  private async readByteOrDefault(facade: C64Facade, address: number, fallback: number): Promise<number> {
    try {
      const bytes = await facade.readMemory(address, 1);
      return bytes[0] ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async getGreetingDd00(type: DeviceType, facade: C64Facade): Promise<number> {
    const cached = this.greetingDd00Cache.get(type);
    if (cached !== undefined) {
      return cached;
    }

    let warmup = this.greetingDd00Warmups.get(type);
    if (!warmup) {
      warmup = this.readByteOrDefault(facade, 0xDD00, 0).then((value) => {
        this.greetingDd00Cache.set(type, value);
        return value;
      }).finally(() => {
        this.greetingDd00Warmups.delete(type);
      });
      this.greetingDd00Warmups.set(type, warmup);
    }

    return warmup;
  }

  private async primeGreetingDd00Cache(types?: readonly DeviceType[]): Promise<void> {
    await this.initPromise;
    const targets = (types && types.length > 0 ? [...types] : this.getAvailableBackends()).filter(
      (type, index, all) => all.indexOf(type) === index,
    );
    await Promise.all(targets.map(async (type) => {
      const facadePromise = this.allFacades.get(type);
      if (!facadePromise) {
        return;
      }
      try {
        const facade = await facadePromise;
        await this.getGreetingDd00(type, facade);
      } catch {
        // Keep greeting prewarm best-effort; renderGreetingScreen still falls back safely.
      }
    }));
  }

  private parseNumeric(value: string): number {
    if (typeof value !== "string") {
      throw new Error("Expected string input");
    }
    if (value.trim().length === 0) {
      throw new Error("Empty numeric value");
    }
    const parsed = parseNumericLiteral(value);
    if (parsed === undefined) {
      assertNotBareHex(value);
      throw new ToolValidationError(`Unable to parse numeric value "${value}"`);
    }
    return parsed;
  }

  private formatAddress(address: number): string {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new Error("Address must be within 0x0000 - 0xFFFF");
    }
    return address.toString(16).toUpperCase().padStart(4, "0");
  }

  private bytesToHex(bytes: Uint8Array | Buffer, withPrefix = true): string {
    const hex = Buffer.from(bytes).toString("hex").toUpperCase();
    return withPrefix ? `$${hex}` : hex;
  }

  private hexStringToBuffer(input: string): Buffer {
    if (typeof input !== "string") {
      throw new Error("Expected byte string");
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new Error("Expected non-empty byte string");
    }

    const cleaned = stripHexByteSeparators(trimmed).toLowerCase();

    if (cleaned.length === 0) {
      throw new Error("No hexadecimal data provided");
    }
    if (cleaned.length % 2 !== 0) {
      throw new Error("Hex string must contain an even number of characters");
    }
    if (!/^[0-9a-f]+$/.test(cleaned)) {
      throw new Error("Hex string contains non-hexadecimal characters");
    }

    return Buffer.from(cleaned, "hex");
  }

  private hzToSidFrequency(hz: number, system: "PAL" | "NTSC" = "PAL"): number {
    const phi2 = system === "PAL" ? 985_248 : 1_022_727;
    const value = Math.round((hz * 16_777_216) / phi2);
    // Clamp to 16-bit
    return Math.max(0, Math.min(0xffff, value));
  }

  private noteNameToHz(note: string): number {
    // Parse note like C#4, Db3, A4
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(note.trim());
    if (!m) return 440; // default A4
    const letter = m[1].toUpperCase();
    const accidental = m[2];
    const octave = Number(m[3]);
    const semitoneMap: Record<string, number> = {
      C: 0,
      D: 2,
      E: 4,
      F: 5,
      G: 7,
      A: 9,
      B: 11,
    };
    let semitone = semitoneMap[letter] ?? 9;
    if (accidental === "#") semitone += 1;
    if (accidental === "b") semitone -= 1;
    const midi = (octave + 1) * 12 + semitone; // MIDI note number (C-1 => 0)
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    return hz;
  }
}

// --- Helpers to synthesize tiny programs for sprites and PETSCII screens ---

function toByte(value: number | undefined, fallback = 0): number {
  const v = value ?? fallback;
  return Math.max(0, Math.min(255, v)) & 0xff;
}

function normaliseColorNibble(value: number): number {
  return Math.max(0, Math.min(0x0F, Math.floor(value))) & 0x0F;
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

/** True when the VIC-II sees the character ROM, not RAM, at this address (offsets $1000-$1FFF of banks 0 and 2). */
function vicSeesCharRom(address: number): boolean {
  const bank = address >> 14;
  const offset = address & 0x3FFF;
  return (bank === 0 || bank === 2) && offset >= 0x1000 && offset < 0x2000;
}

/** Memory the VIC-II reads for the current screen mode: screen RAM and either the bitmap or a RAM character set. */
function vicDisplayRanges(bankBase: number, screenAddress: number, d011: number, d018: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [[screenAddress, screenAddress + 0x0400]];
  if ((d011 & 0x20) !== 0) {
    const bitmap = bankBase + ((d018 & 0x08) !== 0 ? 0x2000 : 0);
    ranges.push([bitmap, bitmap + 0x2000]);
  } else {
    const charset = bankBase + ((d018 >> 1) & 0x07) * 0x0800;
    if (!vicSeesCharRom(charset)) ranges.push([charset, charset + 0x0800]);
  }
  return ranges;
}

function defaultSpriteDataAddress(bankBase: number, index: number, vic: { screenAddress: number; d011: number; d018: number }): number {
  const ranges = vicDisplayRanges(bankBase, vic.screenAddress, vic.d011, vic.d018);
  for (const offset of [0x2000, 0x3000, 0x0800]) {
    const address = bankBase + offset + index * 0x40;
    const clear = ranges.every(([start, end]) => address + 0x40 <= start || address >= end);
    if (clear && !(address >= 0xD000 && address <= 0xDFFF)) return address;
  }
  throw new Error(`No free sprite block was found in VIC bank ${bankBase >> 14} next to the screen and graphics in use; pass dataAddress.`);
}

function checkedSpriteDataAddress(address: number, bankBase: number): number {
  if (!Number.isInteger(address) || address < 0 || address > 0xFFC0 || address % 0x40 !== 0) {
    throw new ToolValidationError("dataAddress must be a multiple of 64 between $0000 and $FFC0");
  }
  if ((address & 0xC000) !== bankBase) {
    throw new ToolValidationError(`dataAddress $${hex4(address)} is outside the VIC bank in use ($${hex4(bankBase)}-$${hex4(bankBase + 0x3FFF)}); the VIC-II can only show sprites from its bank`);
  }
  if (vicSeesCharRom(address)) {
    throw new ToolValidationError(`dataAddress $${hex4(address)} is where the VIC-II sees the character ROM; choose an address outside offsets $1000-$1FFF of the bank`);
  }
  if (address >= 0xD000 && address <= 0xDFFF) {
    throw new ToolValidationError(`dataAddress $${hex4(address)} lies under the I/O area, where writes reach the chip registers`);
  }
  return address;
}

function buildVicTextRegisters(options: {
  readonly currentDd00?: number;
  readonly borderColor?: number;
  readonly backgroundColor?: number;
}): {
  readonly dd00: number;
  readonly d011: number;
  readonly d016: number;
  readonly d018: number;
  readonly d020: number;
  readonly d021: number;
} {
  return {
    dd00: ((options.currentDd00 ?? 0) & 0xFC) | 0x03,
    d011: 0x1B,
    d016: 0x08,
    d018: 0x14,
    d020: normaliseColorNibble(options.borderColor ?? DEFAULT_BORDER_COLOR),
    d021: normaliseColorNibble(options.backgroundColor ?? DEFAULT_BACKGROUND_COLOR),
  };
}

/**
 * Screen code of an ASCII character in the upper-case/graphics set, or undefined when the set has
 * no such glyph. $20-$3F (space, digits, punctuation) are the same codes as ASCII; @ is $00, A-Z
 * are $01-$1A (lower case shown as upper case), [ is $1B and ] is $1D.
 */
function asciiCharToScreenCode(char: string): number | undefined {
  if (char.length !== 1) {
    return undefined;
  }
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 0x20 && code <= 0x3F) return code;
  if (code >= 0x40 && code <= 0x5A) return code - 0x40;
  if (code === 0x5B) return 0x1B;
  if (code === 0x5D) return 0x1D;
  return undefined;
}

/** Message rows of the greeting screen: row 1 up to row 21, so READY. still fits two rows below. */
const GREETING_FIRST_ROW = 1;
const GREETING_MAX_ROWS = 21;

/** Splits text into 40-column rows, breaking at a space where one is near so no word is cut. */
function wrapScreenText(text: string): string[] {
  const rows: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    let rest = line;
    while (rest.length > TEXT_SCREEN_COLUMNS) {
      const cut = rest.lastIndexOf(" ", TEXT_SCREEN_COLUMNS);
      if (cut <= 0) {
        rows.push(rest.slice(0, TEXT_SCREEN_COLUMNS));
        rest = rest.slice(TEXT_SCREEN_COLUMNS);
      } else {
        rows.push(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      }
    }
    rows.push(rest);
  }
  return rows;
}

function buildGreetingScreenRam(message: string): { screenRam: Uint8Array; rows: number; warnings: string[] } {
  const screenRam = new Uint8Array(TEXT_SCREEN_SIZE).fill(SPACE_SCREEN_CODE);
  const warnings: string[] = [];
  const unsupported = new Set<string>();
  let rows = wrapScreenText(message);
  if (rows.length > GREETING_MAX_ROWS) {
    warnings.push(`The message needs ${rows.length} screen rows; only the first ${GREETING_MAX_ROWS} were written.`);
    rows = rows.slice(0, GREETING_MAX_ROWS);
  }
  rows.forEach((text, index) => {
    const offset = (GREETING_FIRST_ROW + index) * TEXT_SCREEN_COLUMNS;
    for (let column = 0; column < text.length; column += 1) {
      const code = asciiCharToScreenCode(text[column]!);
      if (code === undefined) unsupported.add(text[column]!);
      screenRam[offset + column] = code ?? SPACE_SCREEN_CODE;
    }
  });
  if (unsupported.size > 0) {
    warnings.push(`These characters have no glyph in the C64 upper-case set and were written as spaces: ${[...unsupported].map((char) => JSON.stringify(char)).join(", ")}.`);
  }
  const readyRow = GREETING_FIRST_ROW + rows.length + 1;
  const ready = "READY.";
  for (let column = 0; column < ready.length; column += 1) {
    screenRam[readyRow * TEXT_SCREEN_COLUMNS + column] = asciiCharToScreenCode(ready[column]!)!;
  }
  return { screenRam, rows: rows.length, warnings };
}

export function buildPetsciiScreenBasic(opts: { text: string; borderColor?: number; backgroundColor?: number }): string {
  const border = toByte(opts.borderColor ?? 6); // default blue-ish
  const bg = toByte(opts.backgroundColor ?? 0); // default black
  // Clear screen, set colours, print text starting at 1,1
  // Note: CHR$(147) clears the screen.
  // The text is data: quotes and the characters the tokenizer expands become CHR$ pieces, and each
  // line break is a real PRINT line end. Long lines are split so a BASIC line stays short.
  const lines = [`10 POKE 53280,${border}:POKE 53281,${bg}:PRINT CHR$(147)`];
  let ln = 20;
  for (const logical of opts.text.split(/\r\n|\r|\n/)) {
    if (logical.length === 0) {
      lines.push(`${ln} PRINT`);
      ln += 10;
      continue;
    }
    const chunks = chunkByExpressionLength(logical, (text) => printerTextExpression(text, "commodore"), PRINTER_EXPRESSION_MAX);
    chunks.forEach((chunk, index) => {
      lines.push(`${ln} PRINT ${printerTextExpression(chunk, "commodore")}${index < chunks.length - 1 ? ";" : ""}`);
      ln += 10;
    });
  }
  lines.push(`${ln} GETA$:IFA$=""THEN${ln}:END:REM wait for key then end`);
  return lines.join("\n");
}

export function buildPrinterBasicProgram(opts: {
  text: string;
  target?: "commodore" | "epson";
  secondaryAddress?: 0 | 7;
  formFeed?: boolean;
}): string {
  const target = opts.target ?? "commodore";
  const saddr = typeof opts.secondaryAddress === "number" ? opts.secondaryAddress : undefined;
  const lines: string[] = [];

  // OPEN printer device (#1 to device 4 with optional secondary address)
  if (saddr === 0 || saddr === 7) {
    lines.push(`10 OPEN1,4,${saddr}`);
  } else {
    lines.push("10 OPEN1,4");
  }

  // Prepare text: split by CR/LF and emit PRINT# statements.
  // We chunk long logical lines to avoid very long BASIC lines; join chunks with ';' to avoid extra CRs.
  const raw = opts.text ?? "";
  const logicalLines = raw.split(/\r\n|\r|\n/);

  let ln = 20;
  for (const logical of logicalLines) {
    if (logical.length === 0) {
      lines.push(`${ln} PRINT#1`);
      ln += 10;
      continue;
    }
    // Chunk by the length of the expression, not the text: CHR$ splicing can make
    // an expression up to ten times longer, and a BASIC line must stay short
    // (the ROM's LINKPRG scans each line with an 8-bit index).
    const chunks = chunkByExpressionLength(logical, (text) => printerTextExpression(text, target, saddr), PRINTER_EXPRESSION_MAX);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = printerTextExpression(chunks[i], target, saddr);
      const tail = i < chunks.length - 1 ? ";" : ""; // avoid CR between chunks within the same logical line
      lines.push(`${ln} PRINT#1,${chunk}${tail}`);
      ln += 10;
    }
  }

  if (opts.formFeed) {
    lines.push(`${ln} PRINT#1,CHR$(12)`);
    ln += 10;
  }

  // Minimal target-specific toggles could be inserted here in future
  // (e.g., ESC/P mode selections for Epson). Default is raw text output.

  lines.push(`${ln} CLOSE1`);
  return lines.join("\n");
}

/** Longest PRINT#1 expression per BASIC line; keeps each line under the 80-character input limit. */
const PRINTER_EXPRESSION_MAX = 64;

function chunkByExpressionLength(input: string, expression: (text: string) => string, maxLen: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const char of input) {
    if (current && expression(current + char).length > maxLen) {
      parts.push(current);
      current = "";
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * BASIC V2 has no doubled-quote escaping, so quotes are spliced in as CHR$(34).
 * String literals also store a-z as the PETSCII letters $41-$5A, so printer
 * text that needs other codes is spliced in with CHR$: an Epson printer takes
 * ASCII, so lowercase stays $61-$7A; a Commodore printer in lowercase mode
 * (secondary address 7) prints $41-$5A as lowercase and $C1-$DA as capitals.
 */
function printerTextExpression(input: string, target: "commodore" | "epson", secondaryAddress?: number): string {
  const needsChr = (char: string): number | undefined => {
    // Literal < and : and { would be expanded to control codes (<RETURN>, :cr:, {home}) by the tokenizer.
    if (char === "<" || char === ":" || char === "{") return char.charCodeAt(0);
    // The tokeniser accepts only printable ASCII in a string literal: a NUL byte would end the
    // tokenised BASIC line, and other control or Latin-1 characters are errors there, so they are
    // spliced in as CHR$ with the byte they always produced.
    const code = char.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0xff)) return code;
    if (target === "epson" && char >= "a" && char <= "z") return char.charCodeAt(0);
    if (target === "commodore" && secondaryAddress === 7 && char >= "A" && char <= "Z") return char.charCodeAt(0) + 0x80;
    return undefined;
  };
  const pieces: string[] = [];
  let literal = "";
  for (const char of input) {
    const code = char === '"' ? 34 : needsChr(char);
    if (code === undefined) {
      literal += char;
      continue;
    }
    if (literal) pieces.push(`"${literal}"`);
    literal = "";
    pieces.push(`CHR$(${code})`);
  }
  if (literal || pieces.length === 0) pieces.push(`"${literal}"`);
  return pieces.join(";");
}

/** A BASIC V2 string holds at most 255 characters, so bitmap rows are kept in an array of such strings. */
const BASIC_STRING_MAX = 255;

/**
 * BASIC lines that READ `count` DATA bytes into A$(0), A$(1), ... with at most 255 bytes each,
 * and the DATA lines themselves (numbered from `dataLine`).
 */
function bitmapRowLoader(count: number, chunks: number, firstLine: number): string[] {
  return [
    `${firstLine} DIM A$(${chunks - 1})`,
    `${firstLine + 10} FOR I=0 TO ${count - 1}:READ A:K=INT(I/${BASIC_STRING_MAX}):A$(K)=A$(K)+CHR$(A):NEXT I`,
  ];
}

function bitmapDataLines(values: readonly number[], firstLine: number): string[] {
  const lines: string[] = [];
  let ln = firstLine;
  for (let i = 0; i < values.length; i += 8) {
    lines.push(`${ln} DATA ${values.slice(i, i + 8).join(",")}`);
    ln += 10;
  }
  return lines;
}

export function buildCommodoreBitmapBasicProgram(opts: {
  columns: number[];
  repeats?: number;
  useSubRepeat?: number;
  secondaryAddress?: 0 | 7;
  ensureMsb?: boolean;
}): string {
  const repeats = Math.max(1, Math.floor(opts.repeats ?? 1));
  const saddr = typeof opts.secondaryAddress === "number" ? opts.secondaryAddress : 7;
  const ensureMsb = opts.ensureMsb !== false;
  const cols = (opts.columns ?? []).map((v) => {
    const n = Math.max(0, Math.min(255, Math.floor(v)));
    return ensureMsb ? (n | 0x80) : n;
  });
  const chunks = Math.max(1, Math.ceil(cols.length / BASIC_STRING_MAX));
  const lines: string[] = [];
  lines.push(`10 OPEN1,4,${saddr}`);
  lines.push(...bitmapRowLoader(cols.length, chunks, 20));
  lines.push(`40 FOR J=1 TO ${repeats}`);
  // CHR$(8) selects bit image mode; the row ends with the carriage return of the bare PRINT#1.
  if (typeof opts.useSubRepeat === "number") {
    const r = Math.max(0, Math.min(255, Math.floor(opts.useSubRepeat)));
    lines.push(`50 PRINT#1,CHR$(8);CHR$(26);CHR$(${r});`);
  } else {
    lines.push(`50 PRINT#1,CHR$(8);`);
  }
  lines.push(`60 FOR K=0 TO ${chunks - 1}:PRINT#1,A$(K);:NEXT K`);
  lines.push(`70 PRINT#1`);
  lines.push(`80 NEXT J`);
  lines.push(`90 CLOSE1`);
  lines.push(`100 END`);
  lines.push(...bitmapDataLines(cols, 110));
  return lines.join("\n");
}

export function buildEpsonBitmapBasicProgram(opts: {
  columns: number[];
  mode?: "K" | "L" | "Y" | "Z" | "*";
  density?: number;
  repeats?: number;
  timesPerLine?: number;
}): string {
  const cols = (opts.columns ?? []).map((v) => Math.max(0, Math.min(255, Math.floor(v))));
  const mode = (opts.mode ?? "K").toUpperCase() as "K" | "L" | "Y" | "Z" | "*";
  const repeats = Math.max(1, Math.floor(opts.repeats ?? 1));
  const timesPerLine = Math.max(1, Math.floor(opts.timesPerLine ?? 1));
  const chunks = Math.max(1, Math.ceil(cols.length / BASIC_STRING_MAX));

  function modeCode(mo: string): number | null {
    const map: Record<string, number> = { K: 75, L: 76, Y: 89, Z: 90 };
    return map[mo] ?? null;
  }

  // Each string is sent as its own graphics command: ESC K n1 n2 (or ESC * m n1 n2), where
  // n1 + 256 * n2 is the number of column bytes that follow; one string holds at most 255.
  const command = mode === "*"
    ? `CHR$(27);"*";CHR$(${Math.max(0, Math.min(6, Math.floor(opts.density ?? 0)))})`
    : `CHR$(27);CHR$(${modeCode(mode)!})`;

  const lines: string[] = [];
  lines.push(`10 OPEN1,4`);
  lines.push(...bitmapRowLoader(cols.length, chunks, 20));
  lines.push(`40 PRINT#1,CHR$(27);CHR$(65);CHR$(8);CHR$(10);CHR$(13)`);
  lines.push(`50 FOR J=1 TO ${repeats}`);
  lines.push(`60 FOR T=1 TO ${timesPerLine}`);
  lines.push(`70 FOR K=0 TO ${chunks - 1}:PRINT#1,${command};CHR$(LEN(A$(K)));CHR$(0);A$(K);:NEXT K`);
  lines.push(`80 NEXT T`);
  lines.push(`90 PRINT#1,CHR$(10);CHR$(13)`);
  lines.push(`100 NEXT J`);
  lines.push(`110 CLOSE1`);
  lines.push(`120 END`);
  lines.push(...bitmapDataLines(cols, 130));
  return lines.join("\n");
}

export function buildCommodoreDllBasicProgram(opts: {
  firstChar: number;
  chars: Array<{ a?: 0 | 1; columns: number[] }>;
  secondaryAddress?: 0 | 7;
}): string {
  const firstChar = Math.max(33, Math.min(126, Math.floor(opts.firstChar)));
  const numChars = Math.max(1, Math.floor(opts.chars?.length ?? 0));
  const saddr = typeof opts.secondaryAddress === "number" ? opts.secondaryAddress : 0;
  const t = numChars * 13 + 2;
  const n = Math.floor(t / 256);
  const m = t - n * 256;
  const s = 32;
  const a = Math.max(0, Math.min(1, Math.floor(opts.chars?.[0]?.a ?? 0)));
  const lines: string[] = [];
  lines.push(`10 OPEN1,4${saddr === 0 ? "" : "," + saddr}`);
  lines.push(`20 PRINT#1,CHR$(27);"=";CHR$(${m});CHR$(${n});CHR$(${firstChar});CHR$(${s});CHR$(${a})`);
  let ln = 30;
  for (let idx = 0; idx < numChars; idx += 1) {
    const cols = (opts.chars[idx]?.columns ?? []).slice(0, 11).map((v) => Math.max(0, Math.min(255, Math.floor(v))));
    while (cols.length < 11) cols.push(0);
    lines.push(`${ln} PRINT#1${cols.map((v) => `,CHR$(${v})`).join("")}`);
    ln += 10;
  }
  lines.push(`${ln} CLOSE1`);
  return lines.join("\n");
}

/** Close a UDP socket that may already be closed. */
function closeQuietly(socket: Socket): void {
  try { socket.close(); } catch { /* already closed */ }
}

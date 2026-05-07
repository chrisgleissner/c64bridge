/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { createSocket, type Socket } from "node:dgram";
import axios from "axios";
import { basicToPrg } from "./tools/basicTokenizer.js";
import { assemblyToPrg } from "./tools/assember.js";
import { screenCodesToAscii } from "./petscii.js";
import { resolveAddressSymbol } from "./knowledge.js";
import { C64Facade, createAllFacades, createFacade, type DeviceType, ViceBackend } from "./device.js";
import { Api, HttpClient } from "../generated/c64/index.js";
import { createLoggingHttpClient } from "./loggingHttpClient.js";
import { withDiagnosticSpan, writeDiagnosticEvent } from "./diagnostics.js";
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
import {
  C64U_NTSC_AUDIO_SAMPLE_RATE,
  C64U_PAL_AUDIO_SAMPLE_RATE,
  collectCompleteVideoFrames,
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

export interface FrameCaptureResult {
  readonly backend: "c64u" | "vice";
  readonly frames: readonly CapturedFrame[];
}

export interface SampleCaptureResult {
  readonly backend: "c64u";
  readonly channels: 2;
  readonly sampleRateHz: number;
  readonly samplePairs: number;
  readonly samples: Int16Array;
}

interface C64uVideoCaptureSession {
  readonly facade: C64Facade;
  readonly socket: Socket;
  readonly bindAddress: string;
  readonly target: string;
  readonly packets: Array<ReturnType<typeof parseVideoPacket>>;
  readonly waiters: Array<{
    count: number;
    startIndex: number;
    resolve: (frames: readonly CapturedFrame[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  stopTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  error: Error | null;
}

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
  readonly bank: number;
  readonly spriteAddress: string;
  readonly screenAddress: string;
  readonly colorRamAddress: string;
  readonly pointerAddress: string;
  readonly pointerValue: number;
  readonly registers: {
    readonly dd00: number;
    readonly d011: number;
    readonly d016: number;
    readonly d018: number;
    readonly d020: number;
    readonly d021: number;
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

export class C64Client {
  private readonly baseUrl: string;
  private readonly http: HttpClient<unknown>;
  private readonly api: Api<unknown>;
  private readonly allFacades = new Map<DeviceType, Promise<C64Facade>>();
  private readonly warmupPromises = new Map<DeviceType, Promise<boolean>>();
  private readonly greetingDd00Cache = new Map<DeviceType, number>();
  private readonly greetingDd00Warmups = new Map<DeviceType, Promise<number>>();
  private c64uVideoCaptureSession: C64uVideoCaptureSession | null = null;
  private readonly initPromise: Promise<void>;
  private activeType: DeviceType = "c64u";
  private facadePromise: Promise<C64Facade>;

  constructor(baseUrl: string, options: C64ClientOptions = {}) {
    this.baseUrl = baseUrl;
    const headers = options.networkPassword ? { "X-Password": options.networkPassword } : undefined;
    this.http = createLoggingHttpClient({ baseURL: baseUrl, timeout: 10_000, headers });
    this.api = new Api(this.http);
    const forceC64uFacade = options.forceC64uFacade ?? true;
    if (forceC64uFacade) {
      this.facadePromise = createFacade(undefined, {
        preferredC64uBaseUrl: baseUrl,
        preferredC64uNetworkPassword: options.networkPassword,
      }).then((sel) => sel.facade);
      this.allFacades.set("c64u", this.facadePromise);
      this.initPromise = Promise.resolve();
      void this.primeGreetingDd00Cache(["c64u"]);
      return;
    }

    const allFacadesPromise = createAllFacades(undefined, {
      preferredC64uBaseUrl: baseUrl,
      preferredC64uNetworkPassword: options.networkPassword,
    });
    this.facadePromise = allFacadesPromise.then(({ primary }) => primary.facade);
    this.initPromise = allFacadesPromise.then(({ primary, secondary, secondaryType }) => {
      const primaryPromise = Promise.resolve(primary.facade);
      this.activeType = primary.selected;
      this.facadePromise = primaryPromise;
      this.allFacades.set(primary.selected, primaryPromise);
      if (secondary && secondaryType) {
        this.allFacades.set(secondaryType, Promise.resolve(secondary));
      }
    });
    void this.initPromise.then(async () => {
      if (this.allFacades.has("vice")) {
        await this.prewarmBackends(["vice"]);
      }
      void this.primeGreetingDd00Cache();
    }).catch(() => {});
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

  async getActiveBackendType(): Promise<DeviceType> {
    await this.initPromise;
    return this.activeType;
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

  private async shouldUseC64uMockBypass(): Promise<boolean> {
    return process.env.C64_TEST_TARGET === "mock" && (await this.getBackendType()) === "c64u";
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
        const screenRam = buildGreetingScreenRam(options.message);
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

  async displaySprite(options: {
    readonly spriteBytes: Uint8Array | Buffer;
    readonly spriteIndex?: number;
    readonly x?: number;
    readonly y?: number;
    readonly color?: number;
    readonly multicolour?: boolean;
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

      const spriteAddress = SPRITE_DATA_BASE_ADDRESS + index * 0x40;
      const pointerAddress = TEXT_SCREEN_ADDRESS + 0x03F8 + index;
      const pointerValue = (spriteAddress & 0x3FFF) >> 6;
      const bitMask = 1 << index;

      const screenRam = new Uint8Array(TEXT_SCREEN_SIZE).fill(SPACE_SCREEN_CODE);
      screenRam[0x03F8 + index] = pointerValue & 0xFF;
      const colorRam = new Uint8Array(TEXT_SCREEN_SIZE).fill(DEFAULT_TEXT_FOREGROUND);

      const facade = await this.facadePromise;
      const currentDd00 = await this.readByteOrDefault(facade, 0xDD00, 0);
      const currentBorder = await this.readByteOrDefault(facade, 0xD020, DEFAULT_BORDER_COLOR);
      const currentBackground = await this.readByteOrDefault(facade, 0xD021, DEFAULT_BACKGROUND_COLOR);
      const currentD010 = await this.readByteOrDefault(facade, 0xD010, 0);
      const currentD015 = await this.readByteOrDefault(facade, 0xD015, 0);
      const currentD01C = await this.readByteOrDefault(facade, 0xD01C, 0);
      const textRegisters = buildVicTextRegisters({
        currentDd00,
        borderColor: currentBorder,
        backgroundColor: currentBackground,
      });
      const d010 = (currentD010 & ~bitMask) | (x > 0xFF ? bitMask : 0);
      const d015 = currentD015 | bitMask;
      const d01c = (currentD01C & ~bitMask) | (multicolour ? bitMask : 0);

      await facade.writeMemory(spriteAddress, spriteSlot);
      await facade.writeMemory(TEXT_SCREEN_ADDRESS, screenRam);
      await facade.writeMemory(TEXT_COLOR_RAM_ADDRESS, colorRam);
      await facade.writeMemory(0xDD00, Uint8Array.of(textRegisters.dd00));
      await facade.writeMemory(0xD011, Uint8Array.of(textRegisters.d011));
      await facade.writeMemory(0xD016, Uint8Array.of(textRegisters.d016));
      await facade.writeMemory(0xD018, Uint8Array.of(textRegisters.d018));
      await facade.writeMemory(0xD020, Uint8Array.of(textRegisters.d020));
      await facade.writeMemory(0xD021, Uint8Array.of(textRegisters.d021));
      await facade.writeMemory(0xD000 + index * 2, Uint8Array.of(x & 0xFF));
      await facade.writeMemory(0xD001 + index * 2, Uint8Array.of(y & 0xFF));
      await facade.writeMemory(0xD010, Uint8Array.of(d010));
      await facade.writeMemory(0xD015, Uint8Array.of(d015));
      await facade.writeMemory(0xD01C, Uint8Array.of(d01c));
      await facade.writeMemory(0xD027 + index, Uint8Array.of(color));

      return {
        success: true,
        details: {
          bank: 0,
          spriteAddress: this.formatAddress(spriteAddress),
          screenAddress: this.formatAddress(TEXT_SCREEN_ADDRESS),
          colorRamAddress: this.formatAddress(TEXT_COLOR_RAM_ADDRESS),
          pointerAddress: this.formatAddress(pointerAddress),
          pointerValue,
          registers: {
            ...textRegisters,
            d010,
            d015,
            d01c,
          },
          index,
          x,
          y,
          color,
          multicolour,
          spriteByteLength: spriteBytes.length,
        } satisfies SpriteDisplayResult,
      };
    } catch (error) {
      return {
        success: false,
        details: this.normaliseError(error),
      };
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
      await facade.writeMemory(layout.bitmapAddress, bitmap.bitmapData);
      await facade.writeMemory(layout.screenAddress, bitmap.screenRam);
      await facade.writeMemory(layout.colorRamAddress, bitmap.colorRam);

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

      await facade.writeMemory(0xDD00, Uint8Array.of(registers.dd00));
      await facade.writeMemory(0xD011, Uint8Array.of(registers.d011));
      await facade.writeMemory(0xD016, Uint8Array.of(registers.d016));
      await facade.writeMemory(0xD018, Uint8Array.of(registers.d018));
      await facade.writeMemory(0xD020, Uint8Array.of(registers.d020));
      await facade.writeMemory(0xD021, Uint8Array.of(registers.d021));

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

  async uploadAndRunAsm(program: string): Promise<RunBasicResult> {
    const prg = assemblyToPrg(program);
    return this.runPrg(prg);
  }

  async runPrg(prg: Uint8Array | Buffer): Promise<RunBasicResult> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const payload = Buffer.isBuffer(prg) ? prg : Buffer.from(prg);
        const response = await this.api.v1.runnersRunPrgCreate(":run_prg", payload as any, {
          headers: { "Content-Type": "application/octet-stream" },
        });
        return { success: true, details: response.data };
      }
      const facade = await this.facadePromise;
      const res = await facade.runPrg(prg);
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
    return withDiagnosticSpan("client", "read_screen", {}, async () => {
      const bytes = await this.readMemoryRaw(0x0400, 0x03e8);
      return screenCodesToAscii(bytes, { columns: 40, rows: 25 });
    });
  }

  async reset(): Promise<{ success: boolean; details?: unknown }> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const response = await this.api.v1.machineResetUpdate(":reset");
        return { success: true, details: response.data };
      }
      const facade = await this.facadePromise;
      const res = await facade.reset();
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async reboot(): Promise<{ success: boolean; details?: unknown }> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const response = await this.api.v1.machineRebootUpdate(":reboot");
        return { success: true, details: response.data };
      }
      const facade = await this.facadePromise;
      const res = await facade.reboot();
      return { success: res.success, details: res.details };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async readMemory(addressInput: string, lengthInput: string): Promise<MemoryReadResult> {
    try {
      const resolved = resolveAddressSymbol(addressInput);
      const address = resolved ?? this.parseNumeric(addressInput);
      const length = this.parseNumeric(lengthInput);
      if (length <= 0) {
        throw new Error("Length must be greater than zero");
      }

      const rawBytes = await this.readMemoryRaw(address, length);
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

  async writeMemory(addressInput: string, bytesInput: string): Promise<RunBasicResult> {
    try {
      const resolved = resolveAddressSymbol(addressInput);
      const address = resolved ?? this.parseNumeric(addressInput);
      const dataBuffer = this.hexStringToBuffer(bytesInput);
      if (dataBuffer.length === 0) {
        throw new Error("No bytes provided");
      }

      // Prefer PUT with hex data for up to 128 bytes; fall back to POST binary for larger writes
      const addrStr = this.formatAddress(address);
      try {
        const facade = await this.facadePromise;
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

  async sidSetVolume(volume: number): Promise<RunBasicResult> {
    const clamped = Math.max(0, Math.min(15, Math.floor(volume)));
    const byte = Buffer.from([clamped]);
    return this.writeMemory("$D418", this.bytesToHex(byte));
  }

  async sidReset(hard = false): Promise<RunBasicResult> {
    try {
      const facade = await this.facadePromise;
      if (hard) {
        const span = 0x19;
        const ff = Buffer.alloc(span, 0xff);
        const zz = Buffer.alloc(span, 0x00);
        await facade.writeMemory(0xd400, ff);
        await facade.writeMemory(0xd400, zz);
        return { success: true };
      }
      await facade.writeMemory(0xd404, Buffer.from([0x00]));
      await facade.writeMemory(0xd40b, Buffer.from([0x00]));
      await facade.writeMemory(0xd412, Buffer.from([0x00]));
      await facade.writeMemory(0xd418, Buffer.from([0x00]));
      return { success: true };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
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
  }): Promise<RunBasicResult> {
    const voice = options.voice ?? 1;
    if (voice < 1 || voice > 3) {
      return { success: false, details: { message: "Voice must be 1..3" } };
    }
    const system = options.system ?? "PAL";
    const hz = options.frequencyHz ?? (options.note ? this.noteNameToHz(options.note) : 440);
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
      const facade = await this.facadePromise;
      await facade.writeMemory(base, bytes);
      return { success: true };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
  }

  async sidNoteOff(voice: 1 | 2 | 3): Promise<RunBasicResult> {
    if (voice < 1 || voice > 3) {
      return { success: false, details: { message: "Voice must be 1..3" } };
    }
    const ctrlAddr = 0xd400 + (voice - 1) * 7 + 4;
    try {
      const facade = await this.facadePromise;
      await facade.writeMemory(ctrlAddr, Buffer.from([0x00]));
      return { success: true };
    } catch (error) {
      return { success: false, details: this.normaliseError(error) };
    }
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

  async pause(): Promise<RunBasicResult> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const res = await this.api.v1.machinePauseUpdate(":pause");
        return { success: true, details: res.data };
      }
      const facade = await this.facadePromise;
      return await facade.pause();
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async resume(): Promise<RunBasicResult> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const res = await this.api.v1.machineResumeUpdate(":resume");
        return { success: true, details: res.data };
      }
      const facade = await this.facadePromise; return await facade.resume();
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async poweroff(): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.poweroff(); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async menuButton(): Promise<RunBasicResult> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const res = await this.api.v1.machineMenuButtonUpdate(":menu_button");
        return { success: true, details: res.data };
      }
      const facade = await this.facadePromise; return await facade.menuButton();
    } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async debugregRead(): Promise<{ success: boolean; value?: string; details?: unknown }> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const res = await this.api.v1.machineDebugregList(":debugreg");
        return { success: true, value: (res.data as any).value, details: res.data };
      }
      const facade = await this.facadePromise; return await facade.debugregRead();
    } catch (error) { return { success: false, details: this.normaliseError(error) } as any; }
  }

  async debugregWrite(value: string): Promise<{ success: boolean; value?: string; details?: unknown }> {
    try {
      if (await this.shouldUseC64uMockBypass()) {
        const res = await this.api.v1.machineDebugregUpdate(":debugreg", { value });
        return { success: true, value: (res.data as any).value, details: res.data };
      }
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
      if (await this.shouldUseC64uMockBypass()) {
        const res = await this.api.v1.drivesLoadRomUpdate(drive, ":load_rom", { file: path });
        return { success: true, details: res.data };
      }
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
    try { const facade = await this.facadePromise; return await facade.streamStart(stream, ip); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async streamStop(stream: "video" | "audio" | "debug"): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.streamStop(stream); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async prepareVideoCapture(options?: { readonly keepAliveMs?: number }): Promise<void> {
    const keepAliveMs = Math.max(0, Math.trunc(options?.keepAliveMs ?? 1_000));
    const facade = await this.facadePromise;
    if (facade.type !== "c64u") {
      throw new Error("Reusable video capture is only available on C64 Ultimate");
    }
    await this.ensureC64uVideoCaptureSession(facade);
    this.scheduleC64uVideoCaptureStop(keepAliveMs);
  }

  async releaseVideoCapture(): Promise<void> {
    await this.stopC64uVideoCaptureSession();
  }

  async captureFrames(options?: { readonly count?: number; readonly reuseSession?: boolean; readonly keepAliveMs?: number }): Promise<FrameCaptureResult> {
    return withDiagnosticSpan("client", "capture_frames", { count: options?.count ?? 1, reuseSession: options?.reuseSession === true }, async () => {
      const requestedCount = Math.max(1, Math.min(32, Math.trunc(options?.count ?? 1)));
      const facade = await this.facadePromise;
      if (facade.type === "vice") {
        return this.captureViceFrames(requestedCount);
      }

      return this.captureC64uVideoFrames(facade, requestedCount, {
        reuseSession: options?.reuseSession === true,
        keepAliveMs: Math.max(0, Math.trunc(options?.keepAliveMs ?? 0)),
      });
    });
  }

  async captureSamples(options?: { readonly count?: number }): Promise<SampleCaptureResult> {
    const requestedPairs = Math.max(1, Math.min(65_536, Math.trunc(options?.count ?? 256)));
    const facade = await this.facadePromise;
    if (facade.type !== "c64u") {
      throw new Error("Audio sample capture is only available on C64 Ultimate");
    }
    return this.captureC64uAudioSamples(facade, requestedPairs);
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

  async configLoadFromFlash(): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configLoadFromFlash(); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async configSaveToFlash(): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configSaveToFlash(); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async configResetToDefault(): Promise<RunBasicResult> {
    try { const facade = await this.facadePromise; return await facade.configResetToDefault(); } catch (error) { return { success: false, details: this.normaliseError(error) }; }
  }

  async filesInfo(path: string): Promise<unknown> {
    const facade = await this.facadePromise; return facade.filesInfo(path);
  }

  async filesCreateD64(path: string, options?: { tracks?: 35 | 40; diskname?: string }): Promise<RunBasicResult> {
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
    if (options.reuseSession) {
      const session = await this.ensureC64uVideoCaptureSession(facade);
      const frames = await this.collectFramesFromC64uVideoCaptureSession(session, count, { fresh: true });
      this.scheduleC64uVideoCaptureStop(options.keepAliveMs ?? 0);
      return { backend: "c64u", frames };
    }

    const host = new URL(this.baseUrl).hostname;
    const bindAddress = await this.resolveLocalCaptureAddress(host);
    const socket = createSocket("udp4");
    const packets: ReturnType<typeof parseVideoPacket>[] = [];
    let stopError: Error | null = null;

    try {
      await this.bindCaptureSocket(socket, bindAddress);
      const target = this.socketEndpoint(socket, bindAddress);
      await this.ensureStreamSuccess(await facade.streamStart("video", target), "start video stream");

      const frames = await new Promise<readonly CapturedFrame[]>((resolve, reject) => {
        const timeoutMs = Math.max(1_500, count * 750);
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms while capturing ${count} video frame(s)`));
        }, timeoutMs);

        socket.on("message", (msg) => {
          try {
            const packet = this.parseVideoPacketOrNull(Buffer.from(msg));
            if (!packet) {
              return;
            }
            packets.push(packet);
            const frames = collectCompleteVideoFrames(packets, count);
            if (frames.length >= count) {
              clearTimeout(timer);
              resolve(frames);
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

      return { backend: "c64u", frames };
    } finally {
      try {
        await this.ensureStreamSuccess(await facade.streamStop("video"), "stop video stream");
      } catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
      }
      socket.close();
      if (stopError) {
        throw stopError;
      }
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
    const bindAddress = await this.resolveLocalCaptureAddress(host);
    const socket = createSocket("udp4");
    await this.bindCaptureSocket(socket, bindAddress);
    const target = this.socketEndpoint(socket, bindAddress);

    const session: C64uVideoCaptureSession = {
      facade,
      socket,
      bindAddress,
      target,
      packets: [],
      waiters: [],
      stopTimer: null,
      closed: false,
      error: null,
    };

    socket.on("message", (msg) => {
      if (session.closed) {
        return;
      }
      const packet = this.parseVideoPacketOrNull(Buffer.from(msg));
      if (!packet) {
        return;
      }
      session.packets.push(packet);
      this.flushC64uVideoCaptureWaiters(session);
    });

    socket.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      session.error = err;
      this.rejectC64uVideoCaptureWaiters(session, err);
    });

    try {
      await this.ensureStreamSuccess(await facade.streamStart("video", target), "start video stream");
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
    const startIndex = options.fresh ? session.packets.length : 0;
    const existingFrames = collectCompleteVideoFrames(session.packets.slice(startIndex), count);
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
      const frames = collectCompleteVideoFrames(session.packets.slice(waiter.startIndex), waiter.count);
      if (frames.length >= waiter.count) {
        session.waiters.splice(index, 1);
        waiter.resolve(frames);
      }
    }
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
    if (keepAliveMs <= 0) {
      void this.stopC64uVideoCaptureSession().catch(() => {});
      return;
    }
    session.stopTimer = setTimeout(() => {
      void this.stopC64uVideoCaptureSession().catch(() => {});
    }, keepAliveMs);
  }

  private async stopC64uVideoCaptureSession(): Promise<void> {
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
    }

    if (stopError) {
      throw stopError;
    }
  }

  private async captureViceFrames(count: number): Promise<FrameCaptureResult> {
    const viceFacade = await this.requireViceBackend();

    const frames: CapturedFrame[] = [];
    for (let index = 0; index < count; index += 1) {
      const snapshot = await this.captureViceDisplaySnapshot(viceFacade);
      frames.push(this.normaliseViceDisplaySnapshot(snapshot));
    }

    return { backend: "vice", frames };
  }

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
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const snapshot = await viceFacade.withMonitor((client) => client.displayGet({}));
        if (snapshot.pixels.length > 0) {
          return snapshot;
        }
        lastError = new Error("VICE display capture returned an empty frame");
      } catch (error) {
        lastError = error;
      }
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 150 * attempt)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "VICE display capture failed"));
  }

  private async captureC64uAudioSamples(
    facade: C64Facade,
    samplePairs: number,
  ): Promise<SampleCaptureResult> {
    const host = new URL(this.baseUrl).hostname;
    const bindAddress = await this.resolveLocalCaptureAddress(host);
    const socket = createSocket("udp4");
    const chunks: Int16Array[] = [];
    let collectedValues = 0;
    let stopError: Error | null = null;

    try {
      await this.bindCaptureSocket(socket, bindAddress);
      const target = this.socketEndpoint(socket, bindAddress);
      await this.ensureStreamSuccess(await facade.streamStart("audio", target), "start audio stream");

      const neededValues = samplePairs * 2;
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = Math.max(1_000, Math.ceil(samplePairs / 192) * 500);
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms while capturing ${samplePairs} audio sample pair(s)`));
        }, timeoutMs);

        socket.on("message", (msg) => {
          try {
            const packet = parseAudioPacket(Buffer.from(msg));
            chunks.push(packet.samples);
            collectedValues += packet.samples.length;
            if (collectedValues >= neededValues) {
              clearTimeout(timer);
              resolve();
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

      const samples = new Int16Array(samplePairs * 2);
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
        sampleRateHz: await this.getC64uAudioSampleRate(facade),
        samplePairs,
        samples,
      };
    } finally {
      try {
        await this.ensureStreamSuccess(await facade.streamStop("audio"), "stop audio stream");
      } catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
      }
      socket.close();
      if (stopError) {
        throw stopError;
      }
    }
  }

  private async getC64uAudioSampleRate(facade: C64Facade): Promise<number> {
    try {
      const response = await facade.configGet("Video", "Mode");
      const raw = (response as { value?: unknown })?.value ?? response;
      const mode = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      if (mode.includes("NTSC")) {
        return C64U_NTSC_AUDIO_SAMPLE_RATE;
      }
    } catch {
      // Fall back to PAL below.
    }
    return C64U_PAL_AUDIO_SAMPLE_RATE;
  }

  private async resolveLocalCaptureAddress(remoteHost: string): Promise<string> {
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
      // Fall back below.
    } finally {
      socket.close();
    }
    return "127.0.0.1";
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

  private async ensureStreamSuccess(result: RunBasicResult, action: string): Promise<void> {
    if (result.success) {
      return;
    }
    throw new Error(`Failed to ${action}: ${JSON.stringify(result.details ?? null)}`);
  }

  private parseVideoPacketOrNull(payload: Buffer): ReturnType<typeof parseVideoPacket> | null {
    try {
      return parseVideoPacket(payload);
    } catch (error) {
      writeDiagnosticEvent("capture_video_packet_ignored", {
        message: error instanceof Error ? error.message : String(error),
        bytes: payload.length,
      });
      return null;
    }
  }

  private normaliseViceDisplaySnapshot(snapshot: {
    readonly debugWidth: number;
    readonly debugHeight: number;
    readonly offsetX?: number;
    readonly offsetY?: number;
    readonly innerWidth?: number;
    readonly innerHeight?: number;
    readonly bitsPerPixel: number;
    readonly pixels: Uint8Array | Buffer;
  }): CapturedFrame {
    const bytesPerPixel = snapshot.bitsPerPixel > 0 && snapshot.bitsPerPixel % 8 === 0
      ? snapshot.bitsPerPixel / 8
      : 0;
    const pixels = Uint8Array.from(snapshot.pixels);
    const canCrop = bytesPerPixel > 0
      && snapshot.debugWidth > 0
      && snapshot.debugHeight > 0
      && pixels.length >= snapshot.debugWidth * snapshot.debugHeight * bytesPerPixel;

    if (!canCrop) {
      return {
        frameNumber: null,
        width: snapshot.debugWidth,
        height: snapshot.debugHeight,
        bitsPerPixel: snapshot.bitsPerPixel,
        pixels,
        complete: true,
      };
    }

    const innerWidth = typeof snapshot.innerWidth === "number" && snapshot.innerWidth > 0
      ? snapshot.innerWidth
      : snapshot.debugWidth;
    const innerHeight = typeof snapshot.innerHeight === "number" && snapshot.innerHeight > 0
      ? snapshot.innerHeight
      : snapshot.debugHeight;
    const rowThreshold = Math.max(1, Math.min(innerWidth, snapshot.debugWidth, 32));
    const columnThreshold = Math.max(1, Math.min(innerHeight, snapshot.debugHeight, 32));

    const isPixelVisible = (pixelIndex: number): boolean => {
      const offset = pixelIndex * bytesPerPixel;
      for (let byteIndex = 0; byteIndex < bytesPerPixel; byteIndex += 1) {
        if ((pixels[offset + byteIndex] ?? 0) !== 0) {
          return true;
        }
      }
      return false;
    };

    const rowVisibleCounts = new Array<number>(snapshot.debugHeight).fill(0);
    for (let row = 0; row < snapshot.debugHeight; row += 1) {
      let visiblePixels = 0;
      const rowStart = row * snapshot.debugWidth;
      for (let column = 0; column < snapshot.debugWidth; column += 1) {
        if (isPixelVisible(rowStart + column)) {
          visiblePixels += 1;
        }
      }
      rowVisibleCounts[row] = visiblePixels;
    }

    const top = rowVisibleCounts.findIndex((count) => count >= rowThreshold);
    const bottom = rowVisibleCounts.length - 1 - [...rowVisibleCounts].reverse().findIndex((count) => count >= rowThreshold);

    if (top < 0 || bottom < top) {
      return {
        frameNumber: null,
        width: snapshot.debugWidth,
        height: snapshot.debugHeight,
        bitsPerPixel: snapshot.bitsPerPixel,
        pixels,
        complete: true,
      };
    }

    const columnVisibleCounts = new Array<number>(snapshot.debugWidth).fill(0);
    for (let column = 0; column < snapshot.debugWidth; column += 1) {
      let visiblePixels = 0;
      for (let row = top; row <= bottom; row += 1) {
        if (isPixelVisible((row * snapshot.debugWidth) + column)) {
          visiblePixels += 1;
        }
      }
      columnVisibleCounts[column] = visiblePixels;
    }

    const left = columnVisibleCounts.findIndex((count) => count >= columnThreshold);
    const right = columnVisibleCounts.length - 1 - [...columnVisibleCounts].reverse().findIndex((count) => count >= columnThreshold);

    if (left < 0 || right < left) {
      return {
        frameNumber: null,
        width: snapshot.debugWidth,
        height: snapshot.debugHeight,
        bitsPerPixel: snapshot.bitsPerPixel,
        pixels,
        complete: true,
      };
    }

    const croppedWidth = right - left + 1;
    const croppedHeight = bottom - top + 1;

    const rowStride = snapshot.debugWidth * bytesPerPixel;
    const croppedRowStride = croppedWidth * bytesPerPixel;
    const cropped = new Uint8Array(croppedRowStride * croppedHeight);
    for (let row = 0; row < croppedHeight; row += 1) {
      const sourceStart = ((top + row) * rowStride) + (left * bytesPerPixel);
      const sourceEnd = sourceStart + croppedRowStride;
      cropped.set(pixels.subarray(sourceStart, sourceEnd), row * croppedRowStride);
    }

    return {
      frameNumber: null,
      width: croppedWidth,
      height: croppedHeight,
      bitsPerPixel: snapshot.bitsPerPixel,
      pixels: cropped,
      complete: true,
    };
  }

  /**
   * Low-level memory read that transparently handles devices returning either
   * raw binary bytes or JSON with a base64 payload.
   * Public to allow advanced polling and monitoring use cases.
   */
  async readMemoryRaw(address: number, length: number): Promise<Uint8Array> {
    try {
      const facade = await this.facadePromise;
      return await facade.readMemory(address, length);
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
    if (contentType.includes("application/json")) {
      const text = Buffer.from(body as ArrayBuffer).toString("utf8");
      try {
        const parsed = JSON.parse(text);
        return this.extractBytes(parsed?.data ?? parsed);
      } catch {
        return this.extractBytes(text);
      }
    }
    return body instanceof ArrayBuffer ? new Uint8Array(body) : this.extractBytes(body);
  }

  /**
   * Low-level memory write that delegates to the active backend's facade.
   * Public so tools that need to drive cross-platform machine state (e.g.
   * keyboard-buffer injection) can avoid backend-specific paths.
   */
  async writeMemoryRaw(address: number, bytes: Uint8Array | Buffer): Promise<void> {
    const facade = await this.facadePromise;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
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
    },
  ): Promise<void> {
    const data = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    if (data.length === 0) {
      return;
    }
    const chunkSize = Math.max(1, Math.min(10, options?.chunkSize ?? 10));
    const pollMs = Math.max(1, options?.drainPollMs ?? 8);
    const totalTimeoutMs = Math.max(50, options?.drainTimeoutMs ?? 2000);

    const facade = await this.facadePromise;
    const KEYD = 0x0277; // KERNAL keyboard buffer base
    const NDX = 0x00C6;  // pending byte count

    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const slice = data.subarray(offset, Math.min(data.length, offset + chunkSize));
      // Write the bytes into the queue first so KERNAL never reads a stale
      // length+old-byte combination.
      await facade.writeMemory(KEYD, Buffer.from(slice));
      await facade.writeMemory(NDX, Buffer.from([slice.length]));

      // Drain: wait for KERNAL to consume the queue. If the machine is paused
      // or otherwise not running, give up after the timeout and continue —
      // higher layers can decide whether that is a failure for their context.
      const drainStart = Date.now();
      while (Date.now() - drainStart < totalTimeoutMs) {
        const ndx = await facade.readMemory(NDX, 1);
        if ((ndx[0] ?? 0) === 0) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      }
    }
  }

    async viceExitMonitor(): Promise<void> {
      await this.withViceMonitor((client) => client.exitMonitor());
    }

    async viceKeyboardFeed(text: string): Promise<void> {
      await this.withViceMonitor((client) => client.keyboardFeed(text));
    }

    async viceMemSet(address: number, bytes: Uint8Array | Buffer): Promise<void> {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await this.withViceMonitor((client) => client.memSet(address, buf));
    }

    async viceMemGet(address: number, length: number): Promise<Buffer> {
      const end = (address + length - 1) & 0xffff;
      return this.withViceMonitor((client) => client.memGet(address, end));
    }

    async viceNuclearReset(): Promise<void> {
      const backend = await this.requireViceBackend();
      await backend.nuclearReset();
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
      return this.withViceMonitor((client) => client.checkpointCreate(payload));
    }

    async viceCheckpointDelete(id: number): Promise<void> {
      await this.withViceMonitor((client) => client.checkpointDelete(id));
    }

    async viceCheckpointToggle(id: number, enabled: boolean): Promise<void> {
      await this.withViceMonitor((client) => client.checkpointToggle(id, enabled));
    }

    async viceCheckpointSetCondition(id: number, expression: string): Promise<void> {
      await this.withViceMonitor((client) => client.checkpointSetCondition(id, expression));
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

    async viceStepInstructions(count = 1, options?: { readonly stepOver?: boolean }): Promise<void> {
      await this.withViceMonitor((client) => client.stepInstructions(count, options));
    }

    async viceStepReturn(): Promise<void> {
      await this.withViceMonitor((client) => client.stepReturn());
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

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error("Empty numeric value");
    }

    const lower = trimmed.toLowerCase();
    let radix = 10;
    let literal = lower;

    if (lower.startsWith("$")) {
      radix = 16;
      literal = lower.slice(1);
    } else if (lower.startsWith("0x")) {
      radix = 16;
      literal = lower.slice(2);
    } else if (lower.startsWith("%")) {
      radix = 2;
      literal = lower.slice(1);
    }

    const parsed = Number.parseInt(literal, radix);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
      throw new Error(`Unable to parse numeric value "${value}"`);
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

    const withoutPrefix = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
    const cleaned = withoutPrefix.replace(/[\s_]/g, "").toLowerCase();

    if (cleaned.length === 0) {
      throw new Error("No hexadecimal data provided");
    }
    if (cleaned.length % 2 !== 0) {
      throw new Error("Hex string must contain an even number of characters");
    }

    return Buffer.from(cleaned, "hex");
  }

  private hzToSidFrequency(hz: number, system: "PAL" | "NTSC" = "PAL"): number {
    const phi2 = system === "PAL" ? 985_248 : 1_022_727;
    const value = Math.round((hz * 65536) / phi2);
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

function asciiCharToScreenCode(char: string): number {
  if (char.length !== 1) {
    return SPACE_SCREEN_CODE;
  }

  const upper = char.toUpperCase();
  if (upper >= "A" && upper <= "Z") {
    return upper.charCodeAt(0) - 64;
  }

  if (upper >= "0" && upper <= "9") {
    return upper.charCodeAt(0);
  }

  switch (upper) {
    case " ":
      return SPACE_SCREEN_CODE;
    case ".":
      return 0x2E;
    case ",":
      return 0x2C;
    case "!":
      return 0x21;
    case ":":
      return 0x3A;
    case ";":
      return 0x3B;
    case "-":
      return 0x2D;
    case "'":
      return 0x27;
    case "/":
      return 0x2F;
    case "?":
      return 0x3F;
    default:
      return SPACE_SCREEN_CODE;
  }
}

function writeScreenLine(screenRam: Uint8Array, row: number, text: string): void {
  if (row < 0 || row >= TEXT_SCREEN_ROWS) {
    return;
  }

  const offset = row * TEXT_SCREEN_COLUMNS;
  const clipped = text.slice(0, TEXT_SCREEN_COLUMNS);
  for (let index = 0; index < clipped.length; index += 1) {
    screenRam[offset + index] = asciiCharToScreenCode(clipped[index] ?? " ");
  }
}

function buildGreetingScreenRam(message: string): Uint8Array {
  const screenRam = new Uint8Array(TEXT_SCREEN_SIZE).fill(SPACE_SCREEN_CODE);
  writeScreenLine(screenRam, 1, message);
  writeScreenLine(screenRam, 3, "READY.");
  return screenRam;
}

function buildSingleSpriteProgram(opts: {
  spriteBytes: Uint8Array | Buffer;
  spriteIndex?: number;
  x?: number;
  y?: number;
  color?: number;
  multicolour?: boolean;
}): Buffer {
  const index = Math.max(0, Math.min(7, opts.spriteIndex ?? 0));
  const mx = Math.max(0, Math.min(511, opts.x ?? 100));
  const xLo = mx & 0xff;
  const xMsbBit = (mx & 0x100) ? (1 << index) : 0;
  const y = toByte(opts.y, 100);
  const color = toByte(opts.color, 1);
  const multicolour = !!opts.multicolour;

  const spriteData = Buffer.from(opts.spriteBytes);
  if (spriteData.length !== 63) {
    throw new Error("spriteBytes must be exactly 63 bytes");
  }

  // We'll assemble a tiny machine-code program that:
  // - Copies 63 bytes to a safe sprite data page ($2000 by default)
  // - Sets screen memory base to $0400, sprite pointer to point into $2000
  // - Positions and enables the sprite
  // - Loops forever
  // This avoids relying on KERNAL calls and works from a cold start.

  const SPRITE_BASE = 0x2000; // must be 64-byte aligned
  const POINTER_PAGE = 0x07f8 + index; // sprite pointer table location
  const pointerValue = (SPRITE_BASE >> 6) & 0xff;

  // Place code starting at $0801 so it runs as a program via SYS.
  // We'll create an assembler source and reuse assemblyToPrg.
  const lines: string[] = [];
  lines.push("* = $0801");
  // Tiny BASIC loader header not needed; we will use pure ML and jump via RESET runner which executes by SYS 2061
  // Build code at $0810 to avoid conflicting with potential KERNAL vectors
  lines.push("* = $0810");
  lines.push("\nstart:");
  // Copy 63 bytes from inlined table to SPRITE_BASE
  lines.push("  LDY #$00");
  lines.push("copy_loop:");
  lines.push("  LDA sprite_data,Y");
  lines.push(`  STA $${hex16(SPRITE_BASE)},Y`);
  lines.push("  INY");
  lines.push("  CPY #$3F");
  lines.push("  BNE copy_loop");
  // Set sprite pointer, color, coordinates, enable
  lines.push(`  LDA #$${pointerValue.toString(16).toUpperCase().padStart(2, "0")}`);
  lines.push(`  STA $${(POINTER_PAGE).toString(16).toUpperCase()}`);
  lines.push(`  LDA #$${color.toString(16).toUpperCase().padStart(2, "0")}`);
  lines.push(`  STA $${hex16(0xD027 + index)}`);
  lines.push(`  LDA #$${xLo.toString(16).toUpperCase().padStart(2, "0")}`);
  lines.push(`  STA $${(0xD000 + index * 2).toString(16).toUpperCase()}`);
  lines.push(`  LDA #$${y.toString(16).toUpperCase().padStart(2, "0")}`);
  lines.push(`  STA $${(0xD001 + index * 2).toString(16).toUpperCase()}`);
  // MSB X if needed
  if (xMsbBit) {
    const bit = xMsbBit;
    lines.push(`  LDA $D010`);
    lines.push(`  ORA #$${bit.toString(16).toUpperCase().padStart(2, "0")}`);
    lines.push(`  STA $D010`);
  }
  // Multicolour toggle per-sprite
  if (multicolour) {
    const bit = 1 << index;
    lines.push(`  LDA $D01C`);
    lines.push(`  ORA #$${bit.toString(16).toUpperCase().padStart(2, "0")}`);
    lines.push(`  STA $D01C`);
  }
  // Enable sprite
  {
    const bit = 1 << index;
    lines.push(`  LDA $D015`);
    lines.push(`  ORA #$${bit.toString(16).toUpperCase().padStart(2, "0")}`);
    lines.push(`  STA $D015`);
  }
  // Idle loop
  lines.push("forever: JMP forever");
  // Sprite data table
  lines.push("\nsprite_data:");
  for (let i = 0; i < 63; i += 3) {
    const a = spriteData[i] ?? 0;
    const b = spriteData[i + 1] ?? 0;
    const c = spriteData[i + 2] ?? 0;
    lines.push(`  .byte $${hex2(a)},$${hex2(b)},$${hex2(c)}`);
  }

  const source = lines.join("\n");
  return assemblyToPrg(source, { fileName: "sprite_gen.asm", loadAddress: 0x0801 });
}

function buildPetsciiScreenBasic(opts: { text: string; borderColor?: number; backgroundColor?: number }): string {
  const border = toByte(opts.borderColor ?? 6); // default blue-ish
  const bg = toByte(opts.backgroundColor ?? 0); // default black
  // Clear screen, set colours, print text starting at 1,1
  // Note: CHR$(147) clears the screen.
  const sanitized = opts.text.replace(/\r\n?|\n/g, "\\n");
  const program = [
    `10 POKE 53280,${border}:POKE 53281,${bg}:PRINT CHR$(147)`,
    `20 PRINT "${sanitized}"`,
    `30 GETA$:IFA$<>""THENEND:REM wait for key then end`,
  ].join("\n");
  return program;
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
    const chunks = chunkString(logical, 60);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = escapeBasicQuotes(chunks[i]);
      const tail = i < chunks.length - 1 ? ";" : ""; // avoid CR between chunks within the same logical line
      lines.push(`${ln} PRINT#1,"${chunk}"${tail}`);
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

function chunkString(input: string, maxLen: number): string[] {
  if (input.length <= maxLen) return [input];
  const parts: string[] = [];
  let i = 0;
  while (i < input.length) {
    parts.push(input.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}

function escapeBasicQuotes(input: string): string {
  // In Commodore BASIC, embed a double quote by doubling it
  return input.replace(/"/g, '""');
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
  const lines: string[] = [];
  lines.push(`10 OPEN1,4,${saddr}`);
  lines.push(`20 A$=""`);
  lines.push(`30 FOR I=1 TO ${cols.length}`);
  lines.push(`40 READ A:A$=A$+CHR$(A)`);
  lines.push(`50 NEXT I`);
  lines.push(`60 FOR J=1 TO ${repeats}`);
  if (typeof opts.useSubRepeat === "number") {
    const r = Math.max(0, Math.min(255, Math.floor(opts.useSubRepeat)));
    lines.push(`70 PRINT#1,CHR$(8);CHR$(26);CHR$(${r});A$`);
  } else {
    lines.push(`70 PRINT#1,CHR$(8);A$`);
  }
  lines.push(`80 NEXT J`);
  lines.push(`90 CLOSE1`);
  lines.push(`100 END`);
  let ln = 110;
  for (let i = 0; i < cols.length; i += 8) {
    const group = cols.slice(i, i + 8);
    lines.push(`${ln} DATA ${group.join(",")}`);
    ln += 10;
  }
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
  const len = cols.length;
  const n = len & 0xff;
  const m = (len >> 8) & 0xff;
  const mode = (opts.mode ?? "K").toUpperCase() as "K" | "L" | "Y" | "Z" | "*";
  const repeats = Math.max(1, Math.floor(opts.repeats ?? 1));
  const timesPerLine = Math.max(1, Math.floor(opts.timesPerLine ?? 4));

  function modeCode(mo: string): number | null {
    const map: Record<string, number> = { K: 75, L: 76, Y: 89, Z: 90 };
    return map[mo] ?? null;
  }

  const lines: string[] = [];
  lines.push(`10 OPEN1,4`);
  if (mode === "*") {
    const density = Math.max(0, Math.min(6, Math.floor(opts.density ?? 0)));
    lines.push(`20 A$=CHR$(27)+"*"+CHR$(${density})+CHR$(${n})+CHR$(${m})`);
  } else {
    const mc = modeCode(mode)!;
    lines.push(`20 A$=CHR$(27)+CHR$(${mc})+CHR$(${n})+CHR$(${m})`);
  }
  lines.push(`30 FOR I=1 TO ${cols.length}`);
  lines.push(`40 READ A:A$=A$+CHR$(A)`);
  lines.push(`50 NEXT I`);
  lines.push(`60 PRINT#1,CHR$(27);CHR$(65);CHR$(8);CHR$(10);CHR$(13)`);
  lines.push(`70 FOR J=1 TO ${repeats}`);
  const seg = Array.from({ length: timesPerLine }).map(() => "A$").join(";");
  lines.push(`80 PRINT#1,${seg};CHR$(10);CHR$(13)`);
  lines.push(`90 NEXT J`);
  lines.push(`100 CLOSE1`);
  lines.push(`110 END`);
  let ln = 120;
  for (let i = 0; i < cols.length; i += 8) {
    const group = cols.slice(i, i + 8);
    lines.push(`${ln} DATA ${group.join(",")}`);
    ln += 10;
  }
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

function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function hex16(n: number): string {
  return (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

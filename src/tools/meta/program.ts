// Program testing and orchestration meta tools
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import { objectSchema, stringSchema, arraySchema, numberSchema, optionalSchema, booleanSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolUnsupportedPlatformError, ToolExecutionError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { getPlatformStatus } from "../../platform.js";
import { promises as fs } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { sleep, formatTimestampSpec } from "./util.js";
import { getTasksHomeDir } from "./background.js";
import { Jimp } from "jimp";
import type { CapturedFrame } from "../../streamCapture.js";
import { withDiagnosticSpan } from "../../diagnostics.js";

const C64_SCREENSHOT_PALETTE = [
  0x000000ff,
  0xffffffff,
  0x813338ff,
  0x75cec8ff,
  0x8e3c97ff,
  0x56ac4dff,
  0x2e2c9bff,
  0xedf171ff,
  0x8e5029ff,
  0x553800ff,
  0xc46c71ff,
  0x4a4a4aff,
  0x7b7b7bff,
  0xa9ff9fff,
  0x706debff,
  0xb2b2b2ff,
] as const;

type GreetingBackend = "vice" | "c64u" | "u2";

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isVisibleViceSessionPreferred(): boolean {
  const visible = String(process.env.VICE_VISIBLE ?? "true").trim().toLowerCase();
  const forceXvfb = String(process.env.FORCE_XVFB ?? "0").trim().toLowerCase();
  const disableXvfb = String(process.env.DISABLE_XVFB ?? "0").trim().toLowerCase();

  if (forceXvfb === "1" || forceXvfb === "true" || forceXvfb === "yes") {
    return false;
  }

  if (disableXvfb === "1" || disableXvfb === "true" || disableXvfb === "yes") {
    return visible !== "0" && visible !== "false" && visible !== "no";
  }

  return visible !== "0" && visible !== "false" && visible !== "no";
}

function shouldUseVisibleViceGreetingFastPath(rawArgs: unknown, requestedBackends: readonly GreetingBackend[]): boolean {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return false;
  }

  if (requestedBackends.length !== 1 || requestedBackends[0] !== "vice") {
    return false;
  }

  if (!isVisibleViceSessionPreferred()) {
    return false;
  }

  const args = rawArgs as Record<string, unknown>;
  return !hasOwnProperty(args, "verify")
    && !hasOwnProperty(args, "captureScreenshot")
    && !hasOwnProperty(args, "outputPath");
}

function canonicalGreetingBackends(): readonly GreetingBackend[] {
  return ["vice", "c64u", "u2"];
}

function uniqueGreetingBackends(backends: readonly GreetingBackend[]): GreetingBackend[] {
  return backends.filter((backend, index) => backends.indexOf(backend) === index);
}

function normaliseScreenText(screen: string): string {
  return screen.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().toUpperCase();
}

function screenContainsExpectedText(screen: string, expectedText: string): boolean {
  return normaliseScreenText(screen).includes(normaliseScreenText(expectedText));
}

function applyGreetingTemplate(template: string, backend: GreetingBackend): string {
  const upper = backend.toUpperCase();
  const lower = backend.toLowerCase();
  return template
    .replace(/\{PLATFORM\}/g, upper)
    .replace(/\{BACKEND\}/g, upper)
    .replace(/\{platform\}/g, lower)
    .replace(/\{backend\}/g, lower);
}

function escapeBasicString(value: string): string {
  return value.replace(/"/g, '""');
}

function buildGreetingProgram(message: string): string {
  return [
    "10 PRINT CHR$(147)",
    `20 PRINT \"${escapeBasicString(message)}\"`,
    "30 END",
  ].join("\n");
}

function analyseCapturedFrame(frame: CapturedFrame) {
  const totalPixels = Math.max(1, frame.width * frame.height);
  let nonBackgroundPixels = 0;
  const uniqueColors = new Set<number>();

  if (frame.bitsPerPixel === 4 || frame.bitsPerPixel === 8) {
    for (let index = 0; index < totalPixels; index += 1) {
      const value = frame.pixels[index] ?? 0;
      uniqueColors.add(value);
      if (value !== 0) {
        nonBackgroundPixels += 1;
      }
    }
  } else {
    const bytesPerPixel = frame.bitsPerPixel >= 24 && frame.bitsPerPixel % 8 === 0
      ? frame.bitsPerPixel / 8
      : 0;
    if (bytesPerPixel > 0) {
      for (let index = 0; index < totalPixels; index += 1) {
        const offset = index * bytesPerPixel;
        const red = frame.pixels[offset] ?? 0;
        const green = frame.pixels[offset + 1] ?? 0;
        const blue = frame.pixels[offset + 2] ?? 0;
        const alpha = bytesPerPixel >= 4 ? (frame.pixels[offset + 3] ?? 255) : 255;
        uniqueColors.add(((red & 0xff) << 24) | ((green & 0xff) << 16) | ((blue & 0xff) << 8) | (alpha & 0xff));
        if (red !== 0 || green !== 0 || blue !== 0) {
          nonBackgroundPixels += 1;
        }
      }
    }
  }

  const nonBackgroundRatio = Number((nonBackgroundPixels / totalPixels).toFixed(4));

  return {
    width: frame.width,
    height: frame.height,
    bitsPerPixel: frame.bitsPerPixel,
    complete: frame.complete,
    totalPixels,
    nonBackgroundPixels,
    nonBackgroundRatio,
    uniqueColorCount: uniqueColors.size,
    looksNonBlank: nonBackgroundPixels >= Math.max(1, Math.floor(totalPixels * 0.005)),
  };
}

function indexedFrameColour(value: number): number {
  return C64_SCREENSHOT_PALETTE[value & 0x0f] ?? C64_SCREENSHOT_PALETTE[0];
}

function rgbaToJimpColour(red: number, green: number, blue: number, alpha = 255): number {
  return (((red & 0xff) << 24) | ((green & 0xff) << 16) | ((blue & 0xff) << 8) | (alpha & 0xff)) >>> 0;
}

async function writeCapturedFramePng(frame: CapturedFrame, filePath: string): Promise<void> {
  const image = new Jimp({ width: frame.width, height: frame.height, color: C64_SCREENSHOT_PALETTE[0] });
  const totalPixels = frame.width * frame.height;

  if (frame.bitsPerPixel === 4 || frame.bitsPerPixel === 8) {
    for (let index = 0; index < totalPixels; index += 1) {
      image.setPixelColor(
        indexedFrameColour(frame.pixels[index] ?? 0),
        index % frame.width,
        Math.floor(index / frame.width),
      );
    }
    await image.write(filePath as `${string}.${string}`);
    return;
  }

  const bytesPerPixel = frame.bitsPerPixel >= 24 && frame.bitsPerPixel % 8 === 0
    ? frame.bitsPerPixel / 8
    : 0;

  for (let index = 0; index < totalPixels; index += 1) {
    const x = index % frame.width;
    const y = Math.floor(index / frame.width);
    if (bytesPerPixel === 3 || bytesPerPixel === 4) {
      const offset = index * bytesPerPixel;
      image.setPixelColor(
        rgbaToJimpColour(
          frame.pixels[offset] ?? 0,
          frame.pixels[offset + 1] ?? 0,
          frame.pixels[offset + 2] ?? 0,
          bytesPerPixel === 4 ? (frame.pixels[offset + 3] ?? 255) : 255,
        ),
        x,
        y,
      );
      continue;
    }

    const value = frame.pixels[index] ?? 0;
    image.setPixelColor(rgbaToJimpColour(value, value, value), x, y);
  }

  await image.write(filePath as `${string}.${string}`);
}

async function waitForGreetingScreen(
  ctx: ToolExecutionContext,
  expectedText: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ matched: boolean; screen: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastScreen = "";

  while (Date.now() <= deadline) {
    lastScreen = await ctx.client.readScreen();
    if (screenContainsExpectedText(lastScreen, expectedText)) {
      return { matched: true, screen: lastScreen };
    }
    if (Date.now() + pollIntervalMs > deadline) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  return { matched: false, screen: lastScreen };
}

const programShuffleArgsSchema = objectSchema({
  description: "Discover PRG/CRT files under root path, run each for a duration, capture screen, then reset.",
  properties: {
    root: optionalSchema(stringSchema({ description: "Root path to search for programs", minLength: 1 }), "/"),
    extensions: optionalSchema(arraySchema(stringSchema({ description: "File extensions to include (without dot)", minLength: 1 })), ["prg", "crt"] as any),
    durationMs: optionalSchema(numberSchema({ description: "Duration to run each program in milliseconds", integer: true, minimum: 1, default: 5000 }), 5000),
    captureScreen: optionalSchema(booleanSchema({ description: "Capture screen after each run", default: true }), true),
    maxPrograms: optionalSchema(numberSchema({ description: "Maximum number of programs to run", integer: true, minimum: 1, default: 10 }), 10),
    outputPath: optionalSchema(stringSchema({ description: "Output directory for run logs and captures", minLength: 1 })),
    resetDelayMs: optionalSchema(numberSchema({ description: "Delay after reset operations to allow the platform to settle.", integer: true, minimum: 0, maximum: 1000, default: 100 }), 100),
  },
  required: [],
  additionalProperties: false,
});

const batchRunWithAssertionsArgsSchema = objectSchema({
  description: "Run programs with post-conditions; produce junit-like results.",
  properties: {
    programs: arraySchema(objectSchema({
      description: "Program to run with assertions",
      properties: {
        path: stringSchema({ description: "Program path (PRG or CRT)", minLength: 1 }),
        assertions: optionalSchema(arraySchema(objectSchema({
          description: "Assertion to check after run",
          properties: {
            type: stringSchema({ description: "Assertion type", enum: ["screen_contains", "memory_equals", "sid_silent"] }),
            pattern: optionalSchema(stringSchema({ description: "Pattern for screen_contains", minLength: 1 })),
            address: optionalSchema(stringSchema({ description: "Address for memory_equals", minLength: 1 })),
            expected: optionalSchema(stringSchema({ description: "Expected value (hex)", minLength: 1 })),
          },
          required: ["type"],
          additionalProperties: false,
        }))),
      },
      required: ["path"],
      additionalProperties: false,
    })),
    continueOnError: optionalSchema(booleanSchema({ description: "Continue running programs after assertion failure", default: false }), false),
    durationMs: optionalSchema(numberSchema({ description: "Duration to run each program before assertions", integer: true, minimum: 1, default: 2000 }), 2000),
    outputPath: optionalSchema(stringSchema({ description: "Output directory for test results", minLength: 1 })),
    resetDelayMs: optionalSchema(numberSchema({ description: "Delay after reset operations to allow the platform to settle.", integer: true, minimum: 0, maximum: 1000, default: 100 }), 100),
  },
  required: ["programs"],
  additionalProperties: false,
});

const crossPlatformGreetingArgsSchema = objectSchema({
  description: "Show a platform-customized greeting on one or more backends, capture screenshots, and verify the result.",
  properties: {
    platforms: optionalSchema(arraySchema(stringSchema({
      description: "Backends to target in sequence.",
      enum: ["vice", "c64u", "u2"],
      minLength: 1,
    }))),
    messageTemplate: optionalSchema(stringSchema({
      description: "Greeting template. Use {PLATFORM}/{BACKEND} for uppercase or {platform}/{backend} for lowercase substitution.",
      minLength: 1,
    }), "HAVE A GREAT DAY, {PLATFORM}!"),
    verify: optionalSchema(booleanSchema({
      description: "Poll the text screen and require the rendered greeting to appear.",
      default: true,
    }), true),
    captureScreenshot: optionalSchema(booleanSchema({
      description: "Capture a framebuffer screenshot on C64U/U64 or VICE. U2 skips screenshots by default; explicitly requesting one on U2 fails before execution.",
      default: true,
    }), true),
    outputPath: optionalSchema(stringSchema({
      description: "Directory for screenshots and the workflow summary JSON.",
      minLength: 1,
    })),
    restoreActiveBackend: optionalSchema(booleanSchema({
      description: "Restore the backend that was active before the workflow started.",
      default: true,
    }), true),
    timeoutMs: optionalSchema(numberSchema({
      description: "Maximum time to wait for each greeting to appear on screen.",
      integer: true,
      minimum: 100,
      maximum: 5000,
      default: 1500,
    }), 1500),
    pollIntervalMs: optionalSchema(numberSchema({
      description: "Delay between screen polls while verifying the greeting.",
      integer: true,
      minimum: 50,
      maximum: 1000,
      default: 100,
    }), 100),
  },
  required: [],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "cross_platform_greeting",
    description: "Render a customized greeting on VICE and/or C64U, capture screenshots, and verify both results in one workflow.",
    summary: "One-call cross-platform greeting demo with backend switching, screenshot capture, and text-screen verification.",
    inputSchema: crossPlatformGreetingArgsSchema.jsonSchema,
    tags: ["orchestration", "demo", "screenshots", "verification"],
    examples: [
      {
        name: "Greet both backends",
        description: "Show a platform-specific greeting on VICE and C64U in one call.",
        arguments: { op: "cross_platform_greeting" },
      },
      {
        name: "Custom template on VICE",
        description: "Render a custom greeting only on the emulator.",
        arguments: {
          op: "cross_platform_greeting",
          platforms: ["vice"],
          messageTemplate: "HELLO FROM {PLATFORM}!",
        },
      },
    ],
    async execute(args, ctx) {
      try {
        const toolStartedAt = Date.now();
        const parsed = crossPlatformGreetingArgsSchema.parse(args ?? {});
        const availableBackends = uniqueGreetingBackends(
          canonicalGreetingBackends().filter((backend) => ctx.client.getAvailableBackends().includes(backend)),
        );
        const requestedBackends = uniqueGreetingBackends(
          ((parsed.platforms as GreetingBackend[] | undefined) ?? availableBackends),
        );
        const missingBackends = requestedBackends.filter((backend) => !availableBackends.includes(backend));

        if (missingBackends.length > 0) {
          throw new ToolExecutionError("Requested greeting backends are not configured", {
            details: {
              requestedBackends,
              availableBackends,
              missingBackends,
            },
          });
        }

        if (requestedBackends.length === 0) {
          throw new ToolExecutionError("No configured backends are available for the greeting workflow", {
            details: { availableBackends },
          });
        }

        if ((args as Record<string, unknown>)?.captureScreenshot === true && requestedBackends.includes("u2")) {
          throw new ToolUnsupportedPlatformError("capture_frame", "u2", ["c64u", "vice"]);
        }
        const visibleViceFastPath = shouldUseVisibleViceGreetingFastPath(args ?? {}, requestedBackends);
        const verify = visibleViceFastPath ? false : parsed.verify !== false;
        const captureScreenshot = visibleViceFastPath ? false : parsed.captureScreenshot !== false;
        const restoreActiveBackend = parsed.restoreActiveBackend !== false;
        const outputPath = (captureScreenshot && requestedBackends.some((backend) => backend !== "u2")) || parsed.outputPath
          ? resolvePath(
              String(parsed.outputPath ?? joinPath(process.cwd(), "artifacts", "greetings", `run_${Date.now()}`)),
            )
          : undefined;
        const timeoutMs = parsed.timeoutMs ?? 1500;
        const pollIntervalMs = parsed.pollIntervalMs ?? 100;
        const template = parsed.messageTemplate ?? "HAVE A GREAT DAY, {PLATFORM}!";
        const startingBackend = await ctx.client.getActiveBackendType();
        const results: Array<Record<string, unknown>> = [];
        let restoreError: string | undefined;
        let restoreBackendLatencyMs = 0;

        if (outputPath) {
          await fs.mkdir(outputPath, { recursive: true });
        }

        try {
          for (const backend of requestedBackends) {
            const backendCaptureScreenshot = captureScreenshot && backend !== "u2";
            const expectedText = applyGreetingTemplate(template, backend);
            const program = buildGreetingProgram(expectedText);
            const timeline: Array<Record<string, unknown>> = [];
            let executionMode = "direct_screen_write";
            let preparedCaptureSession = false;
            const client = ctx.client as ToolExecutionContext["client"] & {
              renderGreetingScreen?: (options: { message: string }) => Promise<{ success: boolean; details?: unknown }>;
              prepareVideoCapture?: (options?: { keepAliveMs?: number }) => Promise<void>;
              releaseVideoCapture?: () => Promise<void>;
              captureFrames: (options?: { count?: number; reuseSession?: boolean; keepAliveMs?: number }) => Promise<{ frames: readonly CapturedFrame[] }>;
            };
            const timedStep = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
              const startedAt = Date.now();
              try {
                const result = await withDiagnosticSpan("greeting", name, { backend }, fn);
                timeline.push({ name, latencyMs: Date.now() - startedAt, ok: true });
                return result;
              } catch (error) {
                timeline.push({
                  name,
                  latencyMs: Date.now() - startedAt,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
                throw error;
              }
            };

            await timedStep("switch_backend", async () => {
              ctx.client.switchBackend(backend);
              ctx.setPlatform(backend);
            });

            let prepareCapturePromise: Promise<void> | undefined;
            if (backendCaptureScreenshot && backend === "c64u" && typeof client.prepareVideoCapture === "function") {
              prepareCapturePromise = timedStep("prepare_capture", async () => {
                await client.prepareVideoCapture?.({ keepAliveMs: Math.max(500, timeoutMs) });
                preparedCaptureSession = true;
              }).catch(() => {
                preparedCaptureSession = false;
              });
            }

            const runResult = await timedStep("render_greeting_screen", async () => {
              if (typeof client.renderGreetingScreen === "function") {
                executionMode = "direct_screen_write";
                return client.renderGreetingScreen({ message: expectedText });
              }

              executionMode = "basic_program";
              return ctx.client.uploadAndRunBasic(program);
            });
            if (prepareCapturePromise) {
              await prepareCapturePromise;
            }
            const backendResult: Record<string, unknown> = {
              backend,
              expectedText,
              program,
              executionMode,
              timeline,
            };

            if (!runResult.success) {
              if (preparedCaptureSession && typeof client.releaseVideoCapture === "function") {
                try {
                  await timedStep("release_capture", () => client.releaseVideoCapture?.());
                } catch {
                  // Preserve the original render failure and best-effort cleanup.
                }
              }
              backendResult.success = false;
              backendResult.error = "basic_run_failed";
              backendResult.details = runResult.details ?? null;
              results.push(backendResult);
              continue;
            }

            let screen = "";
            let screenMatched = false;
            if (verify) {
              const waited = await timedStep(
                "verify_screen",
                () => waitForGreetingScreen(ctx, expectedText, timeoutMs, pollIntervalMs),
              );
              screen = waited.screen;
              screenMatched = waited.matched;
            }

            backendResult.screen = screen;

            let screenshotPath: string | undefined;
            let screenshotAnalysis: Record<string, unknown> | undefined;
            let screenshotError: string | undefined;

            if (backendCaptureScreenshot) {
              try {
                const capture = await timedStep("capture_screenshot", () => client.captureFrames({
                  count: 1,
                  reuseSession: preparedCaptureSession,
                  keepAliveMs: preparedCaptureSession ? Math.max(500, timeoutMs) : 0,
                }));
                const frame = capture.frames[0];
                if (!frame) {
                  throw new Error("No video frame returned by backend capture");
                }

                await timedStep("persist_screenshot", async () => {
                  screenshotAnalysis = analyseCapturedFrame(frame);
                  screenshotPath = outputPath
                    ? resolvePath(joinPath(outputPath, `${backend}.png`))
                    : undefined;
                  if (screenshotPath) {
                    await writeCapturedFramePng(frame, screenshotPath);
                  }
                });
              } catch (error) {
                screenshotError = error instanceof Error ? error.message : String(error);
              } finally {
                if (preparedCaptureSession && typeof client.releaseVideoCapture === "function") {
                  try {
                    await timedStep("release_capture", () => client.releaseVideoCapture?.());
                  } catch {
                    // Surface screenshot failures, but do not overwrite a successful capture result.
                  }
                }
              }
            }

            backendResult.verification = {
              screenContainsExpectedText: verify ? screenMatched : undefined,
              screenshotCaptured: backendCaptureScreenshot ? !screenshotError : undefined,
              screenshotAnalysis,
            };
            if (screenshotPath) {
              backendResult.screenshotPath = screenshotPath;
            }
            if (screenshotError) {
              backendResult.screenshotError = screenshotError;
            }

            backendResult.success = runResult.success
              && (!verify || screenMatched)
              && (!backendCaptureScreenshot || !screenshotError);
            backendResult.promptToVisibleLatencyMs = timeline
              .filter((entry) => entry.ok === true && (entry.name === "switch_backend" || entry.name === "render_greeting_screen" || entry.name === "verify_screen"))
              .reduce((total, entry) => total + Number(entry.latencyMs ?? 0), 0);
            backendResult.totalLatencyMs = timeline
              .filter((entry) => entry.ok === true)
              .reduce((total, entry) => total + Number(entry.latencyMs ?? 0), 0);
            results.push(backendResult);
          }
        } finally {
          if (restoreActiveBackend) {
            try {
              const restoreStartedAt = Date.now();
              await withDiagnosticSpan("greeting", "restore_backend", { backend: startingBackend }, async () => {
                ctx.client.switchBackend(startingBackend);
                ctx.setPlatform(startingBackend);
              });
              restoreBackendLatencyMs = Date.now() - restoreStartedAt;
            } catch (error) {
              restoreError = error instanceof Error ? error.message : String(error);
            }
          }
        }

        const toolCallLatencyMs = Date.now() - toolStartedAt;
        const backendTimedLatencyMs = results
          .map((result) => Number(result.totalLatencyMs ?? 0))
          .reduce((total, latency) => total + latency, 0);
        const orchestrationOverheadMs = Math.max(0, toolCallLatencyMs - backendTimedLatencyMs - restoreBackendLatencyMs);
        const success = results.every((result) => result.success === true) && !restoreError;
        const payload = {
          kind: "cross_platform_greeting" as const,
          availableBackends,
          requestedBackends,
          startingBackend,
          restoredBackend: restoreActiveBackend ? startingBackend : await ctx.client.getActiveBackendType(),
          outputPath: outputPath ?? null,
          fastPath: visibleViceFastPath ? "visible_vice_no_probe" : null,
          toolCallLatencyMs,
          restoreBackendLatencyMs,
          orchestrationOverheadMs,
          results,
          ...(restoreError ? { restoreError } : {}),
        };

        if (outputPath) {
          const reportPath = resolvePath(joinPath(outputPath, "results.json"));
          await fs.writeFile(reportPath, JSON.stringify(payload, null, 2), "utf8");
          payload.outputPath = outputPath;
          (payload as { reportPath?: string }).reportPath = reportPath;
        }

        const result = jsonResult(payload, {
          success,
          backends: requestedBackends,
          outputPath: outputPath ?? null,
        });
        return success ? result : { ...result, isError: true };
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "program_shuffle",
    description: "Discover and run PRG/CRT programs under a root path, capturing screens and resetting between runs.",
    summary: "Automated program testing workflow with screen captures and run logs.",
    inputSchema: programShuffleArgsSchema.jsonSchema,
    tags: ["orchestration", "programs", "testing"],
    examples: [{ name: "Shuffle games", description: "Run all PRG files in /games", arguments: { root: "/games", durationMs: 3000, maxPrograms: 5 } }],
    async execute(args, ctx) {
      try {
        const parsed = programShuffleArgsSchema.parse(args ?? {});
        const root = parsed.root ?? "/";
        const extensions = (parsed.extensions ?? ["prg", "crt"]) as string[];
        const durationMs = parsed.durationMs ?? 5000;
        const maxPrograms = parsed.maxPrograms ?? 10;
        const captureScreen = parsed.captureScreen !== false;
  const resetDelayMs = parsed.resetDelayMs ?? 100;
        
        // Discover programs
        const programs: string[] = [];
        for (const ext of extensions) {
          const pattern = `${root}/**/*.${ext}`;
          try {
            const info = await (ctx.client as any).filesInfo(pattern);
            const paths = Array.isArray(info) ? info : (Array.isArray((info as any)?.paths) ? (info as any).paths : []);
            for (const p of paths) {
              if (typeof p === "string" && programs.length < maxPrograms) {
                programs.push(p);
              }
            }
          } catch (e) {
            // Ignore discovery errors for individual patterns
          }
        }

        if (programs.length === 0) {
          throw new ToolExecutionError("No programs found", { details: { root, extensions } });
        }

        // Prepare output directory
        const outputPath = parsed.outputPath 
          ? resolvePath(String(parsed.outputPath))
          : resolvePath(joinPath(getTasksHomeDir(), `shuffle_${Date.now()}`));
        await fs.mkdir(outputPath, { recursive: true });

        const results: Array<{ path: string; started: string; ended: string; durationMs: number; screen?: string; error?: string }> = [];

        // Run each program
        for (const programPath of programs.slice(0, maxPrograms)) {
          const started = new Date();
          let screen: string | undefined;
          let error: string | undefined;

          try {
            const ext = programPath.toLowerCase().split(".").pop();
            if (ext === "prg") {
              await (ctx.client as any).runPrgFile(programPath);
            } else if (ext === "crt") {
              await (ctx.client as any).runCrtFile(programPath);
            }

            await sleep(durationMs);

            if (captureScreen) {
              screen = await (ctx.client as any).readScreen();
            }
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          } finally {
            // Reset
            try {
              await (ctx.client as any).reset();
              if (resetDelayMs > 0) {
                await sleep(resetDelayMs);
              }
            } catch (e) {
              // Ignore reset errors
            }
          }

          const ended = new Date();
          results.push({
            path: programPath,
            started: formatTimestampSpec(started),
            ended: formatTimestampSpec(ended),
            durationMs: ended.getTime() - started.getTime(),
            screen,
            error,
          });
        }

        // Write log
        const logPath = resolvePath(joinPath(outputPath, "shuffle.json"));
        await fs.writeFile(logPath, JSON.stringify({ programs: results, summary: { total: results.length, errors: results.filter(r => r.error).length } }, null, 2), "utf8");

        return jsonResult({ outputPath, programs: results.length, errors: results.filter(r => r.error).length, logPath }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "batch_run_with_assertions",
    description: "Run multiple programs with post-condition assertions; produce junit-like results.",
    summary: "Automated testing workflow with assertions and structured reporting.",
    inputSchema: batchRunWithAssertionsArgsSchema.jsonSchema,
    tags: ["orchestration", "testing", "assertions"],
    examples: [
      {
        name: "Test programs",
        description: "Run programs with screen assertions",
        arguments: {
          programs: [
            { path: "/games/demo.prg", assertions: [{ type: "screen_contains", pattern: "READY." }] },
          ],
          continueOnError: true,
        },
      },
    ],
    async execute(args, ctx) {
      try {
        const parsed = batchRunWithAssertionsArgsSchema.parse(args ?? {});
        const programs = parsed.programs as Array<{ path: string; assertions?: Array<{ type: string; pattern?: string; address?: string; expected?: string }> }>;
        const platform = ctx.platform?.id ?? getPlatformStatus().id;
        if (platform === "vice" && programs.some((program) => program.path.toLowerCase().endsWith(".crt"))) {
          throw new ToolUnsupportedPlatformError("run_crt", platform, ["c64u", "u2"]);
        }
        const continueOnError = parsed.continueOnError ?? false;
        const durationMs = parsed.durationMs ?? 2000;
  const resetDelayMs = parsed.resetDelayMs ?? 100;

        const outputPath = parsed.outputPath
          ? resolvePath(String(parsed.outputPath))
          : resolvePath(joinPath(getTasksHomeDir(), `batch_${Date.now()}`));
        await fs.mkdir(outputPath, { recursive: true });

        const results: Array<{ path: string; status: "pass" | "fail" | "error"; assertions: Array<{ type: string; status: "pass" | "fail"; message?: string }>; error?: string }> = [];

        for (const program of programs) {
          const started = new Date();
          const assertionResults: Array<{ type: string; status: "pass" | "fail"; message?: string }> = [];
          let status: "pass" | "fail" | "error" = "pass";
          let error: string | undefined;

          try {
            // Run program
            const ext = program.path.toLowerCase().split(".").pop();
            if (ext === "prg") {
              const run = await (ctx.client as any).runPrgFile(program.path);
              if (!run.success) throw new ToolExecutionError("PRG playback failed", { details: run.details });
            } else if (ext === "crt") {
              const run = await (ctx.client as any).runCrtFile(program.path);
              if (!run.success) throw new ToolExecutionError("CRT playback failed", { details: run.details });
            }

            await sleep(durationMs);

            // Check assertions
            const assertions = program.assertions ?? [];
            for (const assertion of assertions) {
              if (assertion.type === "screen_contains") {
                const screen = await (ctx.client as any).readScreen();
                const pattern = assertion.pattern ?? "";
                const matched = screen.includes(pattern);
                assertionResults.push({
                  type: assertion.type,
                  status: matched ? "pass" : "fail",
                  message: matched ? undefined : `Screen does not contain "${pattern}"`,
                });
                if (!matched) status = "fail";
              } else if (assertion.type === "memory_equals") {
                const addr = assertion.address ?? "$0400";
                const expected = assertion.expected ?? "$00";
                const result = await (ctx.client as any).readMemory(addr, "1");
                const actual = result.data ?? "$00";
                const matched = actual.toLowerCase() === expected.toLowerCase();
                assertionResults.push({
                  type: assertion.type,
                  status: matched ? "pass" : "fail",
                  message: matched ? undefined : `Memory at ${addr} is ${actual}, expected ${expected}`,
                });
                if (!matched) status = "fail";
              } else if (assertion.type === "sid_silent") {
                // Check SID gate bits are off (simple check)
                const result = await (ctx.client as any).readMemory("$D404", "1");
                const gate1 = parseInt((result.data ?? "$00").slice(1), 16) & 0x01;
                const isSilent = gate1 === 0;
                assertionResults.push({
                  type: assertion.type,
                  status: isSilent ? "pass" : "fail",
                  message: isSilent ? undefined : "SID voice 1 gate is on",
                });
                if (!isSilent) status = "fail";
              }
            }
          } catch (e) {
            status = "error";
            error = e instanceof Error ? e.message : String(e);
          } finally {
            // Reset
            try {
              await (ctx.client as any).reset();
              if (resetDelayMs > 0) {
                await sleep(resetDelayMs);
              }
            } catch (e) {
              // Ignore reset errors
            }
          }

          results.push({
            path: program.path,
            status,
            assertions: assertionResults,
            error,
          });

          if (status !== "pass" && !continueOnError) {
            break;
          }
        }

        // Write junit-like report
        const reportPath = resolvePath(joinPath(outputPath, "results.json"));
        const summary = {
          total: results.length,
          passed: results.filter(r => r.status === "pass").length,
          failed: results.filter(r => r.status === "fail").length,
          errors: results.filter(r => r.status === "error").length,
        };
        await fs.writeFile(reportPath, JSON.stringify({ summary, results }, null, 2), "utf8");

        return jsonResult({ outputPath, summary, reportPath }, { success: summary.failed === 0 && summary.errors === 0 });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];

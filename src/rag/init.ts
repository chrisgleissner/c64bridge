/*
C64 Bridge - Local RAG bootstrap
GPL-2.0-only
*/

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LocalMiniHashEmbedding } from "./embeddings.js";
import { buildAllIndexes, loadIndexes } from "./indexer.js";
import { LocalRagRetriever } from "./retriever.js";
import { LoggingRagRetriever } from "./loggingRetriever.js";
import type { RagRetriever } from "./types.js";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const assetRoot = process.env.C64BRIDGE_ASSET_ROOT ? path.resolve(process.env.C64BRIDGE_ASSET_ROOT) : PACKAGE_ROOT;
const EXTERNAL_DIR = path.join(assetRoot, "external");
const BASIC_DATA_DIR = path.join(assetRoot, "data/basic/examples");
const ASM_DATA_DIR = path.join(assetRoot, "data/assembly/examples");
const DOC_DIR = path.join(assetRoot, "doc");
const CONTEXT_DIR = path.join(assetRoot, "data/context");
const BOOTSTRAP_PATH = path.join(CONTEXT_DIR, "bootstrap.md");
const AGENTS_PATH = path.join(assetRoot, "AGENTS.md");
const PROMPTS_DIR = path.join(assetRoot, ".github/prompts");
const CHAT_PATH = path.join(CONTEXT_DIR, "chat.md");

function resolveEmbeddingsDir(): string {
  return path.resolve(process.env.RAG_EMBEDDINGS_DIR ?? path.join(assetRoot, "data"));
}

function embeddingIndexPaths() {
  const dir = resolveEmbeddingsDir();
  return {
    dir,
    basic: path.join(dir, "embeddings_basic.json"),
    asm: path.join(dir, "embeddings_asm.json"),
    mixed: path.join(dir, "embeddings_mixed.json"),
    hardware: path.join(dir, "embeddings_hardware.json"),
    other: path.join(dir, "embeddings_other.json"),
  };
}

export interface LazyRagRetriever extends RagRetriever {
  warmup(): Promise<void>;
}

interface LazyRagHooks {
  onInitStart?: () => void;
  onInitComplete?: () => void;
  onInitError?: (error: unknown) => void;
}

export function createLazyRagRetriever(
  factory: () => Promise<RagRetriever>,
  hooks: LazyRagHooks = {},
): LazyRagRetriever {
  let resolved: RagRetriever | undefined;
  let pending: Promise<RagRetriever> | undefined;

  const ensure = async (): Promise<RagRetriever> => {
    if (resolved) {
      return resolved;
    }

    if (!pending) {
      hooks.onInitStart?.();
      pending = factory().then((retriever) => {
        resolved = retriever;
        hooks.onInitComplete?.();
        return retriever;
      }).catch((error) => {
        pending = undefined;
        hooks.onInitError?.(error);
        throw error;
      });
    }

    return pending;
  };

  return {
    async retrieve(query, topK, filterLanguage) {
      const retriever = await ensure();
      return retriever.retrieve(query, topK, filterLanguage);
    },
    async warmup() {
      await ensure();
    },
  };
}

export async function initRag(): Promise<RagRetriever> {
  const initDelayMs = Number(process.env.RAG_INIT_DELAY_MS ?? 0);
  if (Number.isFinite(initDelayMs) && initDelayMs > 0) {
    await delay(initDelayMs);
  }

  const model = new LocalMiniHashEmbedding(384);
  // Build on start only when explicitly requested
  const buildOnStart = String(process.env.RAG_BUILD_ON_START ?? "").trim().toLowerCase();
  if (buildOnStart === "1" || buildOnStart === "true" || buildOnStart === "yes") {
    const needBuild = await needsRebuild();
    if (needBuild) {
      await buildAllIndexes({ model });
    }
  }

  const embeddingsDir = resolveEmbeddingsDir();
  const { basic, asm, mixed, hardware, other } = await loadIndexes({ embeddingsDir });
  const baseRetriever = new LocalRagRetriever(model, { basic, asm, mixed, hardware, other });
  const loggingRetriever = new LoggingRagRetriever(baseRetriever);

  // Background watcher: reindex if source files change (checks mtimes periodically)
  // Default disabled to avoid churn/conflicts unless explicitly enabled
  const intervalMs = Number(process.env.RAG_REINDEX_INTERVAL_MS ?? 0);
  if (intervalMs > 0) {
    setInterval(async () => {
      try {
        if (await needsRebuild()) {
          await buildAllIndexes({ model });
          const updated = await loadIndexes({ embeddingsDir: resolveEmbeddingsDir() });
          baseRetriever.updateIndexes(updated);
        }
      } catch (err) {
        // swallow in background to avoid crashing server
        // eslint-disable-next-line no-console
        console.warn("RAG reindex error", err);
      }
    }, intervalMs).unref();
  }

  return loggingRetriever;
}

async function fileMtime(file: string): Promise<number | null> {
  try {
    const stat = await fs.stat(file);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function dirMtimeRecursive(root: string): Promise<number> {
  let newest = 0;
  async function walk(dir: string) {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await fs.stat(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  }
  await walk(root);
  return newest;
}

async function needsRebuild(): Promise<boolean> {
  const paths = embeddingIndexPaths();
  const indexFiles = [paths.basic, paths.asm, paths.mixed, paths.hardware, paths.other];
  const indexTimes = await Promise.all(indexFiles.map((file) => fileMtime(file)));
  if (indexTimes.some((time) => time === null)) {
    return true;
  }
  const oldestIndex = Math.min(...(indexTimes as number[]));
  const [basicDataM, asmDataM, externalM, docsM, bootstrapM, agentsM, promptsM, chatM] = await Promise.all([
    dirMtimeRecursive(BASIC_DATA_DIR),
    dirMtimeRecursive(ASM_DATA_DIR),
    dirMtimeRecursive(EXTERNAL_DIR),
    dirMtimeRecursive(DOC_DIR).catch(() => 0),
    fileMtime(BOOTSTRAP_PATH).then((v) => v ?? 0),
    fileMtime(AGENTS_PATH).then((v) => v ?? 0),
    promptFilesMtime().then((v) => v ?? 0),
    fileMtime(CHAT_PATH).then((v) => v ?? 0),
  ]);
  const newestSource = Math.max(basicDataM, asmDataM, externalM, docsM, bootstrapM, agentsM, promptsM, chatM);
  return newestSource > oldestIndex;
}

async function promptFilesMtime(): Promise<number> {
  let newest = 0;
  try {
    const entries = await fs.readdir(PROMPTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".prompt.md")) continue;
      const stat = await fs.stat(path.join(PROMPTS_DIR, entry.name)).catch(() => null);
      if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  } catch {
    return 0;
  }
  return newest;
}

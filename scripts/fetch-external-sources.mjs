#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(__dirname, '..');
  register("tsx/esm", pathToFileURL(projectRoot));
  const { fetchFromCsv } = await import('../src/rag/externalFetcher.ts');
  // Resolve sources.csv from env, dist/rag, or src/rag (in that order)
  let csvPath = process.env.RAG_SOURCES_CSV;
  if (!csvPath) {
    const distCsv = path.join(projectRoot, 'dist', 'rag', 'sources.csv');
    try {
      await import('node:fs/promises').then((fs) => fs.access(distCsv)).catch(() => { throw new Error('nope'); });
      csvPath = distCsv;
    } catch {
      csvPath = path.join(projectRoot, 'src', 'rag', 'sources.csv');
    }
  }
  const outDir = process.env.RAG_EXTERNAL_DIR || path.join(projectRoot, 'external');
  const defaultDepth = Number(process.env.RAG_DEFAULT_DEPTH || 5);
  const perDomainRps = Number(process.env.RAG_RPS || 5);
  const maxRequestsPerSeed = Number(process.env.RAG_MAX_REQUESTS || 500);

  const colors = {
    reset: '\x1b[0m',
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    start: '\x1b[34m',
    success: '\x1b[32m',
  };

  const log = (entry) => {
    const { level = 'info', event, data } = entry;
    let color = colors.info;
    if (event === 'request_start') color = colors.start;
    else if (event === 'download_success') color = colors.success;
    else if (level === 'warn') color = colors.warn;
    else if (level === 'error') color = colors.error;
    const prefix = event === 'download_success' ? '✅ ' : (event === 'http_error' || level === 'error' || level === 'warn') ? '❌ ' : '';
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, data });
    process.stdout.write(`${color}${prefix}${line}${colors.reset}\n`);
  };

  const summaries = await fetchFromCsv({
    csvPath,
    outDir,
    defaultDepth,
    perDomainRps,
    maxRequestsPerSeed,
    log,
  });

  const total = summaries.reduce((a, s) => a + s.visited, 0);
  const dl = summaries.reduce((a, s) => a + s.downloaded, 0);
  log({ level: 'info', event: 'session_summary', data: { seeds: summaries.length, totalVisited: total, totalDownloaded: dl } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

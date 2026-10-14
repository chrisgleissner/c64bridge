// @ts-check
import assert from '#test/assert';
import test from '#test/runner';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalMiniHashEmbedding } from '../src/rag/embeddings.ts';
import { buildAllIndexes, loadIndexes } from '../src/rag/indexer.ts';
import { LocalRagRetriever } from '../src/rag/retriever.ts';

const TEST_TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp');

/**
 * @param {string} prefix
 */
async function makeTempDir(prefix) {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TEST_TMP_ROOT, `${prefix}-`));
}

/**
 * @param {string} key
 * @param {string | undefined} originalValue
 */
function restoreEnv(key, originalValue) {
  if (originalValue === undefined) delete process.env[key];
  else process.env[key] = originalValue;
}

test('RAG indexing scenarios', { concurrency: false }, async (t) => {
  const embeddingsDir = await makeTempDir('embeddings');
  const basicDir = await makeTempDir('basic');
  const asmDir = await makeTempDir('asm');
  const externalDir = await makeTempDir('external');
  const originalEmbeddingsDir = process.env.RAG_EMBEDDINGS_DIR;
  process.env.RAG_EMBEDDINGS_DIR = embeddingsDir;

  const model = new LocalMiniHashEmbedding(64);

  const basicSample = `10 PRINT "DRAW A SINE WAVE"
20 FOR A=0 TO 255
30 POKE 53280,(SIN(A/10)+1)*8
40 NEXT A
50 GOTO 20
`;
  const asmSample = `*=$0801
START
        LDA #$00
LOOP    STA $D020
        ADC #$01
        JMP LOOP
`;
  await fs.writeFile(path.join(basicDir, 'sine.bas'), basicSample, 'utf8');
  await fs.writeFile(path.join(asmDir, 'border.asm'), asmSample, 'utf8');

  const buildOptions = {
    model,
    embeddingsDir,
    basicDirs: [basicDir],
    asmDirs: [asmDir],
    externalDirs: [externalDir],
    docFiles: [],
  };

  try {
    await buildAllIndexes(buildOptions);
    let indexes = await loadIndexes({ embeddingsDir });
    let rag = new LocalRagRetriever(model, indexes);

    await t.test('retrieves BASIC refs', async () => {
      const refs = await rag.retrieve('draw a sine wave', 3, 'basic');
      assert.ok(Array.isArray(refs) && refs.length > 0);
      assert.ok(refs.some((ref) => /POKE|PRINT|SIN|TAB|GOTO/i.test(ref.snippet)));
    });

    await t.test('retrieves ASM refs for raster/border', async () => {
      const refs = await rag.retrieve('cycle border colors', 3, 'asm');
      assert.ok(refs.length > 0);
      const hasBorderColour = refs.some((ref) => /\$d020|\$D020|border colour|border color/i.test(ref.snippet));
      const hasAsmOps = refs.some((ref) => /\b(JMP|LDA|STA|ADC|AND)\b/.test(ref.snippet));
      assert.ok(hasBorderColour || hasAsmOps, 'expected at least one reference touching border colour logic');
    });

    await t.test('classification identifies mixed, hardware, and other sources', async () => {
      const mixedFile = path.join(externalDir, 'combo.txt');
      const hardwareFile = path.join(externalDir, 'sid_notes.txt');
      const otherFile = path.join(externalDir, 'notes.md');

      try {
        await fs.writeFile(mixedFile, '10 PRINT "HELLO"\nJSR $FFD2\nLDA #$41\nSTA $0400\n', 'utf8');
        await fs.writeFile(hardwareFile, 'The SID chip at $D400 controls voices, and register 53280 alters the border colour.', 'utf8');
        await fs.writeFile(otherFile, 'This text documents planning notes unrelated to code or hardware.', 'utf8');

        await buildAllIndexes(buildOptions);
        indexes = await loadIndexes({ embeddingsDir });

        assert.ok(indexes.mixed && indexes.mixed.records.some((r) => r.sourcePath.endsWith('combo.txt')));
        assert.ok(indexes.hardware && indexes.hardware.records.some((r) => r.sourcePath.endsWith('sid_notes.txt')));
        assert.ok(indexes.other && indexes.other.records.some((r) => r.sourcePath.endsWith('notes.md')));
      } finally {
        await Promise.all([
          fs.rm(mixedFile, { force: true }),
          fs.rm(hardwareFile, { force: true }),
          fs.rm(otherFile, { force: true }),
        ]);
        await buildAllIndexes(buildOptions);
        indexes = await loadIndexes({ embeddingsDir });
        rag = new LocalRagRetriever(model, indexes);
      }
    });

    await t.test('chunks external OCR text with chapter headings', async () => {
      const ocrFile = path.join(externalDir, 'butterfield.ocr.txt');
      const ocrSample = [
        'CHAPTER 1 INTRODUCTION TO MACHINE CODE',
        '',
        'Machine code programs let you control the 6510 directly.',
        '',
        '10 PRINT "HELLO"',
        '',
        '\f',
        'SECTION 2 LOOPS AND REGISTERS',
        '',
        '* = $0801',
        '; initialise border colour',
        'LDA #$00',
        'STA $D020',
      ].join('\n');
      try {
        await fs.writeFile(ocrFile, ocrSample, 'utf8');
        await buildAllIndexes(buildOptions);
        indexes = await loadIndexes({ embeddingsDir });

        const allRecords = [
          ...(indexes.basic?.records ?? []),
          ...(indexes.asm?.records ?? []),
          ...(indexes.mixed?.records ?? []),
          ...(indexes.hardware?.records ?? []),
          ...(indexes.other?.records ?? []),
        ];
        const ocrRecords = allRecords.filter((record) => record.sourcePath.endsWith('butterfield.ocr.txt'));
        assert.ok(ocrRecords.length >= 2, 'expected OCR document to be chunked into multiple records');

        const hasChapterChunk = ocrRecords.some((record) => /Source: .*#CHAPTER-1/i.test(record.text));
        const hasSectionChunk = ocrRecords.some((record) => /Source: .*#SECTION-2/i.test(record.text));
        assert.ok(hasChapterChunk && hasSectionChunk, 'expected provenance comments with chapter headings');

        const hasBasicLine = ocrRecords.some((record) => /10 PRINT/i.test(record.text));
        const hasAsmLine = ocrRecords.some((record) => /\bLDA\b/.test(record.text));
        assert.ok(hasBasicLine || hasAsmLine, 'expected BASIC or ASM lines preserved in chunks');
      } finally {
        await fs.rm(ocrFile, { force: true });
        await buildAllIndexes(buildOptions);
        indexes = await loadIndexes({ embeddingsDir });
        rag = new LocalRagRetriever(model, indexes);
      }
    });

    await t.test('derives URIs and trims provenance comments', async () => {
      const provenanceText = '<!-- Source: c64://docs/example#Section -->\n10 PRINT "PROVENANCE"';
      const externalText = 'LDX #$00\nSTX $0400';
      const provenanceVector = Array.from(await model.embed(provenanceText));
      const externalVector = Array.from(await model.embed(externalText));

      const provenanceRecord = {
        name: 'docs/example.md',
        language: 'basic',
        vector: provenanceVector,
        text: provenanceText,
        sourcePath: 'docs/example.md',
        sourceMtimeMs: Date.now(),
        sourceUrl: 'https://example.com/docs/example',
      };

      const externalRecord = {
        name: 'asm/external.asm',
        language: 'asm',
        vector: externalVector,
        text: externalText,
        sourcePath: 'asm/external.asm',
        sourceMtimeMs: Date.now(),
        sourceRepoUrl: 'https://repo.local/asm/external.asm',
      };

      const indexes = {
        basic: { dim: model.dim, model: model.constructor.name, records: [provenanceRecord] },
        asm: { dim: model.dim, model: model.constructor.name, records: [externalRecord] },
        mixed: { dim: model.dim, model: model.constructor.name, records: [] },
        hardware: { dim: model.dim, model: model.constructor.name, records: [] },
        other: { dim: model.dim, model: model.constructor.name, records: [] },
      };

      const localRag = new LocalRagRetriever(model, indexes);
      const provRefs = await localRag.retrieve('provenance', 1, 'basic');
      assert.equal(provRefs[0].origin, 'c64://docs/example#Section');
      assert.equal(provRefs[0].uri, 'c64://docs/example#Section');
      assert.equal(provRefs[0].snippet, '10 PRINT "PROVENANCE"');

      const asmRefs = await localRag.retrieve('border', 1, 'asm');
      assert.equal(asmRefs[0].origin, undefined);
      assert.equal(asmRefs[0].uri, 'https://repo.local/asm/external.asm');
      assert.match(asmRefs[0].snippet, /LDX #\$00/);
    });
    await t.test('excludes internal review and plan documents under doc/', async () => {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      await buildAllIndexes({
        ...buildOptions,
        docFiles: [
          path.join(repoRoot, 'doc', 'reviews', 'vice-support-review.md'),
          path.join(repoRoot, 'doc', 'developer.md'),
        ],
      });
      const docIndexes = await loadIndexes({ embeddingsDir });
      const origins = [
        ...(docIndexes.basic?.records ?? []),
        ...(docIndexes.asm?.records ?? []),
        ...(docIndexes.mixed?.records ?? []),
        ...(docIndexes.hardware?.records ?? []),
        ...(docIndexes.other?.records ?? []),
      ].map((record) => record.origin ?? record.sourcePath);
      assert.ok(origins.some((origin) => origin.startsWith('doc/developer.md')), 'expected doc/developer.md to be indexed');
      assert.ok(!origins.some((origin) => origin.includes('doc/reviews/')), 'doc/reviews must not be indexed');
    });
  } finally {
    restoreEnv('RAG_EMBEDDINGS_DIR', originalEmbeddingsDir);
    await Promise.all([
      fs.rm(embeddingsDir, { recursive: true, force: true }),
      fs.rm(basicDir, { recursive: true, force: true }),
      fs.rm(asmDir, { recursive: true, force: true }),
      fs.rm(externalDir, { recursive: true, force: true }),
    ]);
  }
});

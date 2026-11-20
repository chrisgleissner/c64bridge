/*
C64 Bridge - Local RAG Retriever
GPL-2.0-only
*/

import {
  RagRetriever as IRagRetriever,
  RagLanguage,
  EmbeddingIndexFile,
  RagReference,
  EmbeddingRecord,
} from "./types.js";
import { EmbeddingModel, cosineSimilarity } from "./embeddings.js";
import { listKnowledgeResources } from "./knowledgeIndex.js";

// Language signals (KNOWLEDGE-5). They are a ranking hint, not a filter: a numbered line or an
// upper-case BASIC keyword followed by an operand, and a line that starts with a 6502 mnemonic and
// an operand or comment. Case-sensitive for BASIC, so ordinary prose ("Read the manual") is not code.
export const BASIC_SIGNAL_RE = /(^\s*\d{1,5}\s+[A-Z])|\b(?:PRINT|POKE|GOTO|GOSUB|INPUT|CHR\$|TI\$|PEEK)[ (#$"0-9]|\bTAB\(/m;
// Mnemonics that are not English words may be followed by any operand; "and", "bit", "dec", "inc"
// and "sec" count only with an immediate, hex, binary or indirect operand.
const MNEMONIC_PLAIN =
  "adc|asl|bcc|bcs|beq|bmi|bne|bpl|brk|bvc|bvs|clc|cld|cli|clv|cmp|cpx|cpy|dex|dey|eor|inx|iny|jmp|jsr|lda|ldx|ldy|lsr|nop|ora|pha|php|pla|plp|rol|ror|rti|rts|sbc|sed|sei|sta|stx|sty|tax|tay|tsx|txa|txs|tya";
export const ASM_SIGNAL_RE = new RegExp(
  `^[ \\t]*(?:[A-Za-z_]\\w*:[ \\t]*)?(?:(?:${MNEMONIC_PLAIN})(?:[ \\t]+[#($%<>*\\w-]|[ \\t]*(?:;|$))|(?:and|bit|dec|inc|sec)[ \\t]+[#$%(])`,
  "im",
);
const PROVENANCE_COMMENT_RE = /^\s*<!--\s*Source:\s*(.*?)\s*-->\s*/i;

// Build a mapping from file paths to resource URIs
function buildPathToUriMap(): Map<string, string> {
  const resources = listKnowledgeResources();
  const map = new Map<string, string>();
  for (const resource of resources) {
    if (resource.relativePath) {
      // Normalize the path for matching
      const normalizedPath = resource.relativePath.replace(/\\/g, "/");
      map.set(normalizedPath, resource.uri);
    }
  }
  return map;
}

const PATH_TO_URI_MAP = buildPathToUriMap();

const vectorCache = new WeakMap<EmbeddingRecord, Float32Array>();
function vectorOf(record: EmbeddingRecord): Float32Array {
  let vector = vectorCache.get(record);
  if (!vector) {
    vector = new Float32Array(record.vector);
    vectorCache.set(record, vector);
  }
  return vector;
}
const LANGUAGE_SIGNAL_BONUS = 0.1;
const ASM_SOURCE_EXT_RE = /\.(?:asm|s|a65|inc)$/i;
const BASIC_SOURCE_EXT_RE = /\.bas$/i;

export class LocalRagRetriever implements IRagRetriever {
  private readonly model: EmbeddingModel;
  private basic?: EmbeddingIndexFile;
  private asm?: EmbeddingIndexFile;
  private mixed?: EmbeddingIndexFile;
  private hardware?: EmbeddingIndexFile;
  private other?: EmbeddingIndexFile;

  constructor(model: EmbeddingModel, opts: { basic?: EmbeddingIndexFile; asm?: EmbeddingIndexFile; mixed?: EmbeddingIndexFile; hardware?: EmbeddingIndexFile; other?: EmbeddingIndexFile }) {
    this.model = model;
    this.basic = opts.basic;
    this.asm = opts.asm;
    this.mixed = opts.mixed;
    this.hardware = opts.hardware;
    this.other = opts.other;
  }

  updateIndexes(opts: { basic?: EmbeddingIndexFile; asm?: EmbeddingIndexFile; mixed?: EmbeddingIndexFile; hardware?: EmbeddingIndexFile; other?: EmbeddingIndexFile }): void {
    this.basic = opts.basic;
    this.asm = opts.asm;
    this.mixed = opts.mixed;
    this.hardware = opts.hardware;
    this.other = opts.other;
  }

  async retrieve(query: string, topK: number = 3, filterLanguage?: RagLanguage): Promise<RagReference[]> {
    const qv = await this.model.embed(query);
    const candidates: Array<{
      score: number;
      record: EmbeddingRecord;
      snippet: string;
      origin?: string;
      uri?: string;
    }> = [];

    const normalized = filterLanguage;
    const consider = (index?: EmbeddingIndexFile) => {
      if (!index) return;
      for (const rec of index.records) {
        const score = cosineSimilarity(qv, vectorOf(rec));
        const { snippet, origin: provenanceOrigin } = extractSnippetAndOrigin(rec.text);
        const origin = rec.origin ?? provenanceOrigin;
        candidates.push({
          score,
          record: rec,
          snippet,
          origin,
          uri: deriveUri(rec, origin),
        });
      }
    };

    const seen = new Set<EmbeddingIndexFile>();
    const push = (index?: EmbeddingIndexFile) => {
      if (!index || seen.has(index)) return;
      seen.add(index);
      consider(index);
    };

    // Every scope searches every index: the index a document chunk lands in comes from a content
    // heuristic and says nothing about the topic (assembly-spec chunks sit in four indexes), so a
    // scope that read one or two indexes missed the curated documents (KNOWLEDGE-1). The scope
    // instead drops example sources of the other language and ranks its own language first.
    if (normalized === "mixed" || normalized === "hardware" || normalized === "other") {
      push(this[normalized]);
    } else {
      push(this.basic); push(this.asm); push(this.mixed); push(this.hardware); push(this.other);
    }
    if (normalized === "basic" || normalized === "asm") {
      const foreign = normalized === "basic" ? ASM_SOURCE_EXT_RE : BASIC_SOURCE_EXT_RE;
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (foreign.test(candidates[i].record.sourcePath ?? "")) candidates.splice(i, 1);
      }
    }

    applyLexicalBoost(query, candidates);
    if (normalized === "basic" || normalized === "asm") {
      const signal = normalized === "basic" ? BASIC_SIGNAL_RE : ASM_SIGNAL_RE;
      for (const candidate of candidates) {
        if (signal.test(candidate.record.text)) candidate.score += LANGUAGE_SIGNAL_BONUS;
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    
    // Apply duplicate suppression and diversity
    const deduplicated = deduplicateAndDiversify(candidates, topK);
    
    return deduplicated.map((candidate) => ({
      snippet: candidate.snippet,
      origin: candidate.origin,
      uri: candidate.uri,
      score: candidate.score,
      sourcePath: candidate.record.sourcePath,
      sourceUrl: candidate.record.sourceUrl,
      sourceRepoUrl: candidate.record.sourceRepoUrl,
      licenseSpdxId: candidate.record.licenseSpdxId,
      attribution: candidate.record.attribution,
    }));
  }
}

const LEXICAL_WEIGHT = 1.0;
const COSINE_WEIGHT_WITH_LEXICAL = 0.25;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const HEADING_WEIGHT = 0.3;

const STOP_WORDS = new Set([
  "the", "an", "to", "at", "of", "with", "and", "for", "in", "on", "how", "do", "does", "is", "are",
  "from", "up", "my", "me", "can", "what", "use", "using", "set", "get", "per", "it", "into", "by",
]);

// Domain terms that documents spell differently from how developers ask (matched after stemming).
const ALIASES: Record<string, string[]> = {
  irq: ["interrupt"],
  interrupt: ["irq"],
  badline: ["bad line"],
  mux: ["multiplex"],
  joystick: ["joy"],
  rom: ["kernal", "basic"],
};

/** Lower-cases, drops a leading "$" and strips one plural, "-ing", "-er" or "-ed" suffix. */
export function stemToken(token: string): string {
  let t = token.toLowerCase().replace(/^\$/, "");
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 5 && t.endsWith("ers")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("er")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/\$?[a-z0-9_]+/g) ?? []).map(stemToken);
}

interface TermStats { tf: Map<string, number>; length: number }
const statsCache = new WeakMap<object, { body: TermStats; origin: TermStats }>();

function termStats(tokens: string[]): TermStats {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return { tf, length: tokens.length };
}

/**
 * Unfiltered and scoped searches rank documentation chunks, where hashed bag-of-words cosine
 * similarity is dominated by hash collisions. The score is mainly a BM25 term score over the
 * candidates (stemmed terms, rarity weights from the candidate set, saturation and chunk-length
 * normalisation so long tables do not win on repeated words) plus a heading term (the share of
 * query terms found in the chunk's origin, file and heading, weighted HEADING_WEIGHT), blended with
 * the cosine score at a 4:1 ratio.
 */
function applyLexicalBoost(
  query: string,
  candidates: Array<{ score: number; record: EmbeddingRecord; snippet: string; origin?: string }>,
): void {
  const rawTerms = (query.toLowerCase().match(/\$?[a-z0-9_]+/g) ?? [])
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  const groups: string[][] = [];
  const seenGroups = new Set<string>();
  for (const raw of rawTerms.slice(0, 32)) {
    const stem = stemToken(raw);
    if (seenGroups.has(stem)) continue;
    seenGroups.add(stem);
    const alternatives = [stem, ...(ALIASES[raw] ?? ALIASES[stem] ?? []).flatMap(tokenize)];
    groups.push([...new Set(alternatives)]);
  }
  if (groups.length === 0 || candidates.length === 0) return;

  const stats = candidates.map((candidate) => {
    let cached = statsCache.get(candidate.record);
    if (!cached) {
      cached = { body: termStats(tokenize(candidate.snippet)), origin: termStats(tokenize(candidate.origin ?? "")) };
      statsCache.set(candidate.record, cached);
    }
    return cached;
  });
  const frequency = (entry: { body: TermStats; origin: TermStats }, group: string[]): number => {
    let f = 0;
    for (const term of group) f += (entry.body.tf.get(term) ?? 0) + (entry.origin.tf.get(term) ?? 0);
    return f;
  };
  const inHeading = (entry: { body: TermStats; origin: TermStats }, group: string[]): boolean =>
    group.some((term) => entry.origin.tf.has(term));
  const n = candidates.length;
  const averageLength = stats.reduce((sum, entry) => sum + entry.body.length, 0) / n || 1;
  const idf = groups.map((group) => {
    const df = stats.filter((entry) => frequency(entry, group) > 0).length;
    return df === 0 ? 0 : Math.log(1 + n / df);
  });
  const maxScore = idf.reduce((sum, w) => sum + w * (BM25_K1 + 1), 0);
  const maxHeading = idf.reduce((sum, w) => sum + w, 0);
  if (maxScore === 0) return;

  candidates.forEach((candidate, i) => {
    const entry = stats[i];
    const norm = 1 - BM25_B + BM25_B * (entry.body.length / averageLength);
    let bm25 = 0;
    groups.forEach((group, t) => {
      if (idf[t] === 0) return;
      const f = frequency(entry, group);
      if (f > 0) bm25 += idf[t] * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm));
    });
    let heading = 0;
    groups.forEach((group, t) => {
      if (inHeading(entry, group)) heading += idf[t];
    });
    const lexical = (1 - HEADING_WEIGHT) * (bm25 / maxScore) + HEADING_WEIGHT * (heading / maxHeading);
    candidate.score = COSINE_WEIGHT_WITH_LEXICAL * candidate.score + LEXICAL_WEIGHT * lexical;
  });
}

const DUPLICATE_SIMILARITY = 0.85;

function normaliseForComparison(snippet: string): { text: string; words: Set<string> } {
  const text = snippet.toLowerCase().replace(/\s+/g, " ").trim();
  return { text, words: new Set(text.split(" ")) };
}

function wordSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Keeps the best-scoring candidates, skipping near-duplicates. Two snippets are duplicates
 * when their whitespace-normalised full text is equal or their word sets have a Jaccard
 * similarity above DUPLICATE_SIMILARITY. Candidates rejected as duplicates are never added back
 * by the diversity or fill passes.
 */
export function deduplicateAndDiversify<T extends { snippet: string; origin?: string; uri?: string; score: number }>(
  candidates: T[],
  topK: number,
): T[] {
  const normalised = new Map<T, { text: string; words: Set<string> }>();
  const rejected = new Set<T>();
  const results: T[] = [];

  for (const candidate of candidates) {
    if (results.length >= topK) break;
    const current = normaliseForComparison(candidate.snippet);
    normalised.set(candidate, current);
    let isDuplicate = false;
    for (const existing of results) {
      const other = normalised.get(existing)!;
      if (other.text === current.text || wordSimilarity(current.words, other.words) > DUPLICATE_SIMILARITY) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) rejected.add(candidate);
    else results.push(candidate);
  }

  // Fewer than topK unique results: prefer candidates from other origins, then fill,
  // but only with candidates that were not rejected as duplicates and are not
  // duplicates of anything added meanwhile.
  if (results.length < topK) {
    const usedOrigins = new Set(results.map((r) => r.origin || r.uri || "unknown"));
    const remaining = candidates.filter((c) => !results.includes(c) && !rejected.has(c));
    const isDuplicateOfResults = (candidate: T): boolean => {
      const current = normalised.get(candidate) ?? normaliseForComparison(candidate.snippet);
      normalised.set(candidate, current);
      return results.some((existing) => {
        const other = normalised.get(existing)!;
        return other.text === current.text || wordSimilarity(current.words, other.words) > DUPLICATE_SIMILARITY;
      });
    };
    for (const pass of [true, false]) {
      for (const candidate of remaining) {
        if (results.length >= topK) break;
        if (results.includes(candidate)) continue;
        const origin = candidate.origin || candidate.uri || "unknown";
        if (pass && usedOrigins.has(origin)) continue;
        if (isDuplicateOfResults(candidate)) continue;
        results.push(candidate);
        usedOrigins.add(origin);
      }
    }
  }

  return results.slice(0, topK);
}

function extractSnippetAndOrigin(text: string): { snippet: string; origin?: string } {
  const match = PROVENANCE_COMMENT_RE.exec(text);
  if (!match) {
    return { snippet: text.trim() };
  }
  const snippet = text.slice(match[0].length).trim();
  const origin = match[1]?.trim();
  return {
    snippet: snippet.length > 0 ? snippet : text.trim(),
    origin: origin || undefined,
  };
}

function deriveUri(record: EmbeddingRecord, origin?: string): string | undefined {
  // If origin is already a c64:// URI, use it
  if (origin && origin.startsWith("c64://")) {
    return origin;
  }
  
  // Try to map the file path from origin to a resource URI
  if (origin) {
    // Extract the file path (before any '#' anchor)
    const filePath = origin.split("#")[0];
    const resourceUri = PATH_TO_URI_MAP.get(filePath);
    if (resourceUri) {
      // Preserve any anchor/section from the original origin
      const anchor = origin.includes("#") ? "#" + origin.split("#")[1] : "";
      return resourceUri + anchor;
    }
  }
  
  // Try to map the source path from the record
  if (record.sourcePath) {
    const normalizedPath = record.sourcePath.replace(/\\/g, "/");
    const resourceUri = PATH_TO_URI_MAP.get(normalizedPath);
    if (resourceUri) {
      return resourceUri;
    }
  }
  
  // Fallback to source URLs
  if (record.sourceUrl) {
    return record.sourceUrl;
  }
  if (record.sourceRepoUrl) {
    return record.sourceRepoUrl;
  }
  return undefined;
}

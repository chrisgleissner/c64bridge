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

const BASIC_SIGNAL_RE = /(^\s*\d{1,5}\s)|\b(PRINT|POKE|GOTO|GOSUB|RESTORE|READ|DATA|INPUT|CHR\$|TI\$|TAB\()/im;
const ASM_SIGNAL_RE = /(^\s*(?:[A-Z_][\w]*:)?\s*(?:\.?[A-Z]{2,4})\b)|\$[0-9A-F]{2,4}/im;
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

    const consider = (index?: EmbeddingIndexFile) => {
      if (!index) return;
      for (const rec of index.records) {
        const matchesBasic = BASIC_SIGNAL_RE.test(rec.text);
        const matchesAsm = ASM_SIGNAL_RE.test(rec.text);
        if (normalized === "basic" && !matchesBasic) {
          continue;
        }
        if (normalized === "asm" && !matchesAsm) {
          continue;
        }
        let score = cosineSimilarity(qv, new Float32Array(rec.vector));
        if (normalized === "basic" && matchesBasic) {
          score += 0.05;
        } else if (normalized === "asm" && matchesAsm) {
          score += 0.05;
        }
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

    const normalized = filterLanguage;
    const seen = new Set<EmbeddingIndexFile>();
    const push = (index?: EmbeddingIndexFile) => {
      if (!index || seen.has(index)) return;
      seen.add(index);
      consider(index);
    };

    if (!normalized || normalized === "basic") push(this.basic);
    if (!normalized || normalized === "asm") push(this.asm);
    if (!normalized || normalized === "mixed") push(this.mixed);
    if (normalized === "basic" && (!this.basic || this.basic.records.length === 0)) push(this.mixed);
    if (normalized === "asm" && (!this.asm || this.asm.records.length === 0)) push(this.mixed);
    if (!normalized || normalized === "hardware") push(this.hardware);
    if (!normalized || normalized === "other") push(this.other);

    if (!normalized) {
      applyLexicalBoost(query, candidates);
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

/**
 * Unfiltered (docs) searches rank long documentation chunks, where hashed bag-of-words
 * cosine similarity is dominated by hash collisions. Rank mainly by a term-overlap score (weighted 4:1 over cosine): query
 * terms weighted by rarity across the candidates, with extra weight for terms that
 * appear in the chunk's origin (file and heading).
 */
function applyLexicalBoost(
  query: string,
  candidates: Array<{ score: number; record: EmbeddingRecord; snippet: string; origin?: string }>,
): void {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9$_]+/g) ?? []).filter((t) => t.length >= 2))];
  if (terms.length === 0 || candidates.length === 0) return;

  const haystacks = candidates.map((c) => c.snippet.toLowerCase());
  const origins = candidates.map((c) => (c.origin ?? "").toLowerCase());
  const df = terms.map((term) => haystacks.filter((h, i) => h.includes(term) || origins[i].includes(term)).length);
  const weights = df.map((count) => (count === 0 ? 0 : Math.log(1 + candidates.length / count)));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return;

  candidates.forEach((candidate, i) => {
    let matched = 0;
    terms.forEach((term, t) => {
      if (weights[t] === 0) return;
      let occurrences = 0;
      for (let at = haystacks[i].indexOf(term); at >= 0 && occurrences < 2; at = haystacks[i].indexOf(term, at + term.length)) {
        occurrences++;
      }
      const inOrigin = origins[i].includes(term) ? 1 : 0;
      matched += weights[t] * Math.min(1, occurrences / 2 + 0.5 * inOrigin);
    });
    candidate.score = COSINE_WEIGHT_WITH_LEXICAL * candidate.score + LEXICAL_WEIGHT * (matched / totalWeight);
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

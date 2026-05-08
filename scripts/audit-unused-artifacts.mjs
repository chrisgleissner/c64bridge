#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUTPUT_PATH = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : path.join(ROOT, "doc", "audit", "unused-artifacts-report.json");

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "coverage",
]);

const EXCLUDED_FILE_PATTERNS = [
  /^data\/embeddings_.*\.json$/i,
];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".d.ts",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".prompt.md",
  ".sh",
  ".test.mjs",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const ROOT_TEXT_FILES = new Set([
  ".c8rc.json",
  ".codecov.yml",
  ".gitignore",
  ".gitattributes",
  ".mcp.json",
  ".npmignore",
  "AGENTS.md",
  "CLAUDE.md",
  "Dockerfile",
  "LICENSE",
  "PLANS.md",
  "README.md",
  "WORKLOG.md",
  "build",
  "mcp.json",
  "package-lock.json",
  "package.json",
  "server.json",
  "worklog.md",
]);

const PACKAGE_CONTRACT_FILES = new Set([
  "README.md",
  "LICENSE",
  "AGENTS.md",
  "mcp.json",
  "server.json",
  "package.json",
  "package-lock.json",
  "build",
  ".npmignore",
  ".gitignore",
  ".gitattributes",
  ".c8rc.json",
  ".codecov.yml",
]);

function normalise(relPath) {
  return relPath.split(path.sep).join("/");
}

function shouldSkipDir(name) {
  return EXCLUDED_DIRS.has(name);
}

function shouldSkipPath(relPath) {
  return relPath === ".github/agents" || relPath.startsWith(".github/agents/");
}

function isTextFile(relPath, stats) {
  if (!stats.isFile()) return false;
  const base = path.basename(relPath);
  if (ROOT_TEXT_FILES.has(base)) return true;
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".prompt.md")) return true;
  if (lower.endsWith(".d.ts")) return true;
  if (lower.endsWith(".test.mjs")) return true;
  return TEXT_EXTENSIONS.has(path.extname(lower));
}

function walk(dir, relBase = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    if (shouldSkipDir(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = relBase ? normalise(path.join(relBase, entry.name)) : entry.name;
    if (shouldSkipPath(rel)) continue;
    if (entry.isDirectory()) {
      files.push(...walk(abs, rel));
    } else if (entry.isFile()) {
      files.push({ abs, rel, stats: fs.statSync(abs) });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function safeReadText(file) {
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(file.rel))) {
    return null;
  }
  if (file.stats.size > 1024 * 1024) {
    return null;
  }
  try {
    return fs.readFileSync(file.abs, "utf8");
  } catch {
    return null;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripKnownExtensions(relPath) {
  return relPath.replace(/\.(prompt\.md|test\.mjs|d\.ts|mjs|cjs|js|ts|json|yaml|yml|md|txt|csv|sh)$/i, "");
}

function resolveSpecifierTarget(sourceRel, specifier) {
  if (!specifier.startsWith(".")) return null;
  const sourceDir = path.dirname(sourceRel);
  const resolved = normalise(path.normalize(path.join(sourceDir, specifier)));
  return resolved.replace(/^\.\//, "");
}

function buildImportObservations(textFile) {
  const content = safeReadText(textFile);
  if (!content) return [];
  const observations = [];
  const regexes = [
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const specifier = match[1];
      observations.push({
        source: textFile.rel,
        specifier,
        resolved: resolveSpecifierTarget(textFile.rel, specifier),
      });
    }
  }
  return observations;
}

function buildMarkdownLinks(textFile) {
  const content = safeReadText(textFile);
  if (!content) return [];
  const observations = [];
  const regex = /\[[^\]]*]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const target = match[1].trim();
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) continue;
    observations.push({
      source: textFile.rel,
      target,
      resolved: target.startsWith("/")
        ? normalise(target.replace(/^\//, ""))
        : normalise(path.normalize(path.join(path.dirname(textFile.rel), target))),
    });
  }
  return observations;
}

function flattenObjectEntries(value, prefix = "") {
  const entries = [];
  if (typeof value === "string") {
    entries.push({ key: prefix, value });
    return entries;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      entries.push(...flattenObjectEntries(item, `${prefix}[${index}]`));
    });
    return entries;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childKey = prefix ? `${prefix}.${key}` : key;
      entries.push(...flattenObjectEntries(child, childKey));
    }
  }
  return entries;
}

function globToRegex(pattern) {
  const escaped = escapeRegex(pattern)
    .replace(/\\\*\\\*/g, "§§DOUBLESTAR§§")
    .replace(/\\\*/g, "[^/]*")
    .replace(/§§DOUBLESTAR§§/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function fileMatchesPackagePattern(relPath, pattern) {
  const normalized = normalise(pattern.replace(/^\.\//, ""));
  if (!normalized.includes("*")) {
    return relPath === normalized || relPath.startsWith(`${normalized}/`);
  }
  return globToRegex(normalized).test(relPath);
}

function classifyArtifact(file, refs, packageFieldRefs, tsconfigRefs) {
  const isGenerated = file.rel.startsWith("generated/");
  const isDist = file.rel.startsWith("dist/");
  const isDoc = file.rel.endsWith(".md") || file.rel.startsWith("doc/") || file.rel.startsWith("data/context/");
  const isFixture = /(^|\/)(fixtures?|__fixtures__|samples?)\//.test(file.rel);
  const isTestAsset = file.rel.startsWith("test/");
  const isPublicContract =
    PACKAGE_CONTRACT_FILES.has(file.rel) ||
    packageFieldRefs.length > 0 ||
    file.rel.startsWith(".github/") ||
    file.rel.startsWith(".github/prompts/") ||
    file.rel.startsWith("mcp/") ||
    file.rel.startsWith("data/") ||
    file.rel.startsWith("doc/");

  if (isFixture) {
    return {
      candidateClassification: "Test fixture",
      confidence: "high",
      notes: "Fixture/sample path heuristic matched.",
    };
  }

  if (isTestAsset) {
    return {
      candidateClassification: "Live",
      confidence: "medium",
      notes: "Test tree heuristic matched; test runner may discover the file indirectly.",
    };
  }

  if (isGenerated || isDist) {
    if (refs.length > 0 || packageFieldRefs.length > 0 || tsconfigRefs.length > 0) {
      return {
        candidateClassification: "Generated but required",
        confidence: "high",
        notes: "Generated artifact has incoming references and/or package/config inclusion.",
      };
    }
    return {
      candidateClassification: "Generated and removable",
      confidence: "medium",
      notes: "Generated artifact has no detected incoming references; manual review required.",
    };
  }

  if (isPublicContract) {
    return {
      candidateClassification: "Public contract",
      confidence: "high",
      notes: "Package/docs/public-surface heuristics matched.",
    };
  }

  if (refs.length > 0 || tsconfigRefs.length > 0) {
    return {
      candidateClassification: "Live",
      confidence: "high",
      notes: "Incoming references were detected.",
    };
  }

  if (isDoc) {
    return {
      candidateClassification: "Ambiguous",
      confidence: "low",
      notes: "Documentation may have historical value even without incoming references.",
    };
  }

  return {
    candidateClassification: "Dead internal artifact",
    confidence: "medium",
    notes: "No incoming references detected outside heuristics; requires manual confirmation before removal.",
  };
}

const allFiles = walk(ROOT).filter((file) => normalise(file.rel) !== normalise(path.relative(ROOT, OUTPUT_PATH)));
const textFiles = allFiles.filter((file) => isTextFile(file.rel, file.stats));
const importObservations = textFiles.flatMap(buildImportObservations);
const markdownLinks = textFiles.flatMap(buildMarkdownLinks);

const packageJsonPath = path.join(ROOT, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const packageFieldEntries = flattenObjectEntries({
  bin: packageJson.bin,
  files: packageJson.files,
  main: packageJson.main,
  scripts: packageJson.scripts,
  imports: packageJson.imports,
  exports: packageJson.exports,
  prepack: packageJson.prepack,
});

const tsconfigPath = path.join(ROOT, "tsconfig.json");
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
const tsconfigEntries = flattenObjectEntries({
  include: tsconfig.include,
  exclude: tsconfig.exclude,
  references: tsconfig.references,
});

const report = allFiles.map((file) => {
  const relNoExt = stripKnownExtensions(file.rel);
  const basename = path.basename(file.rel);
  const basenameNoExt = stripKnownExtensions(basename);
  const exactPathRegex = new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegex(file.rel)}([^A-Za-z0-9_./-]|$)`);
  const noExtRegex = relNoExt !== file.rel
    ? new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegex(relNoExt)}([^A-Za-z0-9_./-]|$)`)
    : null;
  const basenameRegex = new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegex(basename)}([^A-Za-z0-9_./-]|$)`);
  const basenameNoExtRegex = basenameNoExt && basenameNoExt !== basename
    ? new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegex(basenameNoExt)}([^A-Za-z0-9_./-]|$)`)
    : null;

  const genericRefs = textFiles.flatMap((source) => {
    if (source.rel === file.rel) return [];
    const content = safeReadText(source);
    if (!content) return [];
    const matches = [];
    if (exactPathRegex.test(content)) {
      matches.push({ source: source.rel, referenceType: "exact-path" });
    } else if (basenameRegex.test(content)) {
      matches.push({ source: source.rel, referenceType: "basename" });
    } else if (noExtRegex && noExtRegex.test(content)) {
      matches.push({ source: source.rel, referenceType: "extensionless-path" });
    } else if (basenameNoExtRegex && basenameNoExtRegex.test(content)) {
      matches.push({ source: source.rel, referenceType: "basename-no-ext" });
    }
    return matches;
  });

  const importRefs = importObservations
    .filter((entry) => {
      if (!entry.resolved) return false;
      return (
        entry.resolved === file.rel ||
        stripKnownExtensions(entry.resolved) === stripKnownExtensions(file.rel)
      );
    })
    .map((entry) => ({
      source: entry.source,
      referenceType: "import-specifier",
      detail: entry.specifier,
    }));

  const markdownRefs = markdownLinks
    .filter((entry) => stripKnownExtensions(entry.resolved) === stripKnownExtensions(file.rel))
    .map((entry) => ({
      source: entry.source,
      referenceType: "markdown-link",
      detail: entry.target,
    }));

  const packageRefs = packageFieldEntries
    .filter((entry) => {
      const value = String(entry.value);
      return fileMatchesPackagePattern(file.rel, value) || value.includes(file.rel) || value.includes(relNoExt) || value.includes(basename);
    })
    .map((entry) => ({
      source: "package.json",
      referenceType: "package-field",
      detail: `${entry.key}=${entry.value}`,
    }));

  const tsconfigRefs = tsconfigEntries
    .filter((entry) => {
      const value = String(entry.value);
      return fileMatchesPackagePattern(file.rel, value) || value.includes(file.rel) || value.includes(relNoExt);
    })
    .map((entry) => ({
      source: "tsconfig.json",
      referenceType: "tsconfig-field",
      detail: `${entry.key}=${entry.value}`,
    }));

  const mergedRefs = [...importRefs, ...markdownRefs, ...packageRefs, ...tsconfigRefs, ...genericRefs]
    .filter((ref, index, array) => array.findIndex((item) =>
      item.source === ref.source &&
      item.referenceType === ref.referenceType &&
      (item.detail ?? "") === (ref.detail ?? "")
    ) === index)
    .sort((a, b) => {
      const sourceOrder = a.source.localeCompare(b.source);
      if (sourceOrder !== 0) return sourceOrder;
      return a.referenceType.localeCompare(b.referenceType);
    });

  const classification = classifyArtifact(file, mergedRefs, packageRefs, tsconfigRefs);

  return {
    filePath: file.rel,
    incomingReferenceCount: mergedRefs.length,
    incomingReferenceSources: mergedRefs,
    candidateClassification: classification.candidateClassification,
    confidence: classification.confidence,
    notes: classification.notes,
  };
});

const suspiciousCandidates = report
  .filter((item) => item.candidateClassification === "Dead internal artifact" || item.candidateClassification === "Generated and removable" || item.candidateClassification === "Ambiguous")
  .sort((a, b) => a.incomingReferenceCount - b.incomingReferenceCount || a.filePath.localeCompare(b.filePath));

const output = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  notes: [
    "Heuristic report only; manual review is required before removing anything.",
    "Large files above 1 MiB were excluded as reference sources to avoid noise from generated embeddings and binaries.",
  ],
  artifacts: report,
  suspiciousCandidates,
};

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(`Wrote ${OUTPUT_PATH}`);

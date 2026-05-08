#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_OUTPUT_PATH = path.join(ROOT, "artifacts", "audit", "unused-artifacts-report.generated.json");
const MAX_TEXT_BYTES = 1024 * 1024;

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

const TOKEN_PATTERN = /[A-Za-z0-9_./-]{3,}/g;

const SELF_TEST_CASES = [
  {
    pattern: "generated/**/*.js",
    matches: ["generated/foo.js", "generated/subdir/foo.js"],
    misses: ["generated/foo.ts", "src/generated/foo.js"],
  },
  {
    pattern: "dist/**",
    matches: ["dist/index.js", "dist/rag/discover.config.json"],
    misses: ["src/dist/index.js"],
  },
  {
    pattern: ".github/prompts/**",
    matches: [".github/prompts/steer.prompt.md"],
    misses: [".github/agents/private.md"],
  },
  {
    pattern: "src/**/*.ts",
    matches: ["src/index.ts", "src/rag/discover.ts"],
    misses: ["src/index.js", "dist/index.ts"],
  },
  {
    pattern: "generated/**/*.ts",
    matches: ["generated/c64/index.ts"],
    misses: ["generated/c64/index.js"],
  },
  {
    pattern: "**/*.test.*",
    matches: ["test/config.test.mjs", "src/example.test.ts"],
    misses: ["test/config.mjs"],
  },
];

function normalizePath(relPath) {
  return relPath.split(path.sep).join("/");
}

function shouldSkipPath(relPath) {
  return relPath === ".github/agents" || relPath.startsWith(".github/agents/");
}

function parseArgs(argv) {
  const options = {
    outputPath: DEFAULT_OUTPUT_PATH,
    full: false,
    stdout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--output requires a path");
      }
      options.outputPath = path.resolve(ROOT, value);
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log([
        "Usage: node scripts/audit-unused-artifacts.mjs [--full] [--stdout] [--output <path>]",
        "",
        "Defaults:",
        "  --output artifacts/audit/unused-artifacts-report.generated.json",
        "  writes only suspicious candidates plus summary",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripKnownExtensions(relPath) {
  return relPath.replace(/\.(prompt\.md|test\.mjs|d\.ts|mjs|cjs|js|ts|json|yaml|yml|md|txt|csv|sh)$/i, "");
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

function globToRegex(pattern) {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      const next = pattern[index + 1];
      const afterNext = pattern[index + 2];
      if (next === "*" && afterNext === "/") {
        regex += "(?:[^/]+/)*";
        index += 2;
        continue;
      }
      if (next === "*") {
        regex += ".*";
        index += 1;
        continue;
      }
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(char);
  }
  regex += "$";
  return new RegExp(regex);
}

function fileMatchesPattern(relPath, pattern) {
  const normalizedPattern = normalizePath(pattern.replace(/^!/, "").replace(/^\.\//, ""));
  if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?")) {
    return relPath === normalizedPattern || relPath.startsWith(`${normalizedPattern}/`);
  }
  return globToRegex(normalizedPattern).test(relPath);
}

function runSelfTests() {
  for (const testCase of SELF_TEST_CASES) {
    const regex = globToRegex(testCase.pattern);
    for (const value of testCase.matches) {
      if (!regex.test(value)) {
        throw new Error(`glob self-test failed: ${testCase.pattern} should match ${value}`);
      }
    }
    for (const value of testCase.misses) {
      if (regex.test(value)) {
        throw new Error(`glob self-test failed: ${testCase.pattern} should not match ${value}`);
      }
    }
  }
}

function listTrackedFiles(outputPath) {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((rel) => normalizePath(rel))
    .filter((rel) => !shouldSkipPath(rel));

  const outputRel = normalizePath(path.relative(ROOT, outputPath));

  return tracked
    .filter((rel) => rel !== outputRel)
    .map((rel) => {
      const abs = path.join(ROOT, rel);
      try {
        return { abs, rel, stats: fs.statSync(abs) };
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    })
    .filter(Boolean)
    .filter((file) => file.stats.isFile())
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

function safeReadText(file, cache) {
  if (cache.has(file.rel)) {
    return cache.get(file.rel);
  }
  let content = null;
  if (!EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(file.rel)) && file.stats.size <= MAX_TEXT_BYTES) {
    try {
      content = fs.readFileSync(file.abs, "utf8");
    } catch {
      content = null;
    }
  }
  cache.set(file.rel, content);
  return content;
}

function resolveSpecifierTarget(sourceRel, specifier) {
  if (!specifier.startsWith(".")) return null;
  const sourceDir = path.dirname(sourceRel);
  const resolved = normalizePath(path.normalize(path.join(sourceDir, specifier)));
  return resolved.replace(/^\.\//, "");
}

function buildImportObservations(textFiles, cache) {
  const observations = [];
  const regexes = [
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];

  for (const textFile of textFiles) {
    const content = safeReadText(textFile, cache);
    if (!content) continue;
    for (const regex of regexes) {
      regex.lastIndex = 0;
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
  }

  return observations;
}

function buildMarkdownLinks(textFiles, cache) {
  const observations = [];
  const regex = /\[[^\]]*]\(([^)]+)\)/g;

  for (const textFile of textFiles) {
    const content = safeReadText(textFile, cache);
    if (!content) continue;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const target = match[1].trim();
      if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
        continue;
      }
      observations.push({
        source: textFile.rel,
        target,
        resolved: target.startsWith("/")
          ? normalizePath(target.replace(/^\//, ""))
          : normalizePath(path.normalize(path.join(path.dirname(textFile.rel), target))),
      });
    }
  }

  return observations;
}

function buildTokenIndex(textFiles, cache) {
  const index = new Map();
  for (const file of textFiles) {
    const content = safeReadText(file, cache);
    if (!content) continue;
    const tokens = new Set(content.match(TOKEN_PATTERN) ?? []);
    for (const token of tokens) {
      const entries = index.get(token) ?? [];
      entries.push(file.rel);
      index.set(token, entries);
    }
  }
  return index;
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

function collectTokenRefs(file, tokenIndex) {
  const refs = [];
  const relNoExt = stripKnownExtensions(file.rel);
  const basename = path.basename(file.rel);
  const basenameNoExt = stripKnownExtensions(basename);

  const candidates = [
    { token: file.rel, referenceType: "exact-path" },
    ...(relNoExt !== file.rel ? [{ token: relNoExt, referenceType: "extensionless-path" }] : []),
    { token: basename, referenceType: "basename" },
    ...(basenameNoExt !== basename ? [{ token: basenameNoExt, referenceType: "basename-no-ext" }] : []),
  ];

  for (const candidate of candidates) {
    const sources = tokenIndex.get(candidate.token) ?? [];
    for (const source of sources) {
      if (source === file.rel) continue;
      refs.push({ source, referenceType: candidate.referenceType });
    }
  }

  return refs;
}

function classifyArtifact(file, refs, packageRefs, tsconfigRefs) {
  const isGenerated = file.rel.startsWith("generated/");
  const isDist = file.rel.startsWith("dist/");
  const isDoc = file.rel.endsWith(".md") || file.rel.startsWith("doc/") || file.rel.startsWith("data/context/");
  const isHistoricalDoc = file.rel === "worklog.md" || file.rel.startsWith("doc/plans/");
  const isRepositoryAutomation = file.rel === ".github/dependabot.yml" || file.rel.startsWith(".github/workflows/");
  const isAgentWorkflow = file.rel.startsWith(".github/skills/");
  const isFixture = /(^|\/)(fixtures?|__fixtures__|samples?)\//.test(file.rel);
  const isTestAsset = file.rel.startsWith("test/");
  const hasRuntimeRefs = refs.some((ref) => ref.referenceType !== "package-field" && ref.referenceType !== "tsconfig-field");
  const hasPackageInclusion = packageRefs.length > 0;
  const hasBuildInclusion = tsconfigRefs.length > 0;

  if (isFixture) {
    return {
      candidateClassification: "Test fixture",
      confidence: "high",
      notes: "Fixture or sample path heuristic matched.",
    };
  }

  if (isTestAsset) {
    return {
      candidateClassification: "Live",
      confidence: "medium",
      notes: "Tracked test-tree artifact; test discovery may be indirect.",
    };
  }

  if (isGenerated || isDist) {
    if (hasRuntimeRefs || hasPackageInclusion || hasBuildInclusion) {
      return {
        candidateClassification: "Generated but required",
        confidence: "high",
        notes: "Generated artifact has runtime, package, or build inclusion evidence.",
      };
    }
    return {
      candidateClassification: "Generated and removable",
      confidence: "medium",
      notes: "Generated artifact has no detected runtime, package, or build inclusion.",
    };
  }

  if (isRepositoryAutomation) {
    return {
      candidateClassification: "Repository automation",
      confidence: "high",
      notes: "GitHub workflow or automation config retained for CI and release operations.",
    };
  }

  if (isAgentWorkflow) {
    return {
      candidateClassification: "Repository agent workflow",
      confidence: "medium",
      notes: "Agent skill retained as repository workflow knowledge, even without import-style references.",
    };
  }

  if (PACKAGE_CONTRACT_FILES.has(file.rel) || hasRuntimeRefs || hasBuildInclusion) {
    return {
      candidateClassification: "Live",
      confidence: hasRuntimeRefs || hasBuildInclusion ? "high" : "medium",
      notes: hasRuntimeRefs || hasBuildInclusion
        ? "Runtime or build references were detected."
        : "Tracked package-contract file retained by repository convention.",
    };
  }

  if (isHistoricalDoc) {
    return {
      candidateClassification: "Historical documentation",
      confidence: "medium",
      notes: "Historical plan/worklog artifact; review before deletion.",
    };
  }

  if (file.rel.startsWith("mcp/") || file.rel.startsWith(".github/prompts/") || file.rel === "mcp.json" || file.rel === "server.json") {
    return {
      candidateClassification: hasPackageInclusion ? "Packaged interface artifact" : "Ambiguous",
      confidence: hasPackageInclusion ? "medium" : "low",
      notes: hasPackageInclusion
        ? "Packaged MCP interface or prompt artifact; not assumed runtime-live without further evidence."
        : "MCP-facing artifact without direct runtime evidence; manual review required.",
    };
  }

  if (file.rel.startsWith("data/")) {
    return {
      candidateClassification: hasPackageInclusion ? "Packaged data artifact" : "Ambiguous",
      confidence: hasPackageInclusion ? "medium" : "low",
      notes: hasPackageInclusion
        ? "Packaged data artifact; may be runtime, RAG, or documentation input."
        : "Data artifact without direct runtime evidence; manual review required.",
    };
  }

  if (isDoc) {
    return {
      candidateClassification: hasPackageInclusion ? "Packaged documentation" : "Ambiguous",
      confidence: hasPackageInclusion ? "medium" : "low",
      notes: hasPackageInclusion
        ? "Packaged documentation or historical record; not assumed runtime-live."
        : "Documentation may be historical or stale; manual review required.",
    };
  }

  if (hasPackageInclusion) {
    return {
      candidateClassification: "Packaged artifact",
      confidence: "medium",
      notes: "Artifact is included in the published package but lacks direct runtime references.",
    };
  }

  return {
    candidateClassification: "Dead internal artifact",
    confidence: "medium",
    notes: "No runtime, package, or build references were detected; confirm manually before deletion.",
  };
}

function uniqueRefs(refs) {
  return refs
    .filter((ref, index, array) => array.findIndex((item) =>
      item.source === ref.source
      && item.referenceType === ref.referenceType
      && (item.detail ?? "") === (ref.detail ?? "")
    ) === index)
    .sort((a, b) => {
      const sourceOrder = a.source.localeCompare(b.source);
      if (sourceOrder !== 0) return sourceOrder;
      return a.referenceType.localeCompare(b.referenceType);
    });
}

function buildReport(options) {
  runSelfTests();

  const allFiles = listTrackedFiles(options.outputPath);
  const textFiles = allFiles.filter((file) => isTextFile(file.rel, file.stats));
  const textCache = new Map();
  const tokenIndex = buildTokenIndex(textFiles, textCache);
  const importObservations = buildImportObservations(textFiles, textCache);
  const markdownLinks = buildMarkdownLinks(textFiles, textCache);

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const packageFieldEntries = flattenObjectEntries({
    bin: packageJson.bin,
    files: packageJson.files,
    main: packageJson.main,
    scripts: packageJson.scripts,
    imports: packageJson.imports,
    exports: packageJson.exports,
    prepack: packageJson.prepack,
  });

  const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"));
  const tsconfigEntries = flattenObjectEntries({
    include: tsconfig.include,
    exclude: tsconfig.exclude,
    references: tsconfig.references,
  });

  const artifacts = allFiles.map((file) => {
    const relNoExt = stripKnownExtensions(file.rel);
    const basename = path.basename(file.rel);

    const importRefs = importObservations
      .filter((entry) => entry.resolved && stripKnownExtensions(entry.resolved) === stripKnownExtensions(file.rel))
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

    const tokenRefs = collectTokenRefs(file, tokenIndex);

    const packageRefs = packageFieldEntries
      .filter((entry) => {
        const value = String(entry.value);
        return fileMatchesPattern(file.rel, value)
          || value.includes(file.rel)
          || value.includes(relNoExt)
          || value.includes(basename);
      })
      .map((entry) => ({
        source: "package.json",
        referenceType: "package-field",
        detail: `${entry.key}=${entry.value}`,
      }));

    const tsconfigRefs = tsconfigEntries
      .filter((entry) => {
        const value = String(entry.value);
        return fileMatchesPattern(file.rel, value)
          || value.includes(file.rel)
          || value.includes(relNoExt);
      })
      .map((entry) => ({
        source: "tsconfig.json",
        referenceType: "tsconfig-field",
        detail: `${entry.key}=${entry.value}`,
      }));

    const incomingReferenceSources = uniqueRefs([
      ...importRefs,
      ...markdownRefs,
      ...packageRefs,
      ...tsconfigRefs,
      ...tokenRefs,
    ]);

    const classification = classifyArtifact(file, incomingReferenceSources, packageRefs, tsconfigRefs);

    return {
      filePath: file.rel,
      sizeBytes: file.stats.size,
      incomingReferenceCount: incomingReferenceSources.length,
      incomingReferenceSources,
      packageReferenceCount: packageRefs.length,
      tsconfigReferenceCount: tsconfigRefs.length,
      candidateClassification: classification.candidateClassification,
      confidence: classification.confidence,
      notes: classification.notes,
    };
  });

  const suspiciousCandidates = artifacts
    .filter((item) => [
      "Dead internal artifact",
      "Generated and removable",
      "Ambiguous",
      "Historical documentation",
      "Packaged documentation",
      "Packaged data artifact",
      "Packaged artifact",
      "Packaged interface artifact",
    ].includes(item.candidateClassification))
    .sort((a, b) => a.candidateClassification.localeCompare(b.candidateClassification) || a.filePath.localeCompare(b.filePath));

  const classifications = {};
  for (const artifact of artifacts) {
    classifications[artifact.candidateClassification] = (classifications[artifact.candidateClassification] ?? 0) + 1;
  }

  const output = {
    notes: [
      "Heuristic report only; manual review is required before removing anything.",
      "Only git-tracked files are scanned.",
      "Large files above 1 MiB and embedding JSON files are excluded as text-reference sources to avoid noisy false positives.",
      "The default output path is generated and intended to stay uncommitted.",
    ],
    selfTests: SELF_TEST_CASES.map(({ pattern, matches, misses }) => ({
      pattern,
      matches,
      misses,
      status: "passed",
    })),
    summary: {
      trackedFileCount: allFiles.length,
      textFileCount: textFiles.length,
      suspiciousCandidateCount: suspiciousCandidates.length,
      classifications,
    },
    suspiciousCandidates,
  };

  if (options.full) {
    output.artifacts = artifacts;
  }

  return output;
}

const options = parseArgs(process.argv.slice(2));
const output = buildReport(options);
const serialized = `${JSON.stringify(output, null, 2)}\n`;

if (options.stdout) {
  process.stdout.write(serialized);
} else {
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, serialized);
  console.log(`Wrote ${normalizePath(path.relative(ROOT, options.outputPath))}`);
}

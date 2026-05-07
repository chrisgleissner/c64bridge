// Meta module: aggregates all meta tools and marks them as experimental
import { defineToolModule } from "../types.js";
import { tools as diagnosticsTools } from "./diagnostics.js";
import { tools as screenTools } from "./screen.js";
import { tools as memoryTools } from "./memory.js";
import { tools as backgroundTools } from "./background.js";
import { tools as filesystemTools } from "./filesystem.js";
import { tools as configTools } from "./config.js";
import { tools as programTools } from "./program.js";
import { tools as artifactsTools } from "./artifacts.js";
import { tools as compilationTools } from "./compilation.js";
import { tools as audioTools } from "./audio.js";
import { tools as graphicsTools } from "./graphics.js";

// Aggregate all tools from submodules
const allTools = [
  ...diagnosticsTools,
  ...screenTools,
  ...memoryTools,
  ...backgroundTools,
  ...filesystemTools,
  ...configTools,
  ...programTools,
  ...artifactsTools,
  ...compilationTools,
  ...audioTools,
  ...graphicsTools,
];

export const metaModule = defineToolModule({
  domain: "meta",
  summary: "High-level meta tools that orchestrate multiple MCP actions.",
  resources: ["c64://guide/bootstrap", "c64://assembly/6510-spec"],
  defaultTags: ["meta", "orchestration", "experimental"],
  supportedPlatforms: ["c64u", "vice"] as const,
  workflowHints: [
    "Use meta tools to reduce round-trips by composing several steps into one.",
  ],
  tools: allTools,
});

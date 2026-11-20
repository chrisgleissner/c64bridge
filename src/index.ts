#!/usr/bin/env node
/**
 * MCP server entry point used by the CLI launcher and npm package main field.
 * This thin wrapper delegates to the real implementation in mcp-server.ts.
 */
import "./bootstrap/stdio-logger.js";
import * as nodeModule from "node:module";

// Node's on-disk compile cache (22.1+) shortens later starts; NODE_DISABLE_COMPILE_CACHE=1 turns
// it off. Enabled before the server modules load so they are cached too. Bun has no such API.
try {
  (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch {
  // A cache directory that cannot be created must not stop the server.
}

await import("./mcp-server.js");

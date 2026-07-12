# Developer Guide

Focused reference for maintainers and contributors. User-facing setup lives in [README.md](../README.md); persona guidance lives in [AGENTS.md](../AGENTS.md).

## 1. Environment

- **Node.js** ≥ 24 (enforced via [`package.json`](../package.json))
- **Bun** ≥ 1.3 optional but recommended for faster dev loops (repo `packageManager`)
- **Optional**: [`naudiodon`](https://www.npmjs.com/package/naudiodon) when working on SID audio capture

Install once:

```bash
./build install      # install via the project build helper
# or directly:
npm install          # reliable everywhere
bun install          # faster workflow (respects package-lock)
```

## 2. Core Workflows

Most day-to-day tasks are run through the [`./build`](../build) helper at the project root. It wraps every `npm run` script behind a consistent, self-documented interface.

```bash
./build --help       # full command reference
```

| Task | Command |
| --- | --- |
| Launch MCP server (TS-aware) | `npm start` |
| Run TypeScript entry directly | `npm run mcp` (Bun) · `npm run mcp:node` (dist only) |
| Build + refresh generated docs | `./build build` |
| Tests (mock backend) | `./build test` |
| Tests against hardware | `./build test --real [--base-url http://host]` |
| Full test matrix | `./build test:matrix` |
| Coverage report | `./build coverage` (merged matrix LCOV in `coverage/lcov.info`) |
| End-to-end smoke (local/npm) | `./build check:run-local` · `./build check:run-npm` |
| Node-only sanity | `./build check:node-compat` |
| VICE smoke (readiness + HELLO) | `./build vice:smoke` |

`scripts/invoke-bun.mjs` automatically delegates npm scripts to Bun when available; stay on the npm variants if Bun is not installed.

### Test Matrix

| Platform | Target | Command | Environment |
| --- | --- | --- | --- |
| c64u | mock | `./build test --platform c64u --target mock` | `C64_MODE=c64u C64_TEST_TARGET=mock` |
| c64u | device | `./build test --platform c64u --target device --base-url http://c64u` | `C64_MODE=c64u C64_TEST_TARGET=real C64_TEST_BASE_URL=http://c64u` |
| vice | mock | `./build test --platform vice --target mock` | `C64_MODE=vice VICE_TEST_TARGET=mock` |
| vice | device | `./build test --platform vice --target device` | `C64_MODE=vice VICE_TEST_TARGET=vice` |
| mixed | aggregate (no real c64u) | `./build test:matrix` | see individual rows |

The runner still accepts legacy flags (`--mock`, `--real`) for c64u workflows, but the explicit matrix keeps cross-platform runs symmetrical.

`./build coverage` executes the same three matrix legs, then merges the resulting LCOV reports while filtering to the same source scope configured in `.c8rc.json`. Use `./build coverage:single --platform <p> --target <t>` for a one-leg Bun report when debugging a local coverage regression.

> **Note**: Only suites that explicitly opt-in touch real hardware. Today that is `test/device.test.mjs` (real VICE via `target=device`) and the "C64Client against real C64" block in `test/c64Client.test.mjs` when `C64_TEST_TARGET=real`; all other tests continue to run against mocks even under a hardware matrix leg.

Subsequent `./build build` invocations reuse the incremental cache stored in `dist/.tsbuildinfo`; delete that file (or `dist/`) for a fully clean rebuild when needed.

## 3. Repository Layout (Essentials)

| Path | Notes |
| --- | --- |
| [`src/index.ts`](../src/index.ts) | Runtime entrypoint (loaded by [`scripts/start.mjs`](../scripts/start.mjs)) |
| [`src/mcp-server.ts`](../src/mcp-server.ts) | Server wiring using [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| [`src/tools/`](../src/tools/) | Tool implementations; registries under [`src/tools/registry/`](../src/tools/registry/) |
| [`src/prompts/`](../src/prompts/) | Prompt templates mirroring personas in [AGENTS.md](../AGENTS.md) |
| [`src/rag/`](../src/rag/) & [`data/`](../data/) | RAG builder, indices, and corpora |
| [`scripts/`](../scripts/) | Automation (launchers, tests, RAG, release, README refresh) |
| [`test/`](../test/) | Bun test harness, mock Ultimate server, suites |
| [`generated/`](../generated/) | REST client from [`doc/c64u/c64-openapi.yaml`](c64u/c64-openapi.yaml) |
| [`doc/`](../doc/) | Project documentation (setup, troubleshooting, REST references) |

## 4. Extending the Server

- **Tools**: Implement under `src/tools/<domain>/`, export from [`src/tools/registry/index.ts`](../src/tools/registry/index.ts). Share helpers via [`src/tools/registry/utils.ts`](../src/tools/registry/utils.ts). Add coverage in [`test/`](../test/).
- **Prompts**: Author in [`src/prompts/`](../src/prompts/), register via [`src/prompts/registry.ts`](../src/prompts/registry.ts), mirror description updates in [AGENTS.md](../AGENTS.md) and `.github/prompts/`.
- **REST surface**: Keep [`doc/c64u/c64-openapi.yaml`](c64u/c64-openapi.yaml) current. Regenerate the typed client with `./build api:generate` when endpoints change.
- **Docs**: `./build build` calls [`scripts/update-readme.ts`](../scripts/update-readme.ts); never hand-edit the `<!-- AUTO-GENERATED:MCP-DOCS-* -->` block in the README.

## 5. Configuration & Backends

Resolution order: `C64BRIDGE_CONFIG` → `./.c64bridge.json` → `~/.c64bridge.json` → defaults (`host=c64u`, `port=80`). Supports hardware (`c64u`) and phase-one VICE. For secured Ultimate firmware, set `c64u.networkPassword` in the config file to send `X-Password` on every REST request.

The authoritative VICE contract lives in [doc/vice/support-matrix.md](vice/support-matrix.md). Treat that file plus the generated README compatibility tables as release-blocking artifacts: if runtime, tests, and docs disagree, the contract is broken.

Key env flags:

- `C64_MODE=c64u|vice` — force backend
- `LOG_LEVEL=debug` — verbose logging (stderr)
- `C64BRIDGE_DIAGNOSTICS_DIR=/path` — persistent NDJSON crash and request diagnostics (default: `~/.c64bridge/diagnostics`)
- `C64BRIDGE_DISABLE_DIAGNOSTICS=1` — disable persistent diagnostics if they interfere with a constrained environment
- `C64_TEST_TARGET` / `C64_TEST_BASE_URL` — influence test harness
- `VICE_TEST_TARGET=mock|vice` — test selection for VICE (default: auto-detect real VICE; set `mock` to run against the BM stub during tests)

Managed VICE launch is currently Linux/X11-oriented. The launcher and smoke workflow assume Unix facilities such as `Xvfb`, `/tmp/.X11-unix`, and `/dev/null`; on other hosts, connect to an already running Binary Monitor endpoint or use the mock backend instead of assuming supervised startup will work.

For MCP stability work, always check the latest file under `~/.c64bridge/diagnostics/` before assuming a VS Code or Copilot crash came from repository logic. The file captures MCP request flow plus VICE/Xvfb stderr tails, which is usually enough to separate a repo fault from an editor or extension-host crash.

Public VICE support excludes mock-only behaviors. If a capability only works in the BM stub or an internal backend experiment, keep it out of grouped tool support tables until it is explicitly promoted in [doc/vice/support-matrix.md](vice/support-matrix.md).

## 6. RAG Maintenance

- Indices live under [`data/embeddings_*.json`](../data/)
- Rebuild: `./build rag:rebuild`
- Fetch external sources: `./build rag:fetch` (writes to [`external/`](../external/))
- Discover sources (experimental): `./build rag:discover` with `GITHUB_TOKEN`

Environment knobs: `RAG_EMBEDDINGS_DIR`, `RAG_BUILD_ON_START`, `RAG_REINDEX_INTERVAL_MS`, `RAG_DOC_FILES`.

## 7. Optional Services

- **HTTP bridge**: Disabled by default; enable with `npm start -- --http [port]` for manual curl experiments (the MCP server start is not managed by `./build`). Details in [`doc/troubleshooting-mcp.md`](troubleshooting-mcp.md).
- **Docker image**: [`Dockerfile`](../Dockerfile) builds Ubuntu 24.04 + Node 24 + Bun for reproducible environments.
- **Audio pipeline**: SID analysis uses [`naudiodon`](https://www.npmjs.com/package/naudiodon); see [`src/audio/`](../src/audio/) and tests like [`test/audioAnalysis.test.mjs`](../test/audioAnalysis.test.mjs).

## 8. Release & Packaging

- `./build check` — build + test matrix in one pass
- `./build changelog` — update CHANGELOG draft
- `./build release --version <version>` — bump version, refresh [`mcp.json`](../mcp.json) and [`server.json`](../server.json), prepend changelog notes
- Published package ships [`dist/`](../dist/), [`doc/`](../doc/), [`data/`](../data/), [`scripts/`](../scripts/), [`generated/`](../generated/), [`mcp.json`](../mcp.json), and [`server.json`](../server.json)

Tagging a release through the GitHub release UI triggers [`.github/workflows/release.yaml`](../.github/workflows/release.yaml), which publishes the npm package and then publishes the same version to the MCP Registry.

- npm publication now uses trusted publishing over GitHub OIDC rather than an `NPM_TOKEN` secret
- One-time npm setup is required in the package settings for `c64bridge`: provider `GitHub Actions`, repository `chrisgleissner/c64bridge`, workflow `.github/workflows/release.yaml`, and allowed action `npm publish`
- No dedicated MCP Registry secret is required for the GitHub-driven flow; the workflow uses `mcp-publisher login github-oidc`
- The release workflow must grant `id-token: write` so GitHub Actions can mint the short-lived OIDC tokens used by both npm trusted publishing and `mcp-publisher`
- Keep [`package.json`](../package.json) `mcpName` aligned with [`server.json`](../server.json) `name`
- The root [`server.json`](../server.json) is the MCP Registry manifest; [`mcp/server.json`](../mcp/server.json) remains generated MCP interface output

## 9. Troubleshooting Cheatsheet

- Missing entrypoint? Ensure dev deps are installed or run `./build build` so [`dist/index.js`](../dist/index.js) exists.
- Tool not exposed? Confirm registry wiring (`src/tools/registry/index.ts`) and rebuild.
- Real-device tests flaky? Verify `C64_TEST_BASE_URL` reachability; replay curl probes while the HTTP bridge is active.
- Empty RAG answers? Rebuild embeddings (`./build rag:rebuild`) and confirm `RAG_EMBEDDINGS_DIR` points at committed data.
- Logs quiet? Remember all server logs emit to stderr to keep stdout dedicated to MCP.

Stay in lockstep with the [README](../README.md) and [`AGENTS.md`](../AGENTS.md) when introducing features so external docs remain accurate.

### VICE smoke test (Binary Monitor)

Quick sanity that VICE is reachable and BASIC readiness + simple run works end‑to‑end.

```bash
./build vice:smoke
```

Env knobs:

- `VICE_BINARY=/path/to/x64sc` — pick emulator binary on Unix-like hosts
- `VICE_VISIBLE=1` — show the VICE window (recommended during dev)
- `VICE_WARP=0` — disable warp so you can observe visible output
- `VICE_KEEP_OPEN=1` — keep window open after success
  (The smoke test registers exit/signal handlers and tears down spawned processes; with `VICE_KEEP_OPEN=1` only your visible VICE is left running.)
- `VICE_TEST_TARGET=mock` — run the smoke test against the BM stub instead of launching VICE (useful on CI or platforms without VICE installed)
- `FORCE_XVFB=1` — run headless via Xvfb even if a display is detected (default on CI)
- `DISABLE_XVFB=1` — skip Xvfb and use the current `$DISPLAY` even in headless environments
- `VICE_XVFB_DISPLAY=:nn` — override the Xvfb display number (defaults to `:99`)

Implementation tip: programmatic shutdown

- The internal `ViceClient` supports a graceful emulator quit via the Binary Monitor `0xBB Quit` command (`await client.quit()`), and a monitor exit (`0xAA`) if needed. Prefer this over sending signals when integrating VICE control into production code; retain a short SIGTERM fallback.

What it does:

- Launches VICE with the Binary Monitor, waits for the port (≤4s), connects.
- Resets the machine and waits until BASIC pointers are initialised at $0801 and READY. is visible.
- Injects a small BASIC program (`PRINT "HELLO"`), RUNs it, and polls the screen for HELLO.

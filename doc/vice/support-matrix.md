# VICE support matrix

The [generated tool tables](../../README.md#tools) show operation-level compatibility. A checkmark in the VICE column means the operation is exposed by the public VICE backend. Calls to operations outside that compatibility list return `unsupported_platform`.

VICE uses its Binary Monitor and emulator resources for program execution, memory and screen access, input, debugging, snapshots, and supported drive operations. Ultimate REST features such as firmware file searches, flash configuration, streaming, and printing require an Ultimate backend. See the individual operation rows for differences within a tool.

The runtime registry in [`src/tools/registry/`](../../src/tools/registry/) supplies the platform metadata for the generated tables and [static MCP interface](../../mcp/). Builds regenerate both, and the package check in CI verifies they are current. Mock-only experiments can be exercised in tests before they become part of the public VICE contract.

[VICE setup](../../README.md#vice-setup) · [Binary Monitor reference](../../data/vice/vice-binary-monitor-spec.md)

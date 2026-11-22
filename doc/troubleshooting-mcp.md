# MCP troubleshooting

## The client cannot see the tools

- Check that the client has enabled the C64 Bridge server and can find Node.js 24+ and `npx` on its PATH. A desktop app can have a different PATH from your terminal.
- For stdio, let the client launch the server. A separate terminal launch waits for input on that terminal's stdin. Server logs go to stderr.
- In VS Code with Copilot, check the `c64bridge` entry in `.vscode/mcp.json` and open its output. The Claude Code plugin uses Claude Code's `.mcp.json` or CLI registration. [Client setup](../README.md#quick-start)

## The tools are visible but the target does not respond

Read `c64://platform/status` for the active backend, configured backends, and native endpoint availability. Set `C64_MODE` in the MCP client to pin the initial target. A manually configured hardware profile can remain selected while the device is offline. [Backend configuration](../README.md#configuration)

For an Ultimate device, try the firmware REST endpoint from the machine running C64 Bridge. Replace the example IP address with your device's address.

```bash
curl -i --connect-timeout 3 http://192.168.1.99/v1/info
```

With network protection enabled, supply the same `X-Password` header the bridge uses. A 401 or 403 indicates that the endpoint is reachable and rejected the request. Check the matching hardware profile's password, including any client environment overrides. In the bridge logs, `Connectivity check succeeded` confirms a successful REST probe.

For VICE, check the configured Binary Monitor address and port. With a managed launch, verify that `x64sc` or `x64` can start and locate its C64 ROMs. Use `VICE_BINARY` and `VICE_DIRECTORY` for a custom install. If another debugger or bridge is attached to the Binary Monitor, disconnect it before retrying. [VICE setup](../README.md#vice-setup)

## Find diagnostics

The server writes newline-delimited JSON diagnostics under `~/.c64bridge/diagnostics/` by default. The files record MCP startup, tool and resource requests, unexpected errors, and output tails from failed VICE or Xvfb launches. If the client crashes, inspect the newest file and compare timestamps with the client's MCP output.

- `C64BRIDGE_DIAGNOSTICS_DIR` sets a different diagnostics directory.
- `C64BRIDGE_DIAGNOSTICS_KEEP` sets the retention count. Startup also removes files older than 30 days.
- `C64BRIDGE_DISABLE_DIAGNOSTICS=1` disables persistent diagnostics.
- `LOG_LEVEL=debug` increases log verbosity.

## Check a source checkout

Run `./build --skip-tests` to install and compile, then `./build test` to run against the mock backend. For transport debugging, the optional local HTTP listener accepts MCP JSON-RPC POSTs to `/mcp`. [HTTP invocation](../README.md#http-invocation) · [Developer guide](developer.md)

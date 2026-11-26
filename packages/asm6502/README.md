# c64-asm6502

A 6502 assembler for Commodore 64 programs, written in TypeScript. It is the assembler that the [`sidwave`](https://github.com/chrisgleissner/sidwave) compiler uses to build its music player, and it is also used by [c64bridge](https://github.com/chrisgleissner/c64bridge) to assemble programs for VICE and Ultimate devices.

Status: pre-release; not yet published to npm. The package was moved out of c64bridge unchanged in behaviour, and the API is not final, so the exports are not documented here yet. See the exports in `package.json` and the sources.

```sh
npm install c64-asm6502
```

It has no dependency on a device, an MCP server or the network.

License: GPL-2.0-only.

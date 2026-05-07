# VICE Binary Monitor Specification

## Purpose

This document is a concise implementation reference for C64 Bridge maintainers and LLM agents that need to understand how the VICE backend maps to the VICE binary monitor protocol.

For normal MCP use, agents should call the existing C64 Bridge tools instead of constructing VICE packets directly.

Recommended C64 Bridge entry points:

| Need | C64 Bridge tool | Typical operation |
|---|---|---|
| Select the VICE backend | `c64_select_backend` | `select` |
| Read or write memory | `c64_memory` | `read`, `write`, `read_screen`, `wait_for_text` |
| Debug registers and checkpoints | `c64_debug` | `get_registers`, `set_registers`, `create_checkpoint`, `list_checkpoints`, `step`, `step_return` |
| Send keyboard or joystick input | `c64_input` | `write_text`, `key`, `joystick` |
| Capture emulator display | `c64_graphics` | `capture_frame` |
| Reset or resume execution | `c64_system` | `reset`, `resume` |
| Read or write VICE resources | `c64_vice` | `resource_get`, `resource_set` |

---

## Core Protocol Rules

- The VICE binary monitor uses a dedicated connection configured with `-binarymonitor` and `-binarymonitoraddress`.
- Every packet starts with `STX = 0x02`.
- There is no packet terminator.
- Packet boundaries are determined by the length field in the frame header.
- Current API version: `0x02`.
- All multibyte integers are little-endian.
- Boolean fields use `0x00 = false`, `>= 0x01 = true`.
- Direct responses echo the command `request_id`.
- Responses with `request_id = 0xffffffff` are asynchronous events.
- Commands may cause asynchronous monitor-entry events before the direct command response.
- Register IDs and bank IDs are machine-dependent. Do not hard-code them.
- Use `REGISTERS_AVAILABLE` and `BANKS_AVAILABLE` to resolve IDs.
- Many array items include an item-size field. Use it to skip future extensions.

---

## Notation

| Notation | Meaning |
|---|---|
| `u8` | 1 byte unsigned |
| `u16` | 2 byte unsigned, little-endian |
| `u32` | 4 byte unsigned, little-endian |
| `u64` | 8 byte unsigned, little-endian |
| `bytes[N]` | exactly `N` bytes |
| `str[N]` | `N` bytes, not null-terminated unless stated otherwise |
| `FIELD?` | optional field |
| `ITEM[N]` | `N` repeated items |

---

## Common Values

### Memspace

| Value | Meaning |
|---:|---|
| `0x00` | Main machine memory |
| `0x01` | Drive 8 |
| `0x02` | Drive 9 |
| `0x03` | Drive 10 |
| `0x04` | Drive 11 |

### Generic Errors

| Code | Meaning |
|---:|---|
| `0x00` | OK |
| `0x01` | Object does not exist |
| `0x02` | Invalid memspace |
| `0x80` | Incorrect command length |
| `0x81` | Invalid parameter value |
| `0x82` | Unsupported API version |
| `0x83` | Unknown command type |
| `0x8f` | General failure after basic validation |

Always check the response error code before decoding the body.

---

## Command Frame

```text
Offset  Size  Field
0       1     STX = 0x02
1       1     API version = 0x02
2       4     Command body length as u32
6       4     Request ID as u32
10      1     Command type as u8
11      N     Command body
````

```text
command_body_length = total_command_packet_length - 11
```

The command length excludes the whole command header.

---

## Response Frame

```text
Offset  Size  Field
0       1     STX = 0x02
1       1     API version = 0x02
2       4     Response body length as u32
6       1     Response type as u8
7       1     Error code as u8
8       4     Request ID as u32
12      N     Response body
```

```text
response_body_length = total_response_packet_length - 12
```

For asynchronous events:

```text
request_id = 0xffffffff
```

---

## Forward-Compatible Arrays

Common array pattern:

```text
COUNT | ITEM[COUNT]
```

Common item pattern:

```text
IS:u8 | ITEM_BODY[IS]
```

`IS` is the item body size and excludes the `IS` byte itself. Use `IS` to skip unknown future fields.

---

# Commands

## `0x01` - Memory Get

Reads memory from inclusive range `[SA..EA]`.

```text
cmd: FX:u8 | SA:u16 | EA:u16 | MS:u8 | BI:u16
rsp: 0x01 | ML:u16 | MM:bytes[ML]
```

| Field | Meaning                  |
| ----- | ------------------------ |
| `FX`  | Read causes side effects |
| `SA`  | Start address            |
| `EA`  | End address, inclusive   |
| `MS`  | Memspace                 |
| `BI`  | Bank ID                  |
| `ML`  | Memory length            |
| `MM`  | Memory bytes             |

For `$0000..$ffff`, `ML` may be `0`, meaning 65536 bytes.

C64 Bridge mapping:

| MCP tool     | Operation       |
| ------------ | --------------- |
| `c64_memory` | `read`          |
| `c64_memory` | `read_screen`   |
| `c64_memory` | `wait_for_text` |

---

## `0x02` - Memory Set

Writes memory to inclusive range `[SA..EA]`.

```text
cmd: FX:u8 | SA:u16 | EA:u16 | MS:u8 | BI:u16 | MM:bytes[EA-SA+1]
rsp: 0x02 | empty
```

C64 Bridge mapping:

| MCP tool     | Operation |
| ------------ | --------- |
| `c64_memory` | `write`   |

---

## `0x11` - Checkpoint Get

Gets a breakpoint, watchpoint, or tracepoint by checkpoint number.

```text
cmd: CN:u32
rsp: 0x11 | CHECKPOINT_INFO
```

C64 Bridge mapping:

| MCP tool    | Operation        |
| ----------- | ---------------- |
| `c64_debug` | `get_checkpoint` |

---

## `0x12` - Checkpoint Set

Creates a breakpoint, watchpoint, or tracepoint.

```text
cmd: SA:u16 | EA:u16 | ST:u8 | EN:u8 | OP:u8 | TM:u8 | MS?:u8
rsp: 0x11 | CHECKPOINT_INFO
```

| Field | Meaning                           |
| ----- | --------------------------------- |
| `ST`  | Stop when hit                     |
| `EN`  | Enabled                           |
| `OP`  | Operation bitmask                 |
| `TM`  | Temporary, delete after first hit |
| `MS`  | Optional memspace                 |

`OP`: `0x01 = load`, `0x02 = store`, `0x04 = exec`.

Use `0x22 CONDITION_SET` after creation to add a condition.

C64 Bridge mapping:

| MCP tool    | Operation           |
| ----------- | ------------------- |
| `c64_debug` | `create_checkpoint` |

---

## `0x13` - Checkpoint Delete

```text
cmd: CN:u32
rsp: 0x13 | empty
```

C64 Bridge mapping:

| MCP tool    | Operation           |
| ----------- | ------------------- |
| `c64_debug` | `delete_checkpoint` |

---

## `0x14` - Checkpoint List

```text
cmd: empty
rsp: zero or more 0x11 CHECKPOINT_INFO, then 0x14 | CC:u32
```

`CC` is total checkpoint count.

C64 Bridge mapping:

| MCP tool    | Operation          |
| ----------- | ------------------ |
| `c64_debug` | `list_checkpoints` |

---

## `0x15` - Checkpoint Toggle

```text
cmd: CN:u32 | EN:u8
rsp: 0x15 | empty
```

C64 Bridge mapping:

| MCP tool    | Operation           |
| ----------- | ------------------- |
| `c64_debug` | `toggle_checkpoint` |

---

## `0x22` - Condition Set

Sets a text-monitor condition expression on an existing checkpoint.

```text
cmd: CN:u32 | EL:u8 | ES:str[EL]
rsp: 0x22 | empty
```

`ES` is not null-terminated. Conditions cannot currently be retrieved.

C64 Bridge mapping:

| MCP tool    | Operation       |
| ----------- | --------------- |
| `c64_debug` | `set_condition` |

---

## `0x31` - Registers Get

```text
cmd: MS:u8
rsp: 0x31 | REGISTER_INFO
```

C64 Bridge mapping:

| MCP tool    | Operation       |
| ----------- | --------------- |
| `c64_debug` | `get_registers` |

---

## `0x32` - Registers Set

```text
cmd: MS:u8 | RC:u16 | ITEM[RC]
item: IS:u8 | RI:u8 | RV:u16
rsp: 0x31 | REGISTER_INFO
```

Register IDs are machine-dependent. Query `0x83 REGISTERS_AVAILABLE`.

C64 Bridge mapping:

| MCP tool    | Operation       |
| ----------- | --------------- |
| `c64_debug` | `set_registers` |

---

## `0x41` - Dump

Saves emulator state to a snapshot file.

```text
cmd: SR:u8 | SD:u8 | FL:u8 | FN:str[FL]
rsp: 0x41 | empty
```

`SR = save ROMs`, `SD = save disks`.

No primary public C64 Bridge MCP mapping is listed in the README API reference.

---

## `0x42` - Undump

Loads emulator state from a snapshot file.

```text
cmd: FL:u8 | FN:str[FL]
rsp: 0x42 | PC:u16
```

No primary public C64 Bridge MCP mapping is listed in the README API reference.

---

## `0x51` - Resource Get

```text
cmd: NL:u8 | RN:str[NL]
rsp: 0x51 | RT:u8 | VL:u8 | RV:bytes[VL]
```

`RT`: `0x00 = string`, `0x01 = integer`.

C64 Bridge mapping:

| MCP tool   | Operation      |
| ---------- | -------------- |
| `c64_vice` | `resource_get` |

---

## `0x52` - Resource Set

```text
cmd: RT:u8 | NL:u8 | RN:str[NL] | VL:u8 | RV:bytes[VL]
rsp: 0x52 | empty
```

`RT`: `0x00 = string`, `0x01 = integer`.

C64 Bridge mapping:

| MCP tool   | Operation      |
| ---------- | -------------- |
| `c64_vice` | `resource_set` |

---

## `0x71` - Advance Instructions

Steps over a number of instructions.

```text
cmd: SO:u8 | IC:u16
rsp: 0x71 | empty
```

`SO` means step over subroutines.

C64 Bridge mapping:

| MCP tool    | Operation |
| ----------- | --------- |
| `c64_debug` | `step`    |

---

## `0x72` - Keyboard Feed

Adds PETSCII text to the keyboard buffer.

```text
cmd: TL:u8 | TC:bytes[TL]
rsp: 0x72 | empty
```

C64 Bridge mapping:

| MCP tool    | Operation    |
| ----------- | ------------ |
| `c64_input` | `write_text` |
| `c64_input` | `key`        |

Public input tools inject PETSCII through the shared KERNAL keyboard queue for cross-platform parity. The VICE backend still exposes BM `0x72` internally via `ViceClient.keyboardFeed()` when a direct monitor call is needed.

---

## `0x73` - Execute Until Return

Continues execution until just after the next `RTS` or `RTI`.

```text
cmd: empty
rsp: 0x73 | empty
```

Equivalent to the text monitor `return` command.

C64 Bridge mapping:

| MCP tool    | Operation     |
| ----------- | ------------- |
| `c64_debug` | `step_return` |

---

## `0x81` - Ping

```text
cmd: empty
rsp: 0x81 | empty
```

Used internally for VICE connectivity checks.

---

## `0x82` - Banks Available

Lists machine-specific bank IDs and names.

```text
cmd: empty
rsp: 0x82 | BC:u16 | ITEM[BC]
item: IS:u8 | BI:u16 | NL:u8 | BN:str[NL]
```

Usually internal to the VICE backend. Required for robust banked memory support.

---

## `0x83` - Registers Available

Lists machine-specific register IDs and names.

```text
cmd: MS:u8
rsp: 0x83 | RC:u16 | ITEM[RC]
item: IS:u8 | RI:u8 | RS:u8 | NL:u8 | RN:str[NL]
```

`RS` is register size in bits.

C64 Bridge mapping:

| MCP tool    | Operation        |
| ----------- | ---------------- |
| `c64_debug` | `list_registers` |

---

## `0x84` - Display Get

Gets the current display buffer.

```text
cmd: VC:u8 | FM:u8
rsp: 0x84 | FL:u32 | DW:u16 | DH:u16 | XO:u16 | YO:u16 | IW:u16 | IH:u16 | BP:u8 | BL:u32 | BD:bytes[BL]
```

| Field     | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| `VC`      | C128 only: true = VIC-II, false = VDC. Ignored otherwise |
| `FM`      | Format. `0x00 = indexed 8-bit`                           |
| `DW`,`DH` | Uncropped display size                                   |
| `XO`,`YO` | Inner display offset                                     |
| `IW`,`IH` | Inner display size                                       |
| `BP`      | Bits per pixel                                           |
| `BD`      | Display buffer                                           |

C64 Bridge mapping:

| MCP tool       | Operation       |
| -------------- | --------------- |
| `c64_graphics` | `capture_frame` |

---

## `0x85` - VICE Info

Gets VICE version information.

```text
cmd: empty
rsp: 0x85 | ML:u8 | MV:bytes[ML] | SL:u8 | SV:bytes[SL]
```

Example `MV = 03 05 00 00` means VICE `3.5.0.0`.

Used internally for diagnostics and backend capability checks.

---

## `0x86` - CPU History

Gets executed instruction history.

```text
cmd: MS:u8 | HC:u32
rsp: 0x86 | HC:u32 | HISTORY_ITEM[HC]

history_item:
IS:u8 | RC:u16 | REGISTER_ITEM[RC] | CL:u64 | IL:u8 | IB:bytes[IL]

register_item:
RS:u8 | REGISTER_INFO_BODY:bytes[RS]
```

`REGISTER_INFO_BODY` usually means:

```text
RI:u8 | RV:u16
```

`CL` is CPU clock. `IB` is instruction bytes.

No primary public C64 Bridge MCP mapping is listed in the README API reference.

---

## `0x91` - Palette Get

Gets current palette colors.

```text
cmd: VC:u8
rsp: 0x91 | PC:u16 | ITEM[PC]
item: IS:u8 | RR:u8 | GG:u8 | BB:u8
```

`VC` has the same C128 VIC-II/VDC meaning as `DISPLAY_GET`.

Usually internal to display capture and normalization.

---

## `0xa2` - Joyport Set

```text
cmd: PN:u16 | PV:u16
rsp: 0xa2 | empty
```

C64 Bridge mapping:

| MCP tool    | Operation  |
| ----------- | ---------- |
| `c64_input` | `joystick` |

The public joystick tool simulates the same port state by writing CIA1 joyport registers directly, rather than issuing BM `0xa2`.

---

## `0xb2` - Userport Set

```text
cmd: UV:u16
rsp: 0xb2 | empty
```

No primary public C64 Bridge MCP mapping is listed in the README API reference.

---

## `0xaa` - Exit

Exits the monitor and resumes emulation until the next breakpoint.

```text
cmd: empty
rsp: 0xaa | empty
```

May be followed by a `0x63 RESUMED` event.

C64 Bridge mapping:

| MCP tool     | Operation |
| ------------ | --------- |
| `c64_system` | `resume`  |

---

## `0xbb` - Quit

Quits VICE.

```text
cmd: empty
rsp: 0xbb | empty
```

Used internally for managed VICE lifecycle, not normally exposed as a user-facing MCP operation.

---

## `0xcc` - Reset

Resets system or drive.

```text
cmd: RS:u8
rsp: 0xcc | empty
```

`RS`: `0x00 = reset system`, `0x01 = power-cycle system`, `0x08..0x0b = reset drives 8..11`.

C64 Bridge mapping:

| MCP tool     | Operation |
| ------------ | --------- |
| `c64_system` | `reset`   |
| `c64_system` | `reboot`  |
| `c64_drive`  | `reset`   |

---

## `0xdd` - Autostart / Autoload

Loads a program, then returns to monitor.

```text
cmd: RL:u8 | FI:u16 | FL:u8 | FN:str[FL]
rsp: 0xdd | empty
```

`RL` means run after loading. `FI` is file index inside disk image, use `0x0000` for default.

C64 Bridge mapping:

| MCP tool      | Operation          |
| ------------- | ------------------ |
| `c64_program` | `run_prg`          |
| `c64_program` | `upload_run_basic` |
| `c64_program` | `upload_run_asm`   |

---

# Shared and Event Responses

## `0x00` - Invalid / Error

```text
body: usually empty
```

Inspect the response header error code.

---

## `0x11` - Checkpoint Info

```text
CN:u32 | CH:u8 | SA:u16 | EA:u16 | ST:u8 | EN:u8 | OP:u8 | TM:u8 | HC:u32 | IC:u32 | CE:u8 | MS:u8
```

| Field     | Meaning                                |
| --------- | -------------------------------------- |
| `CN`      | Checkpoint number                      |
| `CH`      | Currently hit                          |
| `SA`,`EA` | Inclusive address range                |
| `ST`      | Stop when hit                          |
| `EN`      | Enabled                                |
| `OP`      | `0x01 load`, `0x02 store`, `0x04 exec` |
| `TM`      | Temporary                              |
| `HC`      | Hit count                              |
| `IC`      | Ignore count                           |
| `CE`      | Has condition                          |
| `MS`      | Memspace                               |

---

## `0x31` - Register Info

```text
RC:u16 | ITEM[RC]
item: IS:u8 | RI:u8 | RV:u16
```

Query `0x83 REGISTERS_AVAILABLE` before interpreting `RI`.

---

## `0x61` - JAM Event

```text
PC:u16
```

Usually emitted with `request_id = 0xffffffff`.

---

## `0x62` - Stopped Event

```text
PC:u16
```

Usually emitted with `request_id = 0xffffffff`.

---

## `0x63` - Resumed Event

```text
PC:u16
```

Usually emitted with `request_id = 0xffffffff`.

---

# Command Summary

| Command              |    Hex |          Direct Response | C64 Bridge surface                                                                  |
| -------------------- | -----: | -----------------------: | ----------------------------------------------------------------------------------- |
| Memory Get           | `0x01` |                   `0x01` | `c64_memory.read`, `c64_memory.read_screen`, `c64_memory.wait_for_text`             |
| Memory Set           | `0x02` |                   `0x02` | `c64_memory.write`                                                                  |
| Checkpoint Get       | `0x11` |                   `0x11` | `c64_debug.get_checkpoint`                                                          |
| Checkpoint Set       | `0x12` |                   `0x11` | `c64_debug.create_checkpoint`                                                       |
| Checkpoint Delete    | `0x13` |                   `0x13` | `c64_debug.delete_checkpoint`                                                       |
| Checkpoint List      | `0x14` | many `0x11`, then `0x14` | `c64_debug.list_checkpoints`                                                        |
| Checkpoint Toggle    | `0x15` |                   `0x15` | `c64_debug.toggle_checkpoint`                                                       |
| Condition Set        | `0x22` |                   `0x22` | `c64_debug.set_condition`                                                           |
| Registers Get        | `0x31` |                   `0x31` | `c64_debug.get_registers`                                                           |
| Registers Set        | `0x32` |                   `0x31` | `c64_debug.set_registers`                                                           |
| Dump                 | `0x41` |                   `0x41` | internal or unmapped                                                                |
| Undump               | `0x42` |                   `0x42` | internal or unmapped                                                                |
| Resource Get         | `0x51` |                   `0x51` | `c64_vice.resource_get`                                                             |
| Resource Set         | `0x52` |                   `0x52` | `c64_vice.resource_set`                                                             |
| Advance Instructions | `0x71` |                   `0x71` | `c64_debug.step`                                                                    |
| Keyboard Feed        | `0x72` |                   `0x72` | `c64_input.write_text`, `c64_input.key`                                             |
| Execute Until Return | `0x73` |                   `0x73` | `c64_debug.step_return`                                                             |
| Ping                 | `0x81` |                   `0x81` | internal                                                                            |
| Banks Available      | `0x82` |                   `0x82` | internal                                                                            |
| Registers Available  | `0x83` |                   `0x83` | `c64_debug.list_registers`                                                          |
| Display Get          | `0x84` |                   `0x84` | `c64_graphics.capture_frame`                                                        |
| VICE Info            | `0x85` |                   `0x85` | internal diagnostics                                                                |
| CPU History          | `0x86` |                   `0x86` | internal or unmapped                                                                |
| Palette Get          | `0x91` |                   `0x91` | internal display support                                                            |
| Joyport Set          | `0xa2` |                   `0xa2` | `c64_input.joystick`                                                                |
| Userport Set         | `0xb2` |                   `0xb2` | internal or unmapped                                                                |
| Exit                 | `0xaa` |                   `0xaa` | `c64_system.resume`                                                                 |
| Quit                 | `0xbb` |                   `0xbb` | managed VICE lifecycle                                                              |
| Reset                | `0xcc` |                   `0xcc` | `c64_system.reset`, `c64_system.reboot`, `c64_drive.reset`                          |
| Autostart / Autoload | `0xdd` |                   `0xdd` | `c64_program.run_prg`, `c64_program.upload_run_basic`, `c64_program.upload_run_asm` |

---

# C64 Bridge Implementation Guidance

## Public MCP API First

LLM agents should prefer the public C64 Bridge MCP tools over raw VICE protocol details.

Examples:

| User intent                     | Prefer                                    |
| ------------------------------- | ----------------------------------------- |
| Read memory at `$0801`          | `c64_memory` with `op = read`             |
| Write bytes to RAM              | `c64_memory` with `op = write`            |
| Show the current text screen    | `c64_memory` with `op = read_screen`      |
| Type `LOAD"*",8,1` then Return  | `c64_input` with `op = write_text`        |
| Tap a function key or Return    | `c64_input` with `op = key`               |
| Simulate joystick fire or left  | `c64_input` with `op = joystick`          |
| Capture the current video frame | `c64_graphics` with `op = capture_frame`  |
| Set a breakpoint                | `c64_debug` with `op = create_checkpoint` |
| List breakpoints                | `c64_debug` with `op = list_checkpoints`  |
| List registers                  | `c64_debug` with `op = list_registers`    |
| Read PC and A                   | `c64_debug` with `op = get_registers`     |
| Step one instruction            | `c64_debug` with `op = step`              |
| Step until return               | `c64_debug` with `op = step_return`       |
| Continue execution              | `c64_system` with `op = resume`           |
| Reset VICE                      | `c64_system` with `op = reset`            |
| Change a VICE setting           | `c64_vice` with `op = resource_set`       |

## Backend Selection

If both C64 Ultimate and VICE are configured, use `c64_select_backend` before making VICE-specific requests.

```json
{
  "tool": "c64_select_backend",
  "op": "select",
  "backend": "vice"
}
```

Use backend switching instead of assuming the active backend is already VICE.

## Internal VICE Backend Rules

The C64 Bridge VICE backend should:

- keep binary monitor request IDs internal;
- correlate direct replies by request ID;
- treat the protocol as asynchronous;
- buffer or route asynchronous events separately from command responses;
- decode binary data internally;
- return LLM-readable JSON from MCP tools;
- return memory and display payloads as hex strings or files, not raw byte arrays;
- cache register metadata from `REGISTERS_AVAILABLE`;
- cache bank metadata from `BANKS_AVAILABLE`;
- refresh cached metadata if the VICE machine type changes.

## Suggested VICE Initialization

After connecting to the VICE binary monitor:

1. Send `PING`.
2. Send `VICE_INFO`.
3. Send `BANKS_AVAILABLE`.
4. Send `REGISTERS_AVAILABLE` for main memspace.
5. Cache register and bank mappings.
6. Drain or classify any asynchronous monitor events.

## Suggested MCP Result Shapes

### `c64_memory.read`

```json
{
  "address": 2048,
  "endAddress": 2063,
  "length": 16,
  "memspace": "main",
  "bankId": 0,
  "hex": "0102030405060708090a0b0c0d0e0f10"
}
```

### `c64_debug.get_registers`

```json
{
  "memspace": "main",
  "registers": [
    {
      "id": 3,
      "name": "PC",
      "value": 58575,
      "hex": "e4cf"
    }
  ]
}
```

### `c64_debug.create_checkpoint`

```json
{
  "checkpointNumber": 2,
  "hit": false,
  "startAddress": 64738,
  "endAddress": 64739,
  "stopWhenHit": true,
  "enabled": true,
  "operation": ["exec"],
  "temporary": true,
  "hitCount": 0,
  "ignoreCount": 0,
  "hasCondition": false,
  "memspace": "main"
}
```

---

# Attribution

This reference is derived from the VICE binary monitor documentation.

VICE is licensed under GPL v2 or later. Copyright belongs to the VICE authors as listed here:

[https://vice-emu.sourceforge.io/index.html#copyright](https://vice-emu.sourceforge.io/index.html#copyright)

The authoritative source of truth for the VICE binary monitor protocol is the VICE manual:

[https://vice-emu.sourceforge.io/vice_13.html](https://vice-emu.sourceforge.io/vice_13.html)

When this document conflicts with the upstream VICE manual, the upstream manual wins.

---
name: stream-control
description: Use when the user wants to start or stop a live video, audio or debug stream from an Ultimate 64-class device to another host.
---

## Intent

Use this skill when the user wants a live audio or video stream forwarded to another host.

## Inputs

- Stream type: video, audio or debug (`stream`).
- Destination `target`: host or IPv4 address with optional port.
- Whether the session should be stopped or started.

## Execution

1. Use `c64_stream` with `op: "start"`, `stream` and `target` to begin a stream.
2. Use `c64_stream` with `op: "stop"` and `stream` to terminate a stream.
3. Confirm the stream target back to the user after each action.
4. Streams need a wired Ethernet link (U64-class only); starting video stops debug; defaults ports 11000 video, 11001 audio, 11002 debug; a video start with `palette=1` adds palette packets (`c64://ultimate/hardware`, Data streams).

## Validation

1. Summarize the stream type and target that the workflow attempted.
2. Report any failure clearly so the user can adjust network or backend settings.

## Safety

- Remind the user to stop streams explicitly when capture is finished.

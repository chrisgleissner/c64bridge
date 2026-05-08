# Fast Path Workflows

Use these routing shortcuts when the user wants a quick visible or audible result and does not need a bespoke workflow.

## Quick Visible Demo

- Route quick greetings, smoke tests, and visible backend confirmation to `.github/skills/cross-platform-demo/SKILL.md`.
- Use the custom BASIC path only when the user needs logic beyond a simple demo.

## Ultra-Fast Hello World

- Route trivial hello-world, greeting, and smoke-test requests to `.github/skills/hello-world/SKILL.md`.
- On local machines with a graphical session, assume VICE should render visibly in a real emulator window.
- Only expect Xvfb or other headless fallback in CI or when no framebuffer/display session exists.

## Backend-Pinned BASIC Fast Path

- When the prompt already pins the backend with prefixes such as `vice:` or `c64u:` and asks for a tiny static greeting or hello-world style BASIC output, route directly to `.github/skills/hello-world/SKILL.md`.
- Treat requests such as `vice: write a small BASIC program that clears the screen and prints HELLO VICE` as unambiguous; do not spend extra turns re-reading README sections, MCP manifests, or BASIC references before executing.
- Fall back to `.github/skills/basic-program/SKILL.md` only when the user asks for custom program logic, hardware-specific behavior, or deeper debugging.

## Quick Music Demo

- Route recognizable demo-tune requests to `.github/skills/sid-music/SKILL.md`.
- The canonical built-in preset is `fuer_elise`.
- Legacy preset callers should still normalize to the same playback path rather than failing.

Example:

Call tool `c64_sound` with:

```json
{
  "op": "play_preset",
  "preset": "fuer_elise"
}
```

## Longer Interactive Sessions

- Use the dedicated skill for the underlying task when the user needs a pinned backend, custom program logic, or deeper debugging.

## Verification Order

1. Trust the verification defined by the selected skill first.
2. Use captured artifacts or follow-up inspection only when the selected skill indicates that extra verification is needed.

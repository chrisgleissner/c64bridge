# PETSCII Style Guide

Colour presets and character codes for C64 PETSCII art. Target: LLM optimization.

## C64 Colour Palette (0-15)

| Index | Name | Luminance | Common Use |
|-------|------|-----------|------------|
| 0 | Black | Low | Background, shadows |
| 1 | White | High | Text, highlights |
| 2 | Red | Medium | Accents |
| 3 | Cyan | High | Water, sky |
| 4 | Purple | Medium | Decorative |
| 5 | Green | Medium | Nature |
| 6 | Blue | Low | Sky, UI |
| 7 | Yellow | High | Highlights |
| 8 | Orange | Medium | Warm tones |
| 9 | Brown | Low | Earth |
| 10 | Light Red | Medium | Soft accents |
| 11 | Dark Grey | Low | Depth |
| 12 | Grey | Medium | Neutral |
| 13 | Light Green | High | Nature highlights |
| 14 | Light Blue | Medium | UI |
| 15 | Light Grey | Medium | Borders |

## Recommended Colour Presets

| Preset | Border | Background | Foreground | Use Case |
|--------|--------|------------|------------|----------|
| High Contrast | 0 | 0 | 1 | Text, menus, maximum readability |
| Green Terminal | 0 | 0 | 5 | Retro terminal aesthetic |
| Ocean | 6 | 6 | 3 | Water scenes |
| Sunset | 2 | 8 | 7 | Warm scenes |
| Nature | 5 | 0 | 13 | Outdoor, forest |
| Professional UI | 6 | 0 | 14 | Applications, tools |

## Contrast Guidelines

**Readable combinations** (luminance difference ≥3):

- 0/1 (Black/White), 0/7 (Black/Yellow), 0/13 (Black/Lt.Green)
- 6/1 (Blue/White), 6/7 (Blue/Yellow), 11/1 (Dk.Grey/White)

**Marginal** (luminance difference 2):

- 0/3 (Black/Cyan), 6/14 (Blue/Lt.Blue), 12/1 (Grey/White)

**Unreadable** (insufficient contrast):

- 12/15 (Grey/Lt.Grey), 11/12 (Dk.Grey/Grey), 2/4 (Red/Purple)
- 6/11 (Blue/Dk.Grey), 9/11 (Brown/Dk.Grey)

Border matching: Set border=background for seamless look.

## PETSCII vs Screen Codes

**PETSCII codes** ($00-$FF): Used in BASIC strings, CHR$(), keyboard input, PRINT statements
**Screen codes** ($00-$FF): Values directly written to screen memory ($0400-$07E7)

Conversion: Screen code ≠ PETSCII code. Use charset reference (c64://graphics/character-set) for mapping.

**Usage**:

- BASIC/printing: Use PETSCII codes with CHR$() or PRINT
- Direct screen memory: Use screen codes with POKE to $0400+offset
- Tools: `c64_graphics` with `op: "render_petscii_art"` returns both `petsciiCodes` array and screen memory data

## Essential PETSCII Symbols

| PETSCII | Char | Name | Use |
|---------|------|------|-----|
| 32 | (space) | Space | Empty cell |
| 160 | █ | Full block | Solid fill (reverse space) |
| 65-90 | A-Z | Uppercase | Text |
| 193-218 | a-z | Lowercase | Text (shifted mode) |
| 48-57 | 0-9 | Digits | Numbers |
| 115 | ♥ | Heart | Decoration, life |
| 122 | ♦ | Diamond | Suit, decoration |
| 120 | ♣ | Club | Suit, decoration |
| 97 | ♠ | Spade | Suit, decoration |
| 94 | ↑ | Up arrow | Direction, pointer |
| 95 | ← | Left arrow | Direction |
| 96 | ─ | Horizontal line | Borders, dividers |
| 125 | │ | Vertical line | Borders |
| 117 | ╭ | Arc top-left | Rounded corners |
| 105 | ╮ | Arc top-right | Rounded corners |
| 106 | ╰ | Arc bottom-left | Rounded corners |
| 107 | ╯ | Arc bottom-right | Rounded corners |
| 123 | ┼ | Cross | Grid intersection |
| 66-82 | Various | Block fractions | Dithering, gradients |

## Tool Integration

```javascript
await callTool("c64_graphics", {
  op: "render_petscii_art",
  prompt: "cat",
  borderColor: 0,
  backgroundColor: 6,
  foregroundColor: 1
})
```

Returns: `petsciiCodes[]`, `bitmapHex`, `rowHex`, `program`, dimensions

## Related Resources

- `c64://graphics/character-set` - Full PETSCII/screen code mappings
- `c64://graphics/vic/spec` - VIC-II registers, colour RAM
- `c64://basic/spec` - BASIC screen commands

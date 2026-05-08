# Sprite and Charset Workflows Best Practices

This guide provides proven workflows and best practices for creating, managing, and deploying sprites and custom character sets on the Commodore 64.

## Sprite Workflow Overview

Sprites are hardware-accelerated movable graphics objects. Each sprite is 24×21 pixels with support for multicolour or hires modes.

### Basic Sprite Workflow

1. **Design**: Create 24×21 pixel bitmap (monochrome or multicolour)
2. **Encode**: Convert to 63-byte sprite data format
3. **Upload**: Place sprite data in memory ($0340-$07FF recommended for safety)
4. **Configure**: Set sprite pointer, position, colour, and enable flags
5. **Verify**: Read screen or sprite registers to confirm appearance

### Sprite Memory Layout

Each sprite requires 63 bytes (24×21 pixels / 8 bits per byte):

- 21 rows of 3 bytes each
- Bit 1 = pixel on, Bit 0 = pixel off (hires mode)
- In multicolour mode, 2 bits per pixel define 4 colours

### Sprite Pointer Configuration

Sprites are enabled via VIC-II registers:

- `$D015` - Sprite enable (bits 0-7 for sprites 0-7)
- `$D010` - Sprite X MSB for horizontal positioning beyond 255
- `$D000-$D00F` - X/Y coordinates for sprites 0-7
- `$07F8-$07FF` - Sprite data pointers (screen memory + $03F8)

### Safe Sprite Data Locations

Use these memory ranges to avoid conflicts:

- `$0340-$03FF` - Cassette buffer (192 bytes, safe when not using tape)
- `$C000-$CFFF` - RAM under BASIC ROM (4KB, requires bank switching)
- `$2000-$3FFF` - Screen/bitmap alternatives (8KB when not displaying there)

### Sprite Colour Selection

- Individual sprite colour: `$D027-$D02E` (one per sprite)
- Multicolour shared colours: `$D025` (shared 1), `$D026` (shared 2)
- Background colour: `$D021`

Choose high-contrast colours for visibility:

- White (1) on black (0) background
- Yellow (7) or cyan (3) for highlights
- Avoid grey on grey or similar-hue combinations

## Character Set (Charset) Workflow Overview

Custom charsets allow you to redefine the 256 character glyphs displayed on screen.

### Basic Charset Workflow

1. **Design**: Create 8×8 pixel bitmaps for each character
2. **Encode**: Convert to 8-byte character definitions
3. **Upload**: Place charset in 2KB memory block ($2000, $2800, $3000, or $3800)
4. **Configure**: Point VIC-II to custom charset via `$D018`
5. **Test**: POKE characters to screen and verify appearance

### Character Definition Format

Each character uses 8 bytes (8 rows × 8 pixels):

```text
Byte 0: Row 0 bitmap (MSB = leftmost pixel)
Byte 1: Row 1 bitmap
...
Byte 7: Row 7 bitmap
```

Example: 'A' character

```text
00111100  ($3C) - Row 0
01100110  ($66) - Row 1
01100110  ($66) - Row 2
01111110  ($7E) - Row 3
01100110  ($66) - Row 4
01100110  ($66) - Row 5
01100110  ($66) - Row 6
00000000  ($00) - Row 7
```

### Charset Memory Alignment

Custom charsets must be aligned to 2KB boundaries:

- `$2000` (8192) - VIC bank 0, offset $0000
- `$2800` (10240) - VIC bank 0, offset $0800
- `$3000` (12288) - VIC bank 0, offset $1000
- `$3800` (14336) - VIC bank 0, offset $1800

### Switching Charsets

Configure VIC-II register `$D018`:

- Bits 1-3 control charset pointer
- Formula: (charset_address / 2048) << 1
- Example: For charset at $2000, POKE 53272, (53272 AND 240) OR ((8192/2048) << 1)

### Partial Charset Updates

You don't need to redefine all 256 characters:

- Only redefine characters you actually use
- Leave standard characters (A-Z, 0-9) unchanged for debugging
- Focus on block graphics (160-255) for custom effects

## Advanced Techniques

### Sprite Multiplexing

**Technical implementation**: Once VIC-II completes drawing a sprite (after scanline Y+21), the same physical sprite can be repositioned and redrawn. This maps one physical sprite definition to multiple logical sprite instances across different scanlines.

**Mechanism**:

- VIC-II fetches sprite data during raster lines Y to Y+20 (21 lines)
- After line Y+20 completes, sprite registers ($D000-$D00F, $D015, $D027-$D02E) can be modified
- Same sprite pointer ($07F8-$07FF) reused by updating position/colour for next instance
- Raster IRQ at Y+21 triggers repositioning code
- Typical: 20-24 multiplexed sprites achievable with careful timing

**Requirements**:

- Precise raster interrupt timing (see c64://graphics/vic/spec)
- Fast register updates (< 63 cycles between sprite positions)
- Pre-calculated Y-coordinate tables for performance

### Multicolour vs Hires Sprites

**Hires (default)**:

- 24×21 pixels, one colour per sprite
- Better detail and sharpness
- Ideal for detailed characters or objects

**Multicolour**:

- 12×21 effective resolution (2 bits per pixel)
- 4 colours: background, sprite colour, shared 1, shared 2
- Better for colourful, less detailed objects
- Enable via bit in `$D01C`

### Character Animation

Animate by rapidly switching between character definitions:

- Pre-load multiple frames into charset memory
- Switch displayed character code or charset pointer
- Use raster interrupts for smooth timing

### Mixed Charset/Bitmap Modes

Combine text and graphics:

- Use charset for UI elements and text
- Use sprites for player characters and bullets
- Use bitmap mode for detailed backgrounds

## Performance Considerations

### Sprite Priorities

- Sprites 0-7 have priority order (0 = front, 7 = back)
- Sprite-to-background priority controlled by `$D01B`
- Sprite-to-sprite collisions detected via `$D01E`
- Sprite-to-background collisions via `$D01F`

### Memory Bandwidth and VIC-II Cycles

**VIC-II "bad lines"** (every 8th raster, lines $30-$F7):

- VIC-II fetches 40 bytes of screen data + 40 bytes of character data
- CPU halted for ~40-43 cycles (exact depends on sprite activity)
- Bad lines occur when lower 3 bits of $D011 match lower 3 bits of raster counter

**Sprite DMA cycles**:

- Each active sprite costs 2 cycles per raster line for data fetch
- Sprite X-coordinate at DMA fetch point determines if CPU is blocked
- 8 sprites active: CPU loses 16 cycles per line
- Sprite display starts at cycle 11-12 of raster line

**Border timing and precision**:

- Upper border: Open at raster $30 by writing $D011 bit 3=0 at cycle 56
- Lower border: Open at raster $F7 by writing $D011 bit 3=1 at cycle 56  
- Side borders: $D016 bit 3 controls, must write at precise X-coordinate
- **NOP instruction** ($EA): Used for cycle-exact timing delays in border opening routines
- Typical pattern: `NOP; NOP; STA $D011` to hit exact cycle 56

**CPU availability**:

- Normal line: ~63 cycles available
- Bad line + 8 sprites: ~20 cycles available
- Critical code: Use raster lines outside $30-$F7 range or disable screen ($D011 bit 4=0)

### Charset Performance

Custom charsets have minimal performance impact:

- One-time memory copy during setup
- No runtime overhead compared to ROM charset
- Screen updates (POKE to screen memory) are the bottleneck

## Common Pitfalls and Solutions

### Sprite Not Appearing

1. Check sprite enable bit in `$D015`
2. Verify sprite pointer at `$07F8-$07FF`
3. Confirm sprite data is in correct memory location
4. Check X/Y coordinates are on screen (0-320, 0-200)
5. Verify sprite colour is different from background

### Charset Not Displaying

1. Confirm charset is at 2KB boundary
2. Check VIC-II bank selection (default is bank 0)
3. Verify `$D018` charset pointer bits
4. Ensure characters are POKEd to screen memory
5. Check that BASIC/KERNAL ROMs aren't blocking access

### Sprite Flicker

1. Reduce number of active sprites
2. Use sprite multiplexing carefully
3. Synchronize updates with raster beam
4. Consider double-buffering techniques

### Colour Clashing

1. Use PETSCII style guide for colour selection
2. Test on both PAL and NTSC if possible
3. Maintain sufficient contrast (see c64://graphics/petscii/style-guide)
4. Avoid adjacent similar-hue colours

## Tool Integration

### Using render_sprite

```javascript
await callTool("c64_graphics", {
  op: "render_sprite",
  sprite: "base64-encoded-63-bytes",
  x: 160,           // Center horizontally
  y: 100,           // Center vertically  
  color: 1,         // White
  multicolour: false
})
```

The tool:

- Validates 63-byte sprite format
- Writes sprite data directly into RAM
- Handles sprite pointer and VIC-II register setup
- Returns structured metadata for follow-up operations

### Memory Safety


When working with sprites and charsets:

1. Use memory ranges documented in c64://memory/map
2. Avoid BASIC program area ($0801-$9FFF) unless controlling it
3. Preserve zero page ($0000-$00FF) and stack ($0100-$01FF)
4. Use `c64_memory` with `op: "read"` and `op: "write"` for safe access

## Example Workflows

### Simple Sprite Display

1. Prepare 24×21 sprite bitmap
2. Call `c64_graphics` with `op: "render_sprite"` and sprite data
3. Tool writes sprite data and patches VIC-II state automatically
4. Use `c64_memory` with `op: "read_screen"` to verify appearance
5. Optionally call `c64_memory` with `op: "write"` to adjust position/colour

### Custom Charset Installation

1. Design character set (full or partial)
2. Encode to 8-byte-per-char format
3. Use `c64_memory` with `op: "write"` to copy the charset to $2000
4. POKE $D018 to point VIC-II at new charset
5. Use `c64_program` with `op: "upload_run_basic"` to test character display
6. Verify with `c64_memory` and `op: "read_screen"`

### Animated Sprite Sequence

1. Create multiple sprite frames (3-8 frames typical)
2. Upload all frames to consecutive memory locations
3. Generate BASIC program that cycles sprite pointer
4. Use raster timing for smooth animation
5. Verify frame timing with `c64_memory` and `op: "read"` checks

## Best Practices Summary

1. **Plan Memory Layout**: Map out sprite and charset locations before coding
2. **Test Incrementally**: Display one sprite/char before adding more
3. **Use Tools**: Leverage `c64_graphics` with `op: "render_sprite"` and `c64_memory` operations
4. **Document State**: Note which sprites/chars are active
5. **Handle Errors**: Check return values and screen output
6. **Optimize Last**: Get it working, then optimize if needed
7. **Verify Hardware**: Test on real C64 or accurate emulator
8. **Read Resources**: Consult c64://graphics/vic/spec for register details

## Related Resources

- `c64://graphics/vic/spec` - Complete VIC-II register reference
- `c64://graphics/character-set` - Character code mappings
- `c64://graphics/petscii/style-guide` - Colour and style guidelines
- `c64://memory/map` - Memory layout and safe ranges
- `c64://guide/bootstrap` - Safety and workflow rules

import { createPetsciiArt } from "/home/claude/c64bridge/src/petsciiArt.ts";
import { findGlyphByBasicChar } from "/home/claude/c64bridge/src/chargen.ts";
console.log("space glyph", findGlyphByBasicChar(" "));
const r = createPetsciiArt({ text: "HI THERE" });
console.log(r.petsciiCodes, r.program);

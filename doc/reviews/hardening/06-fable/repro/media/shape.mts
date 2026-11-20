import { createPetsciiArt } from "/home/claude/c64bridge/src/petsciiArt.ts";
for (const o of [{text:"HELLO", prompt:"banner for the star wars fan club"},{prompt:'Show "I LOVE C64" in big letters'},{prompt:"a cat"}]) {
  const a = createPetsciiArt(o as any); console.log(JSON.stringify(o), "-> usedShape", a.usedShape, "sourceText", a.sourceText, "size", a.bitmap.width+"x"+a.bitmap.height);
}

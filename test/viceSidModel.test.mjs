import test from "#test/runner";
import assert from "#test/assert";
import { vice8580ModelArgs } from "../scripts/vice-sid-model.mjs";

test("VICE render selects 8580 with the engine-model option supported by current VICE", () => {
  const help = `-sidenginemodel <engine and model>\n Specify SID engine and model (256: ReSID 6581, 257: ReSID 8580, 258: ReSID 8580 + digiboost)\n-sidextra <amount>`;
  assert.deepEqual(vice8580ModelArgs(help), ["-sidenginemodel", "257"]);
});

test("VICE render supports older SID-model option only when its 8580 mapping is explicit", () => {
  assert.deepEqual(vice8580ModelArgs("-sidmodel <model>\n Specify SID model (0: 6581, 1: 8580, 2: 8580 + digiboost)"), ["-sidmodel", "1"]);
  assert.throws(() => vice8580ModelArgs("-sidmodel <model>\n Specify SID model (0: 6581, 1: 6581, 2: 8580)"), /recognized 8580/);
});

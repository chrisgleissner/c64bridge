import test from "#test/runner";
import assert from "#test/assert";
import { DRIVERS, SCENARIOS, runScenario } from "./suites/taskContractSuite.mjs";

for (const scenario of SCENARIOS) {
  test(`task contract: ${scenario.name} (native and legacy agree)`, async (t) => {
    const outcomes = {};
    for (const driver of DRIVERS) outcomes[driver.id] = await runScenario(t, driver, scenario);
    const { native, legacy } = outcomes;
    assert.deepEqual(native, scenario.expected, `native outcome for ${scenario.name}: ${JSON.stringify(native)}`);
    assert.deepEqual(legacy, scenario.expected, `legacy outcome for ${scenario.name}: ${JSON.stringify(legacy)}`);
    assert.deepEqual(native, legacy);
  });
}

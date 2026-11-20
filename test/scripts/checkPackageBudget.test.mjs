import test from "#test/runner";
import assert from "#test/assert";
import { BUDGETS, evaluateBudgets } from "../../scripts/check-package-budget.mjs";

const ok = { tarballBytes: 1_300_000, unpackedBytes: 6_000_000, initializeMs: 600, toolsListBytes: 70_700, files: ["dist/index.js", "README.md"] };

test("PACKAGE-4 budgets accept today's measured package", () => {
  assert.deepEqual(evaluateBudgets(ok), []);
});

test("PACKAGE-4 budgets reject growth, slow start, large tools/list and forbidden files", () => {
  const violations = evaluateBudgets({
    ...ok,
    tarballBytes: BUDGETS.tarballBytes + 1,
    initializeMs: BUDGETS.initializeMs + 1,
    toolsListBytes: BUDGETS.toolsListBytes + 1,
    files: ["doc/img/logo.png", "src/index.ts", "scripts/sid2wav.sh"],
  });
  assert.equal(violations.length, 6);
  assert.deepEqual(evaluateBudgets({ ...ok, initializeMs: undefined }), ["initializeMs was not measured"]);
});

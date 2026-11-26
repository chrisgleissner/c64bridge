let defaultExport;
let namedExports = {};

if (typeof globalThis.Bun !== "undefined") {
  const { expect } = await import("bun:test");

  function expectWithMessage(received, message) {
    return message === undefined ? expect(received) : expect(received, message);
  }

  function toMessage(message) {
    return message === undefined ? "" : String(message);
  }

  function equal(actual, expected, message) {
    expectWithMessage(actual, message).toBe(expected);
  }

  const strictEqual = equal;

  function notEqual(actual, expected, message) {
    expectWithMessage(actual, message).not.toBe(expected);
  }

  const notStrictEqual = notEqual;

  function deepEqual(actual, expected, message) {
    expectWithMessage(actual, message).toEqual(expected);
  }

  function ok(value, message) {
    expectWithMessage(!!value, message).toBe(true);
  }

  function match(actual, pattern, message) {
    const target = typeof actual === "string" ? actual : String(actual);
    expectWithMessage(target, message).toMatch(pattern);
  }

  function fail(message) {
    throw new Error(toMessage(message) || "Assertion failed");
  }

  function doesNotThrow(fn, message) {
    try {
      fn();
    } catch (error) {
      throw new Error(toMessage(message) || `Expected function not to throw, but it threw: ${error?.message ?? error}`);
    }
  }

  async function doesNotReject(target, message) {
    const promise = typeof target === "function" ? Promise.resolve().then(target) : Promise.resolve(target);
    try {
      await promise;
    } catch (error) {
      throw new Error(toMessage(message) || `Expected promise not to reject, but it rejected: ${error?.message ?? error}`);
    }
  }

  function throws(fn, expected, message) {
    let thrown = false;
    let error;
    try {
      fn();
    } catch (err) {
      thrown = true;
      error = err;
    }
    if (!thrown) {
      throw new Error(toMessage(message) || "Expected function to throw");
    }
    applyExpected(error, expected, message);
  }

  async function rejects(target, expected, message) {
    const promise = typeof target === "function" ? Promise.resolve().then(target) : Promise.resolve(target);
    let error;
    try {
      await promise;
    } catch (err) {
      error = err;
    }
    if (error === undefined) {
      throw new Error(toMessage(message) || "Expected promise to reject");
    }
    applyExpected(error, expected, message);
  }

  function applyExpected(error, expected, message) {
    if (expected === undefined || expected === null) {
      return;
    }

    const errorMessage = error?.message ?? String(error);

    if (expected instanceof RegExp) {
      expectWithMessage(errorMessage, message).toMatch(expected);
      return;
    }

    if (typeof expected === "string") {
      expectWithMessage(errorMessage, message).toContain(expected);
      return;
    }

    if (typeof expected === "function") {
      if (expected.prototype instanceof Error || expected === Error) {
        expectWithMessage(error, message).toBeInstanceOf(expected);
        return;
      }
      const predicateResult = expected(error);
      if (!predicateResult) {
        throw new Error(toMessage(message) || "Error predicate returned falsy value");
      }
      return;
    }

    if (typeof expected === "object") {
      expectWithMessage(error, message).toMatchObject(expected);
      return;
    }

    throw new Error("Unsupported expectation type for assert");
  }

  defaultExport = {
    equal,
    strictEqual,
    notEqual,
    notStrictEqual,
    deepEqual,
    ok,
    match,
    fail,
    doesNotThrow,
    doesNotReject,
    throws,
    rejects,
  };

  namedExports = defaultExport;
} else {
  const nodeAssertModule = await import("node:assert/strict");
  const nodeAssert = nodeAssertModule.default ?? nodeAssertModule;
  defaultExport = nodeAssert;
  namedExports = nodeAssert;
}

export default defaultExport;
export const {
  equal,
  strictEqual,
  notEqual,
  notStrictEqual,
  deepEqual,
  ok,
  match,
  fail,
  doesNotThrow,
  doesNotReject,
  throws,
  rejects,
} = namedExports;

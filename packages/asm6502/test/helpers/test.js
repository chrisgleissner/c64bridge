let testImpl;
let describeImpl;

if (typeof globalThis.Bun !== "undefined") {
  const { describe: bunDescribe, test: bunTest, afterAll, afterEach: bunAfterEach, beforeAll, beforeEach: bunBeforeEach } = await import("bun:test");
  const DEFAULT_TIMEOUT_MS = 30_000;

  function parseArgs(name, optionsOrFn, maybeFn) {
    if (typeof optionsOrFn === "function" || optionsOrFn === undefined) {
      return { options: {}, fn: optionsOrFn ?? (() => {}) };
    }
    return { options: optionsOrFn ?? {}, fn: maybeFn ?? (() => {}) };
  }

  function registerTest(name, optionsOrFn, maybeFn, mode) {
    const { options, fn } = parseArgs(name, optionsOrFn, maybeFn);
    const timeoutOption = typeof options?.timeout === "number" && Number.isFinite(options.timeout)
      ? Math.max(1, options.timeout)
      : DEFAULT_TIMEOUT_MS;

    const runner = async () => {
      const teardowns = [];
      const context = {
        after(callback) {
          teardowns.push(callback);
        },
        teardown(callback) {
          teardowns.push(callback);
        },
        async test(_childName, childFn) {
          await childFn();
        },
        skip(reason) {
          const err = new Error(reason ?? "skipped");
          err.name = "SkipSignal";
          throw err;
        },
        diagnostic() {},
        plan() {},
      };

      try {
        await fn(context);
      } catch (error) {
        if (error && typeof error === "object" && error.name === "SkipSignal") {
          return;
        }
        throw error;
      } finally {
        while (teardowns.length > 0) {
          const callback = teardowns.pop();
          await callback();
        }
      }
    };

    const bunOptions = { ...options };
    const { skip, only, todo } = bunOptions;

    if (mode === "skip" || skip) {
      bunTest.skip(name, runner);
    } else if (mode === "only" || only) {
      bunTest.only(name, runner, timeoutOption);
    } else if (mode === "todo" || todo) {
      bunTest.todo(name);
    } else {
      bunTest(name, runner, timeoutOption);
    }
  }

  function bunWrapper(name, optionsOrFn, maybeFn) {
    registerTest(name, optionsOrFn, maybeFn);
  }

  bunWrapper.skip = (name, optionsOrFn, maybeFn) => {
    registerTest(name, optionsOrFn, maybeFn, "skip");
  };

  bunWrapper.only = (name, optionsOrFn, maybeFn) => {
    registerTest(name, optionsOrFn, maybeFn, "only");
  };

  bunWrapper.todo = (name, optionsOrFn, maybeFn) => {
    registerTest(name, optionsOrFn, maybeFn, "todo");
  };

  bunWrapper.after = afterAll;
  bunWrapper.afterEach = bunAfterEach;
  bunWrapper.before = beforeAll;
  bunWrapper.beforeEach = bunBeforeEach;

  testImpl = bunWrapper;
  describeImpl = bunDescribe;
} else {
  const nodeTestModule = await import("node:test");
  const defaultExport = nodeTestModule.default ?? nodeTestModule.test;
  testImpl = defaultExport;
  describeImpl = nodeTestModule.describe;
  testImpl.skip = nodeTestModule.skip.bind(nodeTestModule);
  testImpl.only = nodeTestModule.only.bind(nodeTestModule);
  testImpl.todo = nodeTestModule.todo.bind(nodeTestModule);
  testImpl.after = nodeTestModule.after.bind(nodeTestModule);
  testImpl.afterEach = nodeTestModule.afterEach.bind(nodeTestModule);
  testImpl.before = nodeTestModule.before.bind(nodeTestModule);
  testImpl.beforeEach = nodeTestModule.beforeEach.bind(nodeTestModule);
}

export default testImpl;
export { describeImpl as describe };

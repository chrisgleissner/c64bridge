import test from "#test/runner";
import assert from "#test/assert";
import { pollForProgramOutcome, loadPollConfig } from "../src/tools/pollValidator.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test("loadPollConfig uses defaults when env vars not set", () => {
  delete process.env.C64BRIDGE_POLL_MAX_MS;
  delete process.env.C64BRIDGE_POLL_INTERVAL_MS;
  delete process.env.C64BRIDGE_POLL_STABILIZE_MS;
  
  const config = loadPollConfig();
  
  // In test mode, uses shorter timeouts
  const isTestMode = process.env.C64_TEST_TARGET === "mock" || process.env.NODE_ENV === "test";
  if (isTestMode) {
    assert.equal(config.maxMs, 100);
    assert.equal(config.intervalMs, 30);
    assert.equal(config.stabilizeMs, 100);
  } else {
    assert.equal(config.maxMs, 2000);
    assert.equal(config.intervalMs, 200);
    assert.equal(config.stabilizeMs, 100);
  }
});

test("loadPollConfig reads from environment variables", () => {
  process.env.C64BRIDGE_POLL_MAX_MS = "3000";
  process.env.C64BRIDGE_POLL_INTERVAL_MS = "150";
  process.env.C64BRIDGE_POLL_STABILIZE_MS = "75";
  
  const config = loadPollConfig();
  
  assert.equal(config.maxMs, 3000);
  assert.equal(config.intervalMs, 150);
  assert.equal(config.stabilizeMs, 75);
  
  delete process.env.C64BRIDGE_POLL_MAX_MS;
  delete process.env.C64BRIDGE_POLL_INTERVAL_MS;
  delete process.env.C64BRIDGE_POLL_STABILIZE_MS;
});

test("loadPollConfig handles invalid env values with defaults", () => {
  process.env.C64BRIDGE_POLL_MAX_MS = "invalid";
  process.env.C64BRIDGE_POLL_INTERVAL_MS = "-100";
  process.env.C64BRIDGE_POLL_STABILIZE_MS = "-5";
  
  const config = loadPollConfig();
  
  // In test mode, uses shorter timeouts
  const isTestMode = process.env.C64_TEST_TARGET === "mock" || process.env.NODE_ENV === "test";
  if (isTestMode) {
    assert.equal(config.maxMs, 100);
    assert.equal(config.intervalMs, 30);
    assert.equal(config.stabilizeMs, 100);
  } else {
    assert.equal(config.maxMs, 2000);
    assert.equal(config.intervalMs, 200);
    assert.equal(config.stabilizeMs, 100);
  }
  
  delete process.env.C64BRIDGE_POLL_MAX_MS;
  delete process.env.C64BRIDGE_POLL_INTERVAL_MS;
  delete process.env.C64BRIDGE_POLL_STABILIZE_MS;
});

test("pollForProgramOutcome BASIC detects syntax error", async () => {
  const screens = [
    "READY.\n",
    "RUN\n",
    "?SYNTAX ERROR\nREADY.\n",
  ];
  
  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "READY.\n";
      return screen;
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "error");
  assert.equal(result.type, "BASIC");
  assert.equal(result.message, "SYNTAX");
});

test("pollForProgramOutcome BASIC detects error with line number", async () => {
  const screens = [
    "READY.\n",
    "RUN\n",
    "?SYNTAX ERROR IN 120\nREADY.\n",
  ];
  
  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "READY.\n";
      return screen;
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "error");
  assert.equal(result.type, "BASIC");
  assert.equal(result.message, "SYNTAX");
  assert.equal(result.line, 120);
});

test("pollForProgramOutcome BASIC returns ok when no error", async () => {
  const screens = [
    "READY.\n",
    "RUN\n",
    "HELLO WORLD\n",
    "READY.\n",
  ];
  
  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "READY.\n";
      return screen;
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 100, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "ok");
  assert.equal(result.type, "BASIC");
});

test("pollForProgramOutcome BASIC detects TYPE MISMATCH error", async () => {
  const screens = [
    "READY.\n",
    "RUN\n",
    "?TYPE MISMATCH ERROR IN 20\nREADY.\n",
  ];
  
  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "READY.\n";
      return screen;
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "error");
  assert.equal(result.type, "BASIC");
  assert.equal(result.message, "TYPE MISMATCH");
  assert.equal(result.line, 20);
});

test("pollForProgramOutcome ASM detects screen change", async () => {
  let screenCallCount = 0;
  let memoryCallCount = 0;
  const client = {
    async readScreen() {
      screenCallCount++;
      if (screenCallCount === 1) return "READY.\n";
      if (screenCallCount === 2) return "RUN\nSYS 2061\n";
      return "READY.\n";
    },
    async readMemoryRaw(address, length) {
      memoryCallCount++;
      // Simulate hardware activity by returning different values after first poll cycle
      // Each poll cycle calls readMemoryRaw 3 times (I/O, jiffy, screen)
      // So after 3 calls, start returning different values
      if (memoryCallCount <= 3) {
        // First poll cycle - stable
        return new Uint8Array(length).fill(0);
      }
      // Later reads - changed (simulating activity)
      return new Uint8Array(length).fill(1);
    },
  };
  
  const result = await pollForProgramOutcome(
    "ASM",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "ok");
  assert.equal(result.type, "ASM");
});

test("pollForProgramOutcome ASM detects crash when no screen change", async () => {
  const screens = [
    "READY.\n",
    "RUN\nSYS 2061\n",
    "RUN\nSYS 2061\n",
    "RUN\nSYS 2061\n",
  ];
  
  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "RUN\nSYS 2061\n";
      return screen;
    },
    async readMemoryRaw(address, length) {
      // Return same values every time (no activity)
      return new Uint8Array(length).fill(0);
    },
  };
  
  const result = await pollForProgramOutcome(
    "ASM",
    client,
    createLogger(),
    { maxMs: 100, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "crashed");
  assert.equal(result.type, "ASM");
  assert.equal(result.reason, "no program-visible screen progression within window");
});

test("HARD01-019/HARD01-020 ASM polling only ever reads screen RAM, never VIC/CIA I/O, and a stable signature is reported crashed", async () => {
  const memoryReads = [];
  const client = {
    async readScreen() {
      return "RUN\nSYS 2061\n";
    },
    async readMemoryRaw(address, length) {
      memoryReads.push({ address, length });
      // A perfectly stable buffer: if the poller were still reading
      // free-running VIC/CIA registers, a real machine would never produce
      // this, so "crashed" here proves the signature is screen-only.
      return new Uint8Array(length);
    },
  };

  const result = await pollForProgramOutcome(
    "ASM",
    client,
    createLogger(),
    { maxMs: 80, intervalMs: 10, stabilizeMs: 0 },
  );

  assert.equal(result.status, "crashed");
  assert.equal(result.type, "ASM");
  assert.ok(memoryReads.length > 0, "expected at least one poll read");

  // No poll may ever have touched the I/O page (VIC/SID/CIA1/CIA2), and in
  // particular never the CIA interrupt-control registers, whose reads have
  // hardware side effects (they acknowledge pending IRQs on real hardware).
  const CIA1_ICR = 0xDC0D;
  const CIA2_ICR = 0xDD0D;
  for (const read of memoryReads) {
    const end = read.address + read.length - 1;
    const overlapsIo = read.address <= 0xDFFF && end >= 0xD000;
    assert.equal(overlapsIo, false, `poll must not read the I/O page: ${JSON.stringify(read)}`);
    assert.ok(!(read.address <= CIA1_ICR && end >= CIA1_ICR));
    assert.ok(!(read.address <= CIA2_ICR && end >= CIA2_ICR));
  }
});

test("pollForProgramOutcome handles screen read failures gracefully", async () => {
  let callCount = 0;
  
  const client = {
    async readScreen() {
      callCount++;
      if (callCount < 3) {
        throw new Error("Screen read failed");
      }
      if (callCount === 3) return "RUN\n";
      return "READY.\n";
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 150, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "ok");
  assert.equal(result.type, "BASIC");
});

test("pollForProgramOutcome BASIC returns ok if RUN not detected", async () => {
  const client = {
    async readScreen() {
      return "READY.\n";
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 50, intervalMs: 10, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "ok");
  assert.equal(result.type, "BASIC");
});

test("pollForProgramOutcome ASM returns ok if RUN not detected", async () => {
  const client = {
    async readScreen() {
      return "READY.\n";
    },
  };
  
  const result = await pollForProgramOutcome(
    "ASM",
    client,
    createLogger(),
    { maxMs: 50, intervalMs: 10, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "ok");
  assert.equal(result.type, "ASM");
});

test("pollForProgramOutcome BASIC case-insensitive RUN detection", async () => {
  const screens = [
    "ready.\n",
    "run\n",
    "?syntax error\nready.\n",
  ];
  
  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "ready.\n";
      return screen;
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "error");
  assert.equal(result.type, "BASIC");
});

test("pollForProgramOutcome detects BASIC error without line number", async () => {
  const screens = [
    "READY.\n",
    "RUN\n",
    "?OUT OF MEMORY ERROR\nREADY.\n",
  ];
  
  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "READY.\n";
      return screen;
    },
  };
  
  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );
  
  assert.equal(result.status, "error");
  assert.equal(result.type, "BASIC");
  assert.equal(result.message, "OUT OF MEMORY");
  assert.equal(result.line, undefined);
});

test("loadPollConfig uses production defaults outside test mode", () => {
  const previousTarget = process.env.C64_TEST_TARGET;
  const previousEnv = process.env.NODE_ENV;
  delete process.env.C64_TEST_TARGET;
  process.env.NODE_ENV = "production";
  delete process.env.C64BRIDGE_POLL_MAX_MS;
  delete process.env.C64BRIDGE_POLL_INTERVAL_MS;
  delete process.env.C64BRIDGE_POLL_STABILIZE_MS;

  const config = loadPollConfig();

  assert.equal(config.maxMs, 2000);
  assert.equal(config.intervalMs, 200);
  assert.equal(config.stabilizeMs, 100);

  if (previousTarget === undefined) delete process.env.C64_TEST_TARGET;
  else process.env.C64_TEST_TARGET = previousTarget;
  if (previousEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv;
});

test("HARD01-021 pollForProgramOutcome BASIC treats '0 ERRORS FOUND' output as success, not a false failure", async () => {
  const screens = [
    "READY.\n",
    "RUN\n",
    "0 ERRORS FOUND\nREADY.\n",
  ];

  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "0 ERRORS FOUND\nREADY.\n";
      return screen;
    },
  };

  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.type, "BASIC");
});

test("HARD01-021 pollForProgramOutcome BASIC detects a canonical '?SYNTAX ERROR IN 20' as a real failure", async () => {
  const screens = [
    "READY.\n",
    "RUN\n",
    "?SYNTAX  ERROR IN 20\nREADY.\n",
  ];

  const client = {
    async readScreen() {
      const screen = screens.shift();
      if (!screen) return "READY.\n";
      return screen;
    },
  };

  const result = await pollForProgramOutcome(
    "BASIC",
    client,
    createLogger(),
    { maxMs: 200, intervalMs: 20, stabilizeMs: 0 },
  );

  assert.equal(result.status, "error");
  assert.equal(result.type, "BASIC");
  assert.equal(result.message, "SYNTAX");
  assert.equal(result.line, 20);
});

test("pollForProgramOutcome ASM tolerates screen read failures before RUN and then detects activity", async () => {
  let screenCalls = 0;
  let memoryCalls = 0;
  const client = {
    async readScreen() {
      screenCalls += 1;
      if (screenCalls === 1) {
        throw new Error("screen offline");
      }
      return "RUN\nSYS 2061\n";
    },
    async readMemoryRaw(_address, length) {
      memoryCalls += 1;
      return new Uint8Array(length).fill(memoryCalls > 2 ? 1 : 0);
    },
  };

  const result = await pollForProgramOutcome(
    "ASM",
    client,
    createLogger(),
    { maxMs: 120, intervalMs: 10, stabilizeMs: 1 },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.type, "ASM");
});

test("pollForProgramOutcome ASM treats repeated memory read failures as crashed", async () => {
  const client = {
    async readScreen() {
      return "RUN\nSYS 2061\n";
    },
    async readMemoryRaw() {
      throw new Error("memory offline");
    },
  };

  const result = await pollForProgramOutcome(
    "ASM",
    client,
    createLogger(),
    { maxMs: 60, intervalMs: 10, stabilizeMs: 0 },
  );

  assert.equal(result.status, "crashed");
  assert.equal(result.type, "ASM");
  assert.equal(result.reason, "no program-visible screen progression within window");
});

test("pollForProgramOutcome ASM treats jiffy clock progress as activity even when other signatures stay stable", async () => {
  let readCycle = 0;
  const client = {
    async readScreen() {
      return "RUN\nSYS 2061\n";
    },
    async readMemoryRaw(address, length) {
      if (address === 0xD000) {
        return new Uint8Array(length).fill(0);
      }

      readCycle += 1;
      const buffer = new Uint8Array(length).fill(0);
      if (readCycle >= 2) {
        buffer[0xA0] = 1;
      }
      return buffer;
    },
  };

  const result = await pollForProgramOutcome(
    "ASM",
    client,
    createLogger(),
    { maxMs: 120, intervalMs: 10, stabilizeMs: 0 },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.type, "ASM");
});

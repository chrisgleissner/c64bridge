import test from "#test/runner";
import assert from "#test/assert";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { assemblyToPrg } from "../src/tools/translation/assembler.js";
// A backend that really loaded the program returns its bytes at the load
// address (the readback upload_run_asm now performs); every other read goes to
// the test's own memory behaviour.
function withProgramLoaded(ctx, source) {
  const prg = assemblyToPrg(source);
  const loadAddress = prg.readUInt16LE(0);
  const body = prg.subarray(2);
  const inner = ctx.client.readMemoryRaw?.bind(ctx.client) ?? (async (_address, length) => new Uint8Array(length));
  return {
    ...ctx,
    client: {
      ...ctx.client,
      async readMemoryRaw(address, length) {
        if (address === loadAddress && length <= 16) return Uint8Array.from(body.subarray(0, length));
        return inner(address, length);
      },
    },
  };
}


function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function withPollStabilize(ms) {
  const previous = process.env.C64BRIDGE_POLL_STABILIZE_MS;
  process.env.C64BRIDGE_POLL_STABILIZE_MS = String(ms);
  return () => {
    if (previous === undefined) {
      delete process.env.C64BRIDGE_POLL_STABILIZE_MS;
    } else {
      process.env.C64BRIDGE_POLL_STABILIZE_MS = previous;
    }
  };
}

test("ASM program with screen changes is detected as ok", async () => {
  const restoreStabilize = withPollStabilize(0);
  const screens = [
    "READY.\n",
    "RUN\nSYS 2061\n",
    "HELLO FROM ASM\n", // Screen changed
  ];
  let memoryCallCount = 0;
  
  const ctx = {
    client: {
      async uploadAndRunAsm(program) {
        return { success: true };
      },
      async readScreen() {
        const screen = screens.shift();
        if (!screen) return "READY.\n";
        return screen;
      },
      async readMemoryRaw(address, length) {
        memoryCallCount++;
        // Simulate activity from the second read on; the test-mode poll window
        // (100 ms at 30 ms intervals) only guarantees a few reads.
        if (memoryCallCount <= 1) {
          return new Uint8Array(length).fill(0);
        }
        return new Uint8Array(length).fill(1);
      },
    },
    logger: createLogger(),
  };
  
  try {
    const result = await programRunnersModule.invoke(
      "upload_run_asm",
      { program: ".org $0801\n lda #$01\n sta $0400\n rts" },
      withProgramLoaded(ctx, ".org $0801\n lda #$01\n sta $0400\n rts"),
    );
    
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent && result.structuredContent.type === "json");
    const data = result.structuredContent.data;
    assert.equal(data.kind, "upload_run_asm");
  } finally {
    restoreStabilize();
  }
});

test("ASM program with no screen changes is reported as loaded but unconfirmed, and an error with verify", async () => {
  const restoreStabilize = withPollStabilize(0);
  const screens = [
    "READY.\n",
    "RUN\nSYS 2061\n",
    "RUN\nSYS 2061\n", // No change
    "RUN\nSYS 2061\n", // No change
  ];
  
  const ctx = {
    client: {
      async uploadAndRunAsm(program) {
        return { success: true };
      },
      async readScreen() {
        const screen = screens.shift();
        if (!screen) return "RUN\nSYS 2061\n";
        return screen;
      },
      async readMemoryRaw(address, length) {
        // Return same values every time (no activity)
        return new Uint8Array(length).fill(0);
      },
    },
    logger: createLogger(),
  };
  
  try {
    const program = ".org $0801\nloop: jmp loop"; // Infinite loop: nothing changes on screen.
    const plain = await programRunnersModule.invoke("upload_run_asm", { program }, withProgramLoaded(ctx, program));
    assert.equal(plain.isError, undefined, JSON.stringify(plain.content));
    assert.equal(plain.structuredContent.data.execution, "unconfirmed");
    assert.equal(plain.metadata.execution, "unconfirmed");
    assert.match(plain.content[0].text, /no screen change was observed/i);
    assert.ok(!/crash/i.test(plain.content[0].text));

    const verified = await programRunnersModule.invoke("upload_run_asm", { program, verify: true }, withProgramLoaded(ctx, program));
    assert.equal(verified.isError, true);
    assert.match(verified.content[0].text, /no screen change was observed/i);
    assert.ok(!/crashed/.test(verified.content[0].text));
  } finally {
    restoreStabilize();
  }
});

test("ASM polling respects environment variables", async () => {
  const restoreStabilize = withPollStabilize(0);
  // Set very short timeout
  process.env.C64BRIDGE_POLL_MAX_MS = "50";
  process.env.C64BRIDGE_POLL_INTERVAL_MS = "10";
  
  const screens = [
    "READY.\n",
    "RUN\nSYS 2061\n",
    "RUN\nSYS 2061\n",
  ];
  
  const ctx = {
    client: {
      async uploadAndRunAsm(program) {
        return { success: true };
      },
      async readScreen() {
        const screen = screens.shift();
        if (!screen) return "RUN\nSYS 2061\n";
        return screen;
      },
      async readMemoryRaw(address, length) {
        // Return same values (no activity)
        return new Uint8Array(length).fill(0);
      },
    },
    logger: createLogger(),
  };
  
  try {
    const result = await programRunnersModule.invoke(
      "upload_run_asm",
      { program: ".org $0801\nrts" },
      withProgramLoaded(ctx, ".org $0801\nrts"),
    );
    
    // With a short timeout the poll ends quickly without screen evidence.
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.data.execution, "unconfirmed");
  } finally {
    delete process.env.C64BRIDGE_POLL_MAX_MS;
    delete process.env.C64BRIDGE_POLL_INTERVAL_MS;
    restoreStabilize();
  }
});

test("HARD01-036 ASM program with no RUN echo is ok only when screen RAM genuinely progresses", async () => {
  // Previously this asserted a blind "ok" whenever RUN never appeared, which
  // is exactly the false-success the HARD01-036 fix removes: a firmware that
  // reports success but never runs the program produces no RUN echo either.
  // The truthful scenario this now covers is a native run_prg path that never
  // echoes RUN yet demonstrably progresses screen RAM, which the liveness
  // check must observe before it may report success.
  const restoreStabilize = withPollStabilize(0);
  let memoryCallCount = 0;
  const ctx = {
    client: {
      async uploadAndRunAsm(program) {
        return { success: true };
      },
      async readScreen() {
        return "READY.\n"; // RUN text never appears on this execution path.
      },
      async readMemoryRaw(_address, length) {
        memoryCallCount++;
        return new Uint8Array(length).fill(memoryCallCount <= 1 ? 0 : 1); // Real, observable progression.
      },
    },
    logger: createLogger(),
  };

  try {
    const result = await programRunnersModule.invoke(
      "upload_run_asm",
      { program: ".org $0801\nrts" },
      withProgramLoaded(ctx, ".org $0801\nrts"),
    );

    assert.equal(result.isError, undefined);
  } finally {
    restoreStabilize();
  }
});

test("ASM routine that returns to BASIC with RTS is ok, not crashed", async () => {
  const restoreStabilize = withPollStabilize(0);
  // What the Ultimate 64 shows after SYS to a routine that only sets the border and returns.
  const screen = "READY.\nLOAD\"...LOAD/TEMP0004\",8,1\n\nSEARCHING FOR ...LOAD/TEMP0004\nLOADING\nREADY.\nSYS49152\n\nREADY.\n";
  const ctx = {
    client: {
      async uploadAndRunAsm() { return { success: true }; },
      async readScreen() { return screen; },
      async readMemoryRaw(address, length) { return new Uint8Array(length).fill(0x20); },
    },
    logger: createLogger(),
  };

  try {
    const result = await programRunnersModule.invoke(
      "upload_run_asm",
      { program: "* = $c000\n inc $d020\n rts" },
      withProgramLoaded(ctx, "* = $c000\n inc $d020\n rts"),
    );
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
  } finally {
    restoreStabilize();
  }
});

test("ASM routine whose READY. appears after the first screen read is ok, not crashed", async () => {
  const restoreStabilize = withPollStabilize(0);
  let reads = 0;
  const ctx = {
    client: {
      async uploadAndRunAsm() { return { success: true }; },
      async readScreen() {
        reads += 1;
        // The routine is still running on the first read and has returned by the next one.
        return reads === 1 ? "READY.\nSYS49152\n" : "READY.\nSYS49152\n\nREADY.\n";
      },
      async readMemoryRaw(address, length) { return new Uint8Array(length).fill(0x20); },
    },
    logger: createLogger(),
  };

  try {
    const result = await programRunnersModule.invoke("upload_run_asm", { program: "* = $c000\n inc $d020\n rts" }, withProgramLoaded(ctx, "* = $c000\n inc $d020\n rts"));
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
  } finally {
    restoreStabilize();
  }
});

test("ASM program that was never loaded is an error with and without verify (HARD01-036)", async () => {
  const restoreStabilize = withPollStabilize(0);
  const ctx = {
    client: {
      async uploadAndRunAsm() { return { success: true }; }, // the U2 firmware answers success without loading
      async readScreen() { return "READY.\n"; },
      async readMemoryRaw(_address, length) { return new Uint8Array(length); }, // zeros: nothing was loaded
    },
    logger: createLogger(),
  };
  try {
    for (const verify of [false, true]) {
      const result = await programRunnersModule.invoke("upload_run_asm", { program: "* = $c000\n lda #$01\n sta $d020\n rts", verify }, ctx);
      assert.equal(result.isError, true, `verify ${verify}`);
      assert.match(result.content[0].text, /was not loaded/);
      assert.equal(result.metadata.error.details.loadAddress, 0xc000);
      assert.equal(result.metadata.error.details.expected, "A9 01 8D 20 D0 60");
    }
  } finally {
    restoreStabilize();
  }
});

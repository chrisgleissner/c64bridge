import test from "#test/runner";
import assert from "#test/assert";
import { toCallToolResult } from "../src/mcp/callToolResult.ts";

const LARGE_RESULT_TEXT_BYTES = 16 * 1024;
import { clearRegisteredSecrets, registerSecret, redactResultValue } from "../src/redact.ts";
import { jsonResult, textResult } from "../src/tools/responses.ts";

function withSecret(secret, fn) {
  clearRegisteredSecrets();
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try { registerSecret(secret); } finally { process.stderr.write = original; }
  try { return fn(); } finally { clearRegisteredSecrets(); }
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("MCP-5 / WORKFLOW-3 a text result carries its data after the message", () => {
  const wire = toCallToolResult(textResult("Program loaded.", { success: true, address: "$0801", endAddress: "$0820", labels: { start: "$0810" } }));
  const [message, json] = wire.content[0].text.split("\n");
  assert.equal(message, "Program loaded.");
  assert.deepEqual(JSON.parse(json), { address: "$0801", endAddress: "$0820", labels: { start: "$0810" } });
  assert.equal(wire.structuredContent.data.address, "$0801", "structured content stays");
});

test("MCP-5 a text result whose message already shows the data is not extended", () => {
  const hex = "$" + "A9".repeat(64);
  const wire = toCallToolResult(textResult(`Read 64 bytes starting at $C000.\n${hex}`, { success: true, hexData: hex }));
  assert.equal(wire.content[0].text, `Read 64 bytes starting at $C000.\n${hex}`);
  assert.equal(toCallToolResult(textResult("Done.", { success: true })).content[0].text, "Done.");
});

test("MCP-5 a large payload is sent once and structured content says where it is", () => {
  const pixels = "QUJD".repeat(LARGE_RESULT_TEXT_BYTES / 2);
  const wire = toCallToolResult(jsonResult({ count: 1, frames: [{ width: 384, pixels: { encoding: "base64", data: pixels } }] }, { success: true }));
  const sent = JSON.stringify(wire);
  assert.equal(occurrences(sent, pixels), 1, "payload is sent exactly once");
  assert.equal(JSON.parse(wire.content[0].text).frames[0].pixels.data, pixels, "the text block carries the payload");
  assert.equal(wire.structuredContent.data.frames[0].width, 384, "metadata stays structured");
  assert.match(wire.structuredContent.data.frames[0].pixels.data, /sent once in the text content/);

  const hex = "$" + "AB".repeat(LARGE_RESULT_TEXT_BYTES);
  const read = toCallToolResult(textResult(`Read bytes.\n${hex}`, { success: true, hexData: hex, address: "$0400" }));
  assert.equal(occurrences(JSON.stringify(read), hex), 1);
  assert.equal(read.structuredContent.data.address, "$0400");
});

test("MCP-5 a long string that is not in the text stays in structured content", () => {
  const big = "x".repeat(LARGE_RESULT_TEXT_BYTES + 10);
  const other = "y".repeat(2000);
  const result = { content: [{ type: "text", text: big }], structuredContent: { type: "json", data: { other } } };
  assert.equal(toCallToolResult(result).structuredContent.data.other, other);
});

test("MCP-7 a failed batch keeps the hex of its successful commands with a short password", () => {
  withSecret("1234", () => {
    const summary = { failed: 1, results: [{ success: true, result: { hexData: "$A9123400" } }, { success: false, error: "password 1234 rejected" }] };
    const wire = toCallToolResult({ ...jsonResult(summary, { success: false }), isError: true });
    assert.equal(wire.structuredContent.data.results[0].result.hexData, "$A9123400");
    assert.equal(JSON.parse(wire.content[0].text).results[0].result.hexData, "$A9123400");
    assert.equal(JSON.stringify(wire).includes("password 1234"), false, "error messages are still redacted");
  });
});

test("MCP-7 nested data below a payload key is not redacted", () => {
  withSecret("abc", () => {
    const out = redactResultValue({ pixels: { data: "QQ+abc/QQ" }, samples: { data: "QQ+abc/QQ" }, note: "x abc y" });
    assert.equal(out.pixels.data, "QQ+abc/QQ");
    assert.equal(out.samples.data, "QQ+abc/QQ");
    assert.equal(out.note, "x *** y");
  });
});

test("MCP-12 without a registered secret the wire result reuses the tool's blocks", () => {
  clearRegisteredSecrets();
  const result = jsonResult({ samples: Array.from({ length: 10 }, (_, i) => i) }, { success: true });
  const wire = toCallToolResult(result);
  assert.equal(wire.content[0], result.content[0], "no parse-and-copy pass without secrets");
  assert.equal(wire.structuredContent, result.structuredContent);
});

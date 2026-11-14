import test from "#test/runner";
import assert from "#test/assert";
import { toCallToolResult } from "../src/mcp/callToolResult.js";
import { clearRegisteredSecrets, redactText, registerSecret } from "../src/redact.js";
import { jsonResult, textResult } from "../src/tools/responses.js";

async function withSecret(secret, fn) {
  clearRegisteredSecrets();
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try {
    registerSecret(secret);
  } finally {
    process.stderr.write = original;
  }
  try {
    return await fn();
  } finally {
    clearRegisteredSecrets();
  }
}

test("HARD03-007 a short password does not corrupt JSON text, hex or image data in a successful result", async () => {
  await withSecret("1234", () => {
    const data = { address: 1234, hex: "A9123400", bytesHex: "1234", label: "pw 1234 end", nested: ["x1234", "1234"] };
    const out = toCallToolResult(jsonResult(data));
    const text = JSON.parse(out.content[0].text);
    assert.deepEqual(text, out.structuredContent.data, "text content equals structured content");
    assert.equal(out.structuredContent.data.address, 1234);
    assert.equal(out.structuredContent.data.hex, "A9123400");
    assert.equal(out.structuredContent.data.bytesHex, "1234");
    assert.equal(out.structuredContent.data.label, "pw *** end");
    assert.deepEqual(out.structuredContent.data.nested, ["x1234", "***"]);

    const png = "iVBOR1234w0KGgo1234AAAA";
    const image = toCallToolResult({ content: [{ type: "image", data: png, mimeType: "image/png" }] });
    assert.equal(image.content[0].data, png);
  });
});

test("HARD03-007 an unchanged result keeps its text byte for byte and a message result stays consistent", async () => {
  await withSecret("1234", () => {
    const pretty = { content: [{ type: "text", text: "{\n  \"a\": 1\n}" }], structuredContent: { type: "json", data: { a: 1 } } };
    assert.equal(toCallToolResult(pretty).content[0].text, "{\n  \"a\": 1\n}");
    const message = toCallToolResult(textResult("password is 1234.", { ok: true }));
    assert.equal(message.content[0].text, "password is ***.");
    assert.equal(message.structuredContent.data.message, "password is ***.");
  });
});

test("HARD03-007 error results and log text still redact every occurrence of a registered secret", async () => {
  await withSecret("1234", () => {
    const error = toCallToolResult({ isError: true, content: [{ type: "text", text: "rejected password=1234x and 1234" }] });
    assert.equal(error.content[0].text.includes("1234"), false);
    assert.equal(redactText("a1234b").includes("1234"), false);
  });
  await withSecret("long-secret-value", () => {
    const out = toCallToolResult(jsonResult({ note: "prefix-long-secret-value-suffix" }));
    assert.equal(JSON.stringify(out).includes("long-secret-value"), false);
  });
});

test("HARD03-007 a configured secret shorter than 8 characters is announced once on stderr without its value", () => {
  clearRegisteredSecrets();
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    registerSecret("ab1");
    registerSecret("ab2");
  } finally {
    process.stderr.write = original;
    clearRegisteredSecrets();
  }
  const warnings = lines.filter((line) => /shorter than 8/.test(line));
  assert.equal(warnings.length, 1);
  assert.ok(warnings.every((line) => !line.includes("ab1") && !line.includes("ab2")));
});

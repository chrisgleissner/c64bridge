// Cost of toCallToolResult for large successful results, no secret registered.
const repo = "/home/claude/c64bridge/dist";
const { toCallToolResult } = await import(`${repo}/mcp/callToolResult.js`);
const { jsonResult, textResult } = await import(`${repo}/tools/responses.js`);
const { payloadByteLength } = await import(`${repo}/logger.js`);

function bench(label, fn, n = 20) {
  fn();
  const s = performance.now();
  for (let i = 0; i < n; i++) fn();
  console.log(`${label}: ${((performance.now() - s) / n).toFixed(2)} ms`);
}
// A capture_samples-like result: 2 MiB of base64 in a "samples" array of numbers would be bigger; use hex strings.
const hex = "A9".repeat(1024 * 1024); // 2 MiB string
const big = jsonResult({ success: true, frames: [{ width: 384, height: 272, pixels: hex }] }, { success: true });
bench("toCallToolResult 2 MiB json (no secret)", () => toCallToolResult(big));
bench("payloadByteLength of response", () => payloadByteLength(toCallToolResult(big)));
bench("JSON.stringify once (baseline)", () => JSON.stringify(big.structuredContent));
// numeric array result, e.g. audio samples
const samples = Array.from({ length: 200_000 }, (_, i) => (i * 37) % 65536 - 32768);
const audio = jsonResult({ success: true, samples }, { success: true });
bench("toCallToolResult 200k numbers (no secret)", () => toCallToolResult(audio), 10);
bench("JSON.stringify once (baseline)", () => JSON.stringify(audio.structuredContent), 10);
// text result with metadata: metadataNotInStructuredContent
const tr = textResult("x", { success: true, hexData: hex });
bench("toCallToolResult textResult+metadata 2 MiB", () => toCallToolResult(tr));

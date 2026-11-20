import test from "#test/runner";
import assert from "#test/assert";
import { graphicsModuleGroup } from "../src/tools/registry/graphics.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });

test("HIL F6 VICE capture requests the full display canvas including border", async () => {
  let options;
  const result = await graphicsModuleGroup.invoke("c64_graphics", { op: "capture_frame" }, {
    client: { async captureFrames(value) { options = value; return { backend: "vice", frames: [{ frameNumber: 1, width: 384, height: 272, bitsPerPixel: 8, pixels: new Uint8Array(384 * 272), complete: true }] }; } },
    logger, platform: platform("vice"),
  });
  assert.equal(result.isError, undefined);
  assert.equal(options.includeBorder, true);
  assert.equal(result.structuredContent.data.frames[0].width, 384);
  assert.equal(result.structuredContent.data.frames[0].height, 272);
});

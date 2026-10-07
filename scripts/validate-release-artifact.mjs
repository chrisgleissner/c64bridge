#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateReleaseMetadata } from './validate-release.mjs';
import { startMockC64Server } from './mockC64Server.mjs';

const packageDir = path.resolve(process.argv[2]);
const version = process.argv[3];
validateReleaseMetadata(packageDir, version, { packed: true });
const temp = mkdtempSync(path.join(os.tmpdir(), 'c64bridge-release-smoke-'));
const mock = await startMockC64Server();
const config = path.join(temp, 'config.json');
writeFileSync(config, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }));
mock.state.audioSignal = { frequency: 440, sampleRate: 47982.8869047619, amplitude: 4000, leftOffset: 26900, rightOffset: 20000, rightGain: -1 };
const client = new Client({ name: 'c64bridge-release-validation', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(packageDir, 'scripts/cli.js')],
  // Launch from a foreign directory, as an installed npm consumer would.
  cwd: temp,
  env: { ...process.env, C64BRIDGE_CONFIG: config, C64_MODE: 'c64u', C64BRIDGE_DISABLE_DIAGNOSTICS: '1' },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16384); });
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, version, 'MCP runtime version differs from artifact');
  const tools = await client.listTools();
  for (const name of ['c64_program', 'c64_memory', 'c64_sound', 'c64_graphics']) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `Missing packaged tool ${name}`);
  }
  const call = async (name, args) => {
    const result = await client.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  mock.state.streamHostResolveFailures = 1;
  const samples = await call('c64_sound', { op: 'capture_samples', count: 256 });
  assert.equal(samples.metadata.samplePairs, 256);
  await call('c64_graphics', { op: 'capture_frame' });
  const recorded = await call('c64_sound', { op: 'record_analyze', durationSeconds: 0.5 });
  const analysis = JSON.parse(recorded.content.find((entry) => entry.type === 'text').text).analysis;
  assert.equal(analysis.source, 'ultimate-stream');
  assert.ok(analysis.global_metrics.average_rms > 0.08, 'Stereo audio cancelled to silence');
  assert.equal(analysis.voices[0].detected_notes.find((note) => note.note)?.note, 'A4');
  assert.equal(mock.state.streams.audio.active, false);
  assert.equal(mock.state.streams.video.active, false);
  console.log(`Packed c64bridge@${version}: CLI, MCP version/discovery, video, ARP retry, and stereo audio verified.`);
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await client.close();
  await mock.close();
  rmSync(temp, { recursive: true, force: true });
}

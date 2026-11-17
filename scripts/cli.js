#!/usr/bin/env node
// Lightweight CLI launcher for the compiled server
// Usage: `npx c64bridge` or after local install `c64bridge`

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
	'../dist/index.js',
	'../dist/src/index.js',
];

async function findEntry() {
	for (const c of candidates) {
		const p = path.resolve(here, c);
		try {
			const s = await stat(p);
			if (s.isFile()) return p;
		} catch {
			// not found, continue
		}
	}

	// Fallback: try reading package.json's main field
	try {
		const pkgPath = path.resolve(here, '../package.json');
		const raw = await readFile(pkgPath, 'utf8');
		const pkg = JSON.parse(raw);
		if (pkg && pkg.main) {
			const mainPath = path.resolve(here, '..', pkg.main);
			try {
				const s = await stat(mainPath);
				if (s.isFile()) return mainPath;
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}

	return null;
}

const entry = await findEntry();
if (!entry) {
	console.error('Cannot find compiled entrypoint. Expected dist/index.js or dist/src/index.js.');
	console.error('If you installed from npm, this likely means the published package is missing compiled files.');
	console.error('Workarounds:');
	console.error(' - Use a local checkout and run `npm run build` before `node scripts/cli.js`');
	console.error(' - Or wait for a patched release that includes compiled artifacts.');
	process.exitCode = 1;
} else {
	// import the resolved entry
	const entryUrl = pathToFileURL(entry);
	await import(entryUrl.href);
}

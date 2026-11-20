const mods = process.argv.slice(2);
for (const m of mods) { const s = performance.now(); await import(m); console.log(m.padEnd(70), (performance.now()-s).toFixed(0), "ms"); }

import { performance } from 'node:perf_hooks';
const mods = process.argv.slice(2);
for (const m of mods) { const t=performance.now(); try { await import(m);} catch(e){console.log(m,'ERR',e.message.slice(0,80))} console.log(m.replace(/.*node_modules\//,''), (performance.now()-t).toFixed(0)+'ms'); }

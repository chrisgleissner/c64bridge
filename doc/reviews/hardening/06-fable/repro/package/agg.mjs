import fs from 'node:fs';
const f=fs.readdirSync('/tmp/h6/package/prof').map(x=>'/tmp/h6/package/prof/'+x).pop();
const p=JSON.parse(fs.readFileSync(f));
const nodes=new Map(p.nodes.map(n=>[n.id,n]));
const self=new Map();
const dt=p.timeDeltas;
p.samples.forEach((id,i)=>self.set(id,(self.get(id)||0)+dt[i]));
const by={};
for(const [id,t] of self){const u=nodes.get(id).callFrame.url;let k=u.replace(/^file:\/\//,'');
 const m=k.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/); k=m?m[1]:(k.includes('/dist/')?'dist/'+k.split('/dist/')[1].split('/').slice(0,1)[0]:(k||'(native/gc/idle)'));
 by[k]=(by[k]||0)+t}
console.log(Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>(v/1000).toFixed(0)+'ms '+k).join('\n'));

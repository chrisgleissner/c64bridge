import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const o=cp.spawn; cp.spawn=function(...a){process.stderr.write('SPAWN '+a[0]+' '+JSON.stringify(a[1]).slice(0,80)+'\n'+new Error().stack.split('\n').slice(2,10).join('\n')+'\n');return o.apply(this,a)};
syncBuiltinESMExports();

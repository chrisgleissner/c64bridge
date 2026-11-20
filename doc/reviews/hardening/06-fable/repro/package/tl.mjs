import {spawn} from 'node:child_process';
const c=spawn('node',['dist/index.js'],{cwd:'/home/claude/c64bridge',env:{...process.env,C64BRIDGE_STATE_DIR:'/tmp/h6/package/state'}});
let b='';c.stdout.on('data',d=>{b+=d;let i;while((i=b.indexOf('\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(l);if(m.id===2){const t=m.result.tools.find(x=>x.name==='c64_memory');console.log(JSON.stringify(t,null,0).slice(0,2500));console.log('...');console.log('desc:',t.description.slice(0,1200));c.kill()}}});
const w=o=>c.stdin.write(JSON.stringify(o)+'\n');
w({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}}});
w({jsonrpc:'2.0',method:'notifications/initialized'});w({jsonrpc:'2.0',id:2,method:'tools/list'});

#!/usr/bin/env node
// Usage: node scripts/stress-mcp.mjs [--scenario=all|concurrency|adversarial|faults|soak]
//   [--duration=20] [--concurrency=8] [--http]
// Runs only against the local mock; soak defaults to 120 seconds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockC64Server } from "./mockC64Server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((s) => { const [k,v="true"]=s.replace(/^--/,"").split("="); return [k,v]; }));
const scenarioArg = args.scenario ?? "all";
const duration = Math.max(1, Number(args.duration ?? 20));
const concurrency = Math.max(1, Number(args.concurrency ?? 8));
const scenarios = scenarioArg === "all" ? ["concurrency","adversarial","faults","soak"] : scenarioArg.split(",");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-stress-"));
const configPath = path.join(temp,"config.json"), stateDir = path.join(temp,"state");
fs.mkdirSync(stateDir);
const stats = Object.fromEntries(scenarios.map(s=>[s,{requests:0,ok:0,errorResults:0,protocolErrors:0,expectedErrors:0,hangs:0,latencies:[],byTool:new Map(),errors:new Map()}]));
const findings=[]; let stdoutViolations=0, crashes=0, unhandled=0, stopped=false;
const children=new Set(); let mock;

function percentile(xs,p){ if(!xs.length)return 0; const a=[...xs].sort((x,y)=>x-y); return Math.round(a[Math.min(a.length-1,Math.ceil(p*a.length)-1)]); }
function sample(pid){
  try { const status=fs.readFileSync(`/proc/${pid}/status`,"utf8"); const rss=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)/1024; const fd=fs.readdirSync(`/proc/${pid}/fd`).length; const files=(d)=>fs.readdirSync(d,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?files(path.join(d,e.name)):1),0); return {rss,fd,files:files(stateDir)}; } catch{return null;}
}
function listenChild(proc){ children.add(proc);let pending="";proc.stdout.on("data",b=>{pending+=b.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()??"";for(const line of lines.filter(Boolean)){try{JSON.parse(line);}catch{stdoutViolations++;findings.push(`STDOUT violation: ${line.slice(0,120)}`);}}});proc.stdout.on("end",()=>{if(pending.trim()){try{JSON.parse(pending);}catch{stdoutViolations++;findings.push(`STDOUT violation: ${pending.slice(0,120)}`);}}});proc.stderr?.on("data",b=>{if(/Unhandled|uncaught/i.test(b.toString())){unhandled++;findings.push("Unhandled/uncaught text in server stderr");}});proc.on("exit",(code,signal)=>{children.delete(proc);if(!stopped&&code!==0){crashes++;findings.push(`Server exited (${code??signal})`);}}); }
async function startClient(faults){
  mock=await startMockC64Server(faults?{faults:{delayMs:100,delayJitterMs:100,hangupRate:.15,errorRate:.2,truncateRate:.15,stallRate:.1}}:{});
  fs.writeFileSync(configPath,JSON.stringify({c64u:{host:"127.0.0.1",port:new URL(mock.baseUrl).port}}));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,"dist/index.js")],cwd:root,env:{...process.env,C64BRIDGE_CONFIG:configPath,C64BRIDGE_STATE_DIR:stateDir,C64BRIDGE_ACCESS:"full"}});
  const client=new Client({name:"stress-harness",version:"1.0.0"}); await client.connect(transport); listenChild(transport._process); return {client,transport};
}
function recordError(st,key,message,code){const id=`${key} | ${code??""} | ${String(message).slice(0,160)}`;st.errors.set(id,(st.errors.get(id)??0)+1);}
async function request(s,tool,op,fn,{expected=false,timeout=30000}={}){const st=stats[s],key=`${tool}/${op}`,t=Date.now();let ts=st.byTool.get(key);if(!ts){ts={requests:0,ok:0,errorResults:0,protocolErrors:0,latencies:[]};st.byTool.set(key,ts);} st.requests++;ts.requests++;
  let timer;try{const result=await Promise.race([fn(),new Promise((_,rej)=>{timer=setTimeout(()=>rej(Object.assign(new Error("HANG"),{hang:true})),timeout);})]);clearTimeout(timer);const elapsed=Date.now()-t;st.latencies.push(elapsed);ts.latencies.push(elapsed);
    if(result?.isError){st.errorResults++;ts.errorResults++;const message=result.content?.find(x=>x.type==="text")?.text??"isError result";recordError(st,key,message);if(expected)st.expectedErrors++;else findings.push(`${s}: ${key} returned error: ${String(message).slice(0,160)}`);}else{st.ok++;ts.ok++;}return result;
  }catch(e){clearTimeout(timer);const elapsed=Date.now()-t;st.latencies.push(elapsed);ts.latencies.push(elapsed);const code=e?.code;recordError(st,key,e?.message??e,code);if(e.hang){st.hangs++;findings.push(`${s}: ${key} request exceeded ${timeout}ms`);}else{st.protocolErrors++;ts.protocolErrors++;if(expected)st.expectedErrors++;else findings.push(`${s}: ${key} protocol error${code?` (${code})`:""}: ${String(e?.message??e).slice(0,160)}`);}return null;}}
async function callTool(client,name,args){return client.callTool({name,arguments:args});}
let writeTail=Promise.resolve(),writeValue=0;
async function concurrencyRun(s,client,n,until){const ops=[{tool:"c64_memory",op:"read",fn:()=>callTool(client,"c64_memory",{op:"read",address:"$0400",length:16})},{tool:"c64_memory",op:"read_screen",fn:()=>callTool(client,"c64_memory",{op:"read_screen"})},{tool:"c64_rag",op:"basic",fn:()=>callTool(client,"c64_rag",{op:"basic",q:"BASIC print"})},{tool:"resources/read",op:"platform/status",fn:()=>client.request({method:"resources/read",params:{uri:"c64://platform/status"}},{parse:x=>x})},{tool:"prompts/get",op:"basic-program",fn:()=>client.request({method:"prompts/get",params:{name:"basic-program",arguments:{}}},{parse:x=>x})},{tool:"c64_memory",op:"write",fn:()=>{const run=writeTail.then(()=>callTool(client,"c64_memory",{op:"write",address:"$C000",bytes:(++writeValue&255).toString(16).padStart(2,"0")}));writeTail=run.catch(()=>{});return run;}}];
  await Promise.all(Array.from({length:n},async(_,i)=>{while(Date.now()<until){const x=ops[i%ops.length];await request(s,x.tool,x.op,x.fn);}}));}
async function adversarial(s,client,transport){
  const until=Date.now()+duration*1000;
  const invalid=[{tool:"made_up_tool",op:"call",fn:()=>callTool(client,"made_up_tool",{} )},{tool:"c64_memory",op:"bad_operation",fn:()=>callTool(client,"c64_memory",{op:"bad_operation"})},{tool:"c64_rag",op:"docs/oversize",fn:(i)=>callTool(client,"c64_rag",{op:"docs",q:"x".repeat([1,2,4,8][i%4]*1024*1024)})},{tool:"c64_batch",op:"oversize",fn:()=>callTool(client,"c64_batch",{commands:Array.from({length:65},()=>({tool:"c64_memory",args:{op:"read",address:"$0000",length:1}}))})}];
  await Promise.all(Array.from({length:concurrency},async(_,worker)=>{let i=worker;while(Date.now()<until){const x=invalid[i++%invalid.length];await request(s,x.tool,x.op,()=>x.fn(i),{expected:true});}}));
  try { await client.notification({method:"notifications/cancelled",params:{requestId:"stress-cancel",reason:"stress harness"}}); } catch {}
  await request(s,"c64_memory","read",()=>client.callTool({name:"c64_memory",arguments:{op:"read",address:"$0400",length:8},_meta:{progressToken:"stress-progress"}}));
  // Raw malformed line; use a fresh client process for this protocol attack.
  try{transport._process.stdin.write("{not json}\n");}catch{}
  if(args.http!==undefined) await httpAdversarial(s);
}
async function httpAdversarial(s){
  const probe=await import("node:net"); const server=probe.createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const port=server.address().port;await new Promise(r=>server.close(r));
  const p=await import("node:child_process");const cp=p.spawn(process.execPath,[path.join(root,"dist/index.js"),"--http",`--port=${port}`],{cwd:root,env:{...process.env,C64BRIDGE_CONFIG:configPath,C64BRIDGE_STATE_DIR:stateDir,C64BRIDGE_HTTP_TOKEN:"stress-token"},stdio:["ignore","pipe","pipe"]});listenChild(cp);
  for(let i=0;i<100&&cp.exitCode===null;i++){try{if((await fetch(`http://127.0.0.1:${port}/mcp`,{method:"GET"})).status)break;}catch{} await new Promise(r=>setTimeout(r,50));}
  for(const [headers,method] of [[{},"POST"],[{"Authorization":"Bearer wrong"},"POST"],[{"Authorization":"Bearer stress-token"},"GET"],[{"Authorization":"Bearer stress-token"},"DELETE"]])await request(s,"http","authorization",async()=>{const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method,headers});return {isError:r.status<400};},{expected:true});
  cp.kill("SIGTERM");await new Promise(r=>setTimeout(r,100));
}
async function main(){
  const {client,transport}=await startClient(scenarios.includes("faults"));
  const init=sample(transport._process.pid); let max={...init},end=init; const start=Date.now();
  const monitor=setInterval(()=>{const v=sample(transport._process.pid);if(v){end=v;max={rss:Math.max(max.rss,v.rss),fd:Math.max(max.fd,v.fd),files:Math.max(max.files,v.files)};}},10000);
  for(const s of scenarios){if(!stats[s]){findings.push(`Unknown scenario: ${s}`);continue;} if(s==="concurrency"||s==="soak")await concurrencyRun(s,client,concurrency,Date.now()+duration*1000); if(s==="faults")await concurrencyRun(s,client,concurrency*2,Date.now()+duration*1000); if(s==="adversarial")await adversarial(s,client,transport);}
  clearInterval(monitor); stopped=true; try{await client.close();}catch{} for(const p of children){try{p.kill("SIGTERM");}catch{}} await mock?.close();
  const output={scenarios:Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,{requests:v.requests,ok:v.ok,errorResults:v.errorResults,protocolErrors:v.protocolErrors,expectedErrors:v.expectedErrors,hangs:v.hangs,p50:percentile(v.latencies,.5),p99:percentile(v.latencies,.99),max:v.latencies.length?Math.max(...v.latencies):0,errors:[...v.errors].map(([message,count])=>({message,count})).sort((a,b)=>b.count-a.count).slice(0,15),tools:Object.fromEntries([...v.byTool].map(([name,t])=>[name,{requests:t.requests,ok:t.ok,errorResults:t.errorResults,protocolErrors:t.protocolErrors,p50:percentile(t.latencies,.5),p99:percentile(t.latencies,.99)}]))}])),rssStartMB:+init.rss.toFixed(1),rssEndMB:+end.rss.toFixed(1),rssMaxMB:+max.rss.toFixed(1),fdStart:init.fd,fdEnd:end.fd,fdMax:max.fd,stateFilesStart:init.files,stateFilesEnd:end.files,stdoutViolations,crashes,unhandled,findings};
  if(scenarios.includes("soak")&&Date.now()-start>=120000){if(end.rss>init.rss*1.5||end.fd>init.fd*1.5)findings.push("Soak RSS or FD growth exceeded 50% after the 2-minute mark");}
  console.log(JSON.stringify(output,null,2));fs.rmSync(temp,{recursive:true,force:true}); if(Object.values(stats).some(s=>s.hangs)||crashes||stdoutViolations||unhandled||findings.some(x=>x.includes("growth exceeded")))process.exitCode=1;
}
process.on("SIGINT",()=>{stopped=true;for(const p of children)p.kill("SIGTERM");void mock?.close();process.exit(130);});process.on("SIGTERM",()=>{stopped=true;for(const p of children)p.kill("SIGTERM");void mock?.close();process.exit(143);});
main().catch(async e=>{console.error(e);stopped=true;for(const p of children)p.kill("SIGTERM");await mock?.close();fs.rmSync(temp,{recursive:true,force:true});process.exitCode=1;});

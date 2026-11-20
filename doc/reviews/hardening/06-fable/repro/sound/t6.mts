import { audioModule } from "/home/claude/c64bridge/src/tools/audio.ts";
const logger={info(){},warn(){},debug(){},error(){}};
const calls:any[]=[];
const client:any={ sidSetVolume: async(v:number)=>{calls.push(["vol",v]);return {success:true,details:{}}}, sidNoteOn: async(o:any)=>{calls.push(["on",o]);return {success:true}}};
const ctx:any={client,logger,platform:{id:"c64u"},setPlatform(){}};
async function inv(n:string,a:any){ try{ const r:any=await audioModule.invoke(n,a,ctx); console.log(n,JSON.stringify(a).slice(0,60),"=>",JSON.stringify(r).slice(0,260)); }catch(e:any){console.log(n,"THROW",e.message)} }
await inv("sid_volume",{volume:20});
await inv("sid_volume",{volume:7.9}); console.log(JSON.stringify(calls));
await inv("analyze_audio",{request:"analyze"});
await inv("analyze_audio",{request:"measure the pitch"});
await inv("analyze_audio",{request:"record 5 seconds and check the notes"});

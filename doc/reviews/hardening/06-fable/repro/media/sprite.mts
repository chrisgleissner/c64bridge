import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
let reads=0, writes=0;
const facade:any = { readMemory: async (a:number,n:number)=>{reads++; return new Uint8Array(n);}, writeMemory: async()=>{writes++; return {success:true}}, writeMemoryBlocks: async()=>{writes++} };
const fake:any = Object.create(C64Client.prototype);
fake.facadePromise = Promise.resolve(facade);
const r = await C64Client.prototype.displaySprite.call(fake,{spriteBytes:new Uint8Array(63),x:300,y:100});
console.log(r.success, "reads",reads,"writes",writes);

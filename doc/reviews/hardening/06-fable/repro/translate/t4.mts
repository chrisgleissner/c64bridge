import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
function t(label:string, src:string, o:any={}){
  try{const r=assemblyToPrgDetailed(src,o);console.log(label.padEnd(34),"OK  ",[...r.prg].map(x=>x.toString(16).padStart(2,"0")).join(" "),"entry",r.entryAddress.toString(16));}
  catch(e:any){console.log(label.padEnd(34),"ERR ",e.message.replace(/\n/g," | "))}
}
const H="* = $c000\n";
const D=(s:string,h=H)=>t(s.replace(/\n/g,"\\n"),h+s+"\n");
console.log("--- labels");
for (const s of [`start lda #1`,`start: lda #1`,`start:\n lda #1\n bne start`,`start:\n lda #1\n bne Start`,`.loop dex\n bne .loop`,`main:\n.loop: dex\n bne .loop\nother:\n.loop: dex\n bne .loop`,`main:\n.loop: dex\n bne main.loop`,`@loop: dex\n bne @loop`,`- dex\n bne -`,`+ nop\n beq +`,`loop: dex\n bne loop\n loop: nop`,`a: nop\n lda a`,`a = 5\n lda a`,`a = 5\n asl a`,`x = 5\n lda x`,`lda zp\nzp = $fb`,`zp = $fb\n lda zp`,`lda label\nlabel: nop`,`lda zp,x\nzp = $fb`,`lda z\nz = $10\n.byte 0`,`size = end - start\nstart: nop\nend:`,`start: nop\nend:\nsize = end - start\n .byte size`,`start: nop\nsize = end - start\nend:`,`label = label2 + 1\nlabel2: nop`,`A: nop`,`lda #1 : sta $d020`,`lda #1 : : nop`,`  jmp start\nstart:  ; c`,`lda #1 // c`,`lda #1 # c`,`/* c */ nop`,`NOP\nnop\nNop`,`Label: nop\n jmp label`,`lda #<main\nmain:`,`global:\n.byte 1\n.local = 5`,`brk\nbrk`,`start = $c000\n* = start+3\nnop`]) D(s);
console.log("--- branches");
const br=(n:number,back:boolean)=>{
 if(!back) return `bne t\n.fill ${n},$ea\nt: nop`;
 return `t: nop\n.fill ${n},$ea\nbne t`;};
for (const n of [127,128,0]) t(`fwd fill ${n}`,H+br(n,false)+"\n");
for (const n of [125,126,127,128]) t(`back fill ${n}`,H+br(n,true)+"\n");
D(`bne $c000`);D(`bne $c002`);D(`bne $c081`);D(`bne $c082`);D(`bne $bf82`);D(`bne $bf83`);D(`bne *+2`);D(`bne *`);D(`bne *-126`);D(`bne foo,x\nfoo:`);D(`bne #5`);D(`bne ($c000)`);D(`bne a`);
t("branch across $ffff",`* = $fff0\n bne $0005\n`);
t("branch from ffff",`* = $fffd\n bne $0000\n`);

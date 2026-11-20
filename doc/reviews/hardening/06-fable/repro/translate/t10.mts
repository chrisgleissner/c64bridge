import { parseSymbolFile } from "/home/claude/c64bridge/src/tools/translation/symbolRegistry.ts";
const tm=(l:string,s:string)=>{const t=performance.now();const m=parseSymbolFile(s);console.log(l,"ms",(performance.now()-t).toFixed(0),"n",m.size)};
tm("spaces","a = x"+" ".repeat(100000)+"y");
tm("spaces2","a"+" ".repeat(100000)+"b");
tm("al spaces","al "+"0".repeat(100000)+" ");
tm("al x","al C:"+"a".repeat(100000)+" "+" ".repeat(50000)+"\n");
tm("dots","a"+".".repeat(100000)+"!");
tm("w","a"+"w".repeat(100000)+"!=");
console.log([...parseSymbolFile(`al C:0810 .main\nadd_label 0x0820 .foo\nmain2 = $0830\nfoo2 = 2064 ; c\n.label bar=$0840\nal 0850 baz\nlabel3 = $10000\nlab4 = %1010\nlab5=0x10\n.namespace x {\nlocal.x = $c000\n`)]);

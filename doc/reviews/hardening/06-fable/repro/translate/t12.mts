import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
for (const s of ['10 PRINT "“quoted”"','10 PRINT "Ünï"','10 PRINT "★"','10 PRINT "x"\n20 PRINT "€"']) { try{basicToPrg(s);console.log("ok",s)}catch(e:any){console.log(e.constructor.name,"|",e.message)} }

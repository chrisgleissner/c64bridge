import { assemblyToPrgDetailed } from "/home/claude/wt/F/src/tools/translation/assembler.ts";
const cases = [
 '*=$c000\n!text "Test@[]^_`{|}~ab"', '*=$c000\n!pet "Test"', '*=$c000\n!scr "Test@[]^_`az"', '*=$c000\n.text "Test"', '*=$c000\n.scr "Test"', '*=$c000\n.screen "Test"', '*=$c000\n.petscii "Test"',
 '*=$c000\n!tx "Test"', '*=$c000\n!align 255,0\n', '*=$c001\n!align 255,0', '*=$c001\n!align 3,0', '*=$c001\n!align 3,2,7', '*=$c001\n.align 4', '*=$c000\n!fill 3', '*=$c000\n!fi 3,$ff', '*=$c000\n.res 3', '*=$c000\n.res 3,$ea\n nop', '*=$c000\n!08 1,2\n!16 $1234\n!by 3\n!wo 5\n!8 9',
 '*=$c000\nrts2\n rts', '*=$c000\nloop\n jmp loop', '*=$c000\nloop nop\n jmp loop', '*=$c000\nrts2 nop', '*=$c000\n nop\nlsr\n rts', '*=$c000\nINX\n rts', '*=$c000\ninx\n rts',
];
for (const s of cases) { try { const r = assemblyToPrgDetailed(s); console.log("OK ", JSON.stringify(s), r.prg.subarray(2).toString("hex"), r.warnings ? JSON.stringify(r.warnings) : ""); } catch (e) { console.log("ERR", JSON.stringify(s), e.message.split("\n")[0]); } }

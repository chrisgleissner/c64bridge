import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
import { listBasicProgram } from "/home/claude/c64bridge/src/tools/translation/basicDetokenizer.ts";
function t(src:string, o:any={}){
  try{const p=basicToPrg(src,o);const body=[...p].slice(2);
   const l=listBasicProgram(Uint8Array.from(body),(o.startAddress??0x801));
   console.log(JSON.stringify(src).padEnd(46),[...p].slice(6,Math.min(p.length,6+40)).map(x=>x.toString(16).padStart(2,"0")).join(" "),"=>",JSON.stringify(l.lines.map(x=>x.number+" "+x.text)),l.corrupt?"CORRUPT":"")}
  catch(e:any){console.log(JSON.stringify(src).padEnd(46),"ERR",e.message.slice(0,160))}
}
for (const s of [
 `10 PRINT "HELLO"`,`10 print "hello"`,`10 ?"X"`,`10 FORM=1TO10`,`10 FOR I=1 TO 10:NEXT I`,`10 GO TO 20`,`10 GOTO 20`,`10 GOSUB 100`,`10 ON X GOTO 1,2`,`10 PRINT#1,"A"`,`10 PRINT #1,"A"`,`10 INPUT#1,A$`,`10 GET#1,A$`,`10 GET A$`,`10 OPEN 1,8,15,"I"`,`10 REM PRINT "X" GOTO`,`10 DATA 1,2,PRINT,"A:B":PRINT`,`10 DATA hello, world`,`10 PRINT "FOR TO GOTO"`,`10 A=B>=C`,`10 A=B<>C`,`10 A=B<=C`,`10 IF A=1 THEN 20`,`10 POKE 53280,0:POKE 53281,0`,`10 A$=CHR$(147)+"X"`,`10 PRINT TAB(5);SPC(3);"X"`,`10 X=PEEK(53280)AND15`,`10 X=NOT A OR B`,`10 X=A^2`,`10 PRINT "{clr}{home}"`,`10 PRINT "{CLR}{HOME}{red}{blue}{white}"`,`10 PRINT "{$93}"`,`10 PRINT "{cursor down}{rvs on}X"`,`10 PRINT "£"`,`10 PRINT "π"`,`10 X=π`,`10 PRINT "Hello World"`,`10 REM é`,`10 PRINT "é"`,`10 PRINT "unterminated`,`10 PRINT "a""b"`,`10 PRINT CHR$(34)`,`10 SYS 2061`,`10 SYS2061`,`10 WAIT 1,2,3`,`10 DEF FN A(X)=X*2`,`10 A=FNA(3)`,`10 LET A=1`,`10 NEW`,`10 CLR`,`10 CMD 4`,`10 CLOSE 1`,`10 VERIFY "A",8`,`10 LOAD "A",8,1`,`10 SAVE "A",8`,`10 STOP`,`10 END`,`10 RESTORE`,`10 CONT`,`10 LIST`,`10 DIM A(10)`,`10 READ A`,`10 RETURN`,`10 RUN`,`10 A=SGN(1)+INT(1)+ABS(1)+USR(1)+FRE(0)+POS(0)+SQR(1)+RND(1)+LOG(1)+EXP(1)+COS(1)+SIN(1)+TAN(1)+ATN(1)+PEEK(1)+LEN("A")+VAL("1")+ASC("A")`,`10 A$=STR$(1)+LEFT$(B$,1)+RIGHT$(B$,1)+MID$(B$,1,1)`,
 `0 PRINT`,`63999 PRINT`,`64000 PRINT`,`10`,`  10   PRINT   "X"`,`10PRINT"X"`,`10 PRINT "A"\n20 PRINT "B"\n10 PRINT "C"`,`20 PRINT\n10 PRINT`,`PRINT "X"`,`10 PRINT "X"\n\nFOO`,`10 PRINT "X";:PRINT`,`10 TOTAL=1`,`10 IF X THEN PRINT "A":GOTO 10`,`10 A=1 :REM X`,`10 DATA "a","b"`,`10 print "a"; chr$(65)`,`10 PRINT "\\n"`,`10 REM`,`10 :`,`10 PRINT "A` + "\t" + `B"`
]) t(s);

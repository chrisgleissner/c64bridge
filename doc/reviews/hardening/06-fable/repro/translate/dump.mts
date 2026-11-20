import { screenCodesToAscii } from "/home/claude/wt/F/src/petscii.ts";
for (const cs of ["upper","lower"] as const){ let s=""; for(let r=0;r<16;r++){ let row=""; for(let c=0;c<16;c++){ row+=screenCodesToAscii(Uint8Array.of(r*16+c),{charset:cs,trimTrailingSpaces:false,trimTrailingEmptyRows:false})||"?"; } s+=r.toString(16)+": "+row+"\n"} console.log(cs+"\n"+s)}

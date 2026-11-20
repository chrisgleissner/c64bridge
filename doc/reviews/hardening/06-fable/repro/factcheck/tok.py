import re
lines=open('src/c64ref/src/c64disasm/c64disasm_en.txt',encoding='utf-8').read().split('\n')
mem={}
for l in lines:
    m=re.match(r'^\.:([0-9A-F]{4})\s+((?:[0-9A-F]{2} ?)+)',l)
    if m:
        a=int(m.group(1),16)
        bs=m.group(2).split()
        for i,b in enumerate(bs):
            if len(b)==2: mem[a+i]=int(b,16)
# keywords from A09E until 0
kw=[];cur=''
a=0xA09E
while mem.get(a,0)!=0:
    b=mem[a]
    cur+=chr(b&0x7f)
    if b&0x80: kw.append(cur);cur=''
    a+=1
for i,k in enumerate(kw): print(f"{0x80+i:02X} {k}")
# simulate crunch for abbreviation: input bytes list
def crunch(inp):
    # returns token index matched first or None; inp is list of bytes
    y=0;wi=0
    while True:
        # compare
        x=0; 
        start=y
        while True:
            if y>=len(tbl): return None
            d=(inp[x] if x<len(inp) else 0)-tbl[y]
            d&=0xff
            if d==0: x+=1;y+=1;continue
            if d==0x80: return wi
            break
        # skip to end of this word
        while not (tbl[y]&0x80): y+=1
        y+=1; wi+=1
        if tbl[y]==0: return None
tbl=[]
a=0xA09E
while mem[a]!=0: tbl.append(mem[a]);a+=1
tbl.append(0)
import json
ab={}
for i,k in enumerate(kw):
    for n in range(1,len(k)):
        inp=[ord(c) for c in k[:n]]+[ord(k[n])|0x80]
        if crunch(inp)==i: ab[k]=k[:n].lower()+k[n]; break
    else: ab[k]='-'
json.dump(ab,open('abbr.json','w'))
print(ab)

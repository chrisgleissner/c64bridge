import re,sys
lines=open('src/c64ref/src/c64disasm/c64disasm_en.txt',encoding='utf-8').read().split('\n')
idx={}
for i,l in enumerate(lines):
    m=re.match(r'^\.[,:]([0-9A-F]{4})',l)
    if m: idx.setdefault(m.group(1),i)
doc=open(sys.argv[1],encoding='utf-8').read()
for m in re.finditer(r'^\| `\$([0-9A-F]{4})` \| \d+ \| ([^|]+)\|([^|]+)\|',doc,re.M):
    a,name,fn=m.group(1),m.group(2).strip(),m.group(3).strip()
    if a not in idx: print(a,name,'-> NOT AN INSTRUCTION/LINE START'); continue
    i=idx[a]; hdr=''
    for j in range(i-1,max(i-6,0),-1):
        if '***' in lines[j]: hdr=lines[j].strip(); break
    print(f"{a} {name:18} | {fn[:40]:40} | {hdr[:70]} || {lines[i][:60]}")

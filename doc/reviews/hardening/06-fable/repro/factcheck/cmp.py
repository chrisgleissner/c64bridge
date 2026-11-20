import re,json
ab=json.load(open('abbr.json'))
exec(open('tok.py').read().split('import json')[0].replace('for i,k in enumerate(kw): print','for i,k in []: print'))
doc=open('/home/claude/c64bridge/data/basic/basic-spec.md',encoding='utf-8').read()
seen=set()
for m in re.finditer(r'^\| ([0-9A-F]{2}) \| ([^|]+)\| ([^|]+)\|',doc,re.M):
    t=int(m.group(1),16); k=m.group(2).strip(); a=m.group(3).strip()
    seen.add(t)
    rk=kw[t-0x80] if 0<=t-0x80<len(kw) else None
    ra=ab.get(rk,'?') if rk else '?'
    if rk!=k or (a not in ('—','?') and a!=ra) or (a=='—' and ra!='-'):
        print('MISMATCH',m.group(1),k,a,'ROM:',rk,ra)
print('missing tokens:',[f"{0x80+i:02X} {kw[i]}" for i in range(len(kw)) if 0x80+i not in seen])

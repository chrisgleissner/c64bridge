import re
src=open('src/c64ref/src/6502/cpu_6502.txt').read().split('\n')
def section(name):
    out=[];on=False
    for l in src:
        if l.startswith('['): on=(l.strip()=='['+name+']'); continue
        if on and re.match(r'^[0-9A-F]{2}\s',l): out.append(l.split())
    return out
modemap={'-':'IMP','A':'A','#d8':'IMM','a8':'ZP','a8,X':'ZPX','a8,Y':'ZPY','(a8,X)':'IZX','(a8),Y':'IZY','a16':'ABS','a16,X':'ABSX','a16,Y':'ABSY','(a16)':'IND','r8':'REL'}
ops={}
for p in section('opcodes'):
    code=int(p[0],16); mn=p[1]; mode=modemap[p[2]] if len(p)>2 else 'IMP'
    ops[code]=(mn,mode)
tim={int(p[0],16):p[1] for p in section('timing')}
doc=open('/home/claude/c64bridge/data/assembly/assembly-spec.md',encoding='utf-8').read()
# matrix
cols='A # ZP ZPX ZPY ABS ABSX ABSY IND IZX IZY REL IMP'.split()
cmap={'#':'IMM'}
real={}
for c,(mn,mode) in ops.items():
    if mn.startswith('*'): continue
    real.setdefault(mn,set()).add(mode)
for m in re.finditer(r'^\| ([A-Z]{3}) \|(.*)\|$',doc,re.M):
    mn=m.group(1); cells=m.group(2).split('|')
    if len(cells)!=13: continue
    s={cmap.get(cols[i],cols[i]) for i,c in enumerate(cells) if '✓' in c}
    r=real.get(mn,set())
    if s!=r: print('MATRIX',mn,'doc-only',s-r,'missing',r-s)
# decode table
for m in re.finditer(r'^([0-9A-F]{2}) (\S+) (\S+) (\S+) (\S+) ',doc,re.M):
    c=int(m.group(1),16); mn,mode,fl,cy=m.group(2),m.group(3),m.group(4),m.group(5)
    rmn,rmode=ops[c]; rcy=tim.get(c)
    rmn2=rmn.lstrip('*')
    alias={'JAM':'KIL','ISC':'ISB','SBX':'AXS','ASR':'ALR','SHA':'AHX','SHS':'TAS','LAS':'LAS'}
    if mode!=rmode or (rmn2!=mn and alias.get(rmn2)!=mn) or (rcy and re.sub(r'\+.*','',rcy)!=cy and cy!='halt'):
        print('DECODE',m.group(1),mn,mode,cy,'ROM-ref:',rmn,rmode,rcy)

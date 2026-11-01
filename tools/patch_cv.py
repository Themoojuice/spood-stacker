"""Make OpenCV.js builds with a raised WASM memory ceiling.
   usage: patch_cv.py <in opencv.js> <out.js> <max MiB> [exact]
   exact: grow the heap to exactly what is requested (rounded to 16 MiB), for measuring peak demand."""
import re, base64, sys
src_path, out_path, max_mib = sys.argv[1], sys.argv[2], int(sys.argv[3])
exact = len(sys.argv) > 4 and sys.argv[4] == 'exact'
src = open(src_path).read()
m = re.search(r'data:application/octet-stream;base64,([A-Za-z0-9+/=]+)', src)
b = bytearray(base64.b64decode(m.group(1)))
def leb(b, p):
    r = s = 0
    while True:
        x = b[p]; p += 1; r |= (x & 0x7f) << s; s += 7
        if not x & 0x80: return r, p
def enc(v, n):  # fixed-length LEB128 (padded) so section sizes don't change
    out = []
    for i in range(n):
        byte = v & 0x7f; v >>= 7
        out.append(byte | (0x80 if i < n - 1 else 0))
    assert v == 0
    return bytes(out)
pages = max_mib * 16 if max_mib < 2048 else 32767          # 2 GiB - 64 KiB at most (signed pointers in the old glue)
p = 8; done = False
while p < len(b):
    sid = b[p]; p += 1; size, p = leb(b, p); end = p + size
    if sid == 2:
        cnt, q = leb(b, p)
        for _ in range(cnt):
            l, q = leb(b, q); q += l; l, q = leb(b, q); name = b[q:q+l]; q += l
            kind = b[q]; q += 1
            if kind == 0: _, q = leb(b, q)
            elif kind == 1: q += 1; fl = b[q]; q += 1; _, q = leb(b, q); q = leb(b, q)[1] if fl & 1 else q
            elif kind == 2:
                fl = b[q]; q += 1; _, q = leb(b, q); s0 = q; old, q = leb(b, q); n = q - s0
                b[s0:q] = enc(pages, n); done = True
                print(f'wasm memory max: {old} -> {pages} pages ({pages*65536/2**20:.0f} MiB)')
            elif kind == 3: q += 2
    p = end
assert done
lim = pages * 65536
src = src[:m.start(1)] + base64.b64encode(bytes(b)).decode() + src[m.end(1):]
n1 = src.count('"maximum":1073741824/WASM_PAGE_SIZE'); src = src.replace('"maximum":1073741824/WASM_PAGE_SIZE', f'"maximum":{lim}/WASM_PAGE_SIZE')
n2 = src.count('newSize=Math.min(newSize,1073741824)'); src = src.replace('newSize=Math.min(newSize,1073741824)', f'newSize=Math.min(newSize,{lim})')
assert n1 == 1 and n2 == 1, (n1, n2)
if exact:
    old = 'var newSize=Math.max(oldSize,MIN_TOTAL_MEMORY);while(newSize<requestedSize){if(newSize<=536870912){newSize=alignUp(2*newSize,PAGE_MULTIPLE)}else{newSize=Math.min(alignUp((3*newSize+2147483648)/4,PAGE_MULTIPLE),LIMIT)}}'
    assert src.count(old) == 1
    src = src.replace(old, 'var newSize=Math.max(oldSize,alignUp(requestedSize,16777216));')
    print('growth: exact (16 MiB steps)')
open(out_path, 'w').write(src)
print('wrote', out_path)

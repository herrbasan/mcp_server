"""Pixel diff between two rasters: a verdict, not the content.

    python docs/sketch-proto/compare.py a.png b.png
"""

import hashlib
import sys
from PIL import Image, ImageChops

a, b = sys.argv[1], sys.argv[2]
ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
if ia.size != ib.size:
    print(f"size differs: {ia.size} vs {ib.size}")
    sys.exit(0)

ha = hashlib.sha256(open(a, "rb").read()).hexdigest()[:12]
hb = hashlib.sha256(open(b, "rb").read()).hexdigest()[:12]
diff = ImageChops.difference(ia, ib)
bbox = diff.getbbox()
changed = sum(1 for px in diff.getdata() if sum(px) > 12)
total = ia.size[0] * ia.size[1]

print(f"a={ha} b={hb} identical={ha == hb}")
print(f"diff bbox={bbox} changed px={changed} ({100 * changed / total:.2f}%)")

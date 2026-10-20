"""Sample raster colours at viewBox coordinates.

    python docs/sketch-proto/probe.py <png> <viewbox-width> x,y x,y ...
"""

import sys
from PIL import Image

path, vb_w = sys.argv[1], float(sys.argv[2])
img = Image.open(path).convert("RGBA")
scale = img.width / vb_w

for pair in sys.argv[3:]:
    x, y = (float(v) for v in pair.split(","))
    r, g, b, a = img.getpixel((int(x * scale), int(y * scale)))
    print(f"({x:g},{y:g}) -> rgba({r},{g},{b},{a})")

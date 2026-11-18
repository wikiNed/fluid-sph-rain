import sys
from PIL import Image
import numpy as np

def blue_pct(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # 偏蓝：蓝通道明显高于红，且蓝绿接近（水体/青色）
    blueish = (b > r + 25) & (b >= g - 10) & (b > 60)
    return 100.0 * blueish.mean()

for p in sys.argv[1:]:
    print(f"{p}: blueish={blue_pct(p):.3f}%")

import sys
import numpy as np
from PIL import Image


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.int16)


def blueish(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return 100.0 * (((b > r + 25) & (b >= g - 10) & (b > 60)).mean())


a_path, b_path = sys.argv[1], sys.argv[2]
A, B = load(a_path), load(b_path)
D = np.abs(A - B).sum(axis=2)
mask = D > 30
print(f"{a_path}: blueish={blueish(A):.3f}%  meanRGB={A.reshape(-1,3).mean(axis=0).round(1)}")
print(f"{b_path}: blueish={blueish(B):.3f}%  meanRGB={B.reshape(-1,3).mean(axis=0).round(1)}")
print(f"diff pixels: {mask.sum()} ({100*mask.mean():.3f}%)")
if mask.any():
    ys, xs = np.nonzero(mask)
    print(f"diff bbox: x[{xs.min()},{xs.max()}] y[{ys.min()},{ys.max()}]")
    print(f"  A in diff: meanRGB={A[mask].mean(axis=0).round(1)} blueish={blueish(A)*0+100.0*((A[mask][:,2]>A[mask][:,0]+25)&(A[mask][:,2]>=A[mask][:,1]-10)&(A[mask][:,2]>60)).mean():.2f}%")
    print(f"  B in diff: meanRGB={B[mask].mean(axis=0).round(1)} blueish={100.0*((B[mask][:,2]>B[mask][:,0]+25)&(B[mask][:,2]>=B[mask][:,1]-10)&(B[mask][:,2]>60)).mean():.2f}%")

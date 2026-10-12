# Find the death bars on John Snow's Map 1 (1855), Wellcome Collection
# b28985266, image 58, and write them into trace.json beside this script.
#
#   python3 -I templates/which-pump/detect.py <the scan, map1.jpg>
#
# Needs numpy, scipy and Pillow. The scan is data: this reads its pixels
# and nothing else. What the eye decided is in trace.json's "reading": the
# pumps, the "PUMP" labels and marks that are not bars (left out), and the
# bars the detector missed (added). This script turns the rest into one
# point per bar.
#
# The method: Snow drew each death as a short black bar, about 25 by 5
# pixels here, stacked at the house. Ink darker than 95 of 255 is opened
# with a 4-pixel disc, which keeps the bars and drops the map's thinner
# lines, letters and the dashes of the boundary line. Bars touching one
# another form one stack; a stack's ink divided by one bar's ink (the
# median of single bars around Broad Street) is its number of deaths, and
# that many points are spread over its ink (k-means, fixed seed).
import json, os, statistics, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.cluster.vq import kmeans2

here = os.path.dirname(os.path.abspath(__file__))
trace_path = os.path.join(here, "trace.json")
trace = json.load(open(trace_path))
reading = trace["reading"]
G = np.asarray(Image.open(sys.argv[1]).convert("L")).astype(np.int16)
if list(G.shape[::-1]) != trace["scan"]["pixels"]:
    sys.exit(f"the scan is {G.shape[::-1]}, the reading was made on {trace['scan']['pixels']}")

# Each pump: the centre of the dark disc nearest the seed the eye placed.
pumps = []
for p in reading["pumps"]:
    x, y = p["seed"]
    for _ in range(3):
        ys, xs = np.mgrid[int(y) - 12:int(y) + 13, int(x) - 12:int(x) + 13]
        m = (G[ys, xs] < 110) & ((xs - x) ** 2 + (ys - y) ** 2 <= 144)
        x, y = float(xs[m].mean()), float(ys[m].mean())
    pumps.append({"name": p["name"], "x": round(x, 1), "y": round(y, 1)})

frame = reading["frame"]
def left_out(x, y):
    if not (frame[0] <= x <= frame[2] and frame[1] <= y <= frame[3]): return True
    if any(a <= x <= c and b <= y <= d for a, b, c, d in reading["not_bars"]): return True
    if any((x - p["x"]) ** 2 + (y - p["y"]) ** 2 < 16 ** 2 for p in pumps): return True
    return any(a - 3 <= x <= c + 3 and b - 3 <= y <= d + 3 for a, b, c, d in reading["labels"])

disc = np.ones((4, 4), bool); disc[0, 0] = disc[0, 3] = disc[3, 0] = disc[3, 3] = False
ink = ndi.binary_opening(G < 95, structure=disc)
lab, n = ndi.label(ink)
objs = ndi.find_objects(lab)
areas = ndi.sum(ink, lab, range(1, n + 1))
centres = ndi.center_of_mass(ink, lab, range(1, n + 1))
keep = np.zeros(n + 1, bool)
for i, (a, (cy, cx), sl) in enumerate(zip(areas, centres, objs), 1):
    extent = max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start)
    keep[i] = a >= 30 and extent <= 250 and not left_out(cx, cy)
bars_ink = keep[lab]
one_bar = statistics.median(a for i, (a, (cy, cx)) in enumerate(zip(areas, centres), 1)
                            if keep[i] and 1700 < cx < 2300 and 1400 < cy < 1800 and 60 <= a <= 160)
stacks, _ = ndi.label(ndi.binary_dilation(bars_ink, structure=np.ones((3, 3), bool)))
stacks = stacks * bars_ink
bars = []
stack_no = 0
for s, sl in enumerate(ndi.find_objects(stacks), 1):
    if sl is None: continue
    ys, xs = np.nonzero(stacks[sl] == s)
    k = round(len(xs) / one_bar)
    if k == 0: continue
    P = np.vstack([xs + sl[1].start, ys + sl[0].start]).T.astype(float)
    centres_k = [P.mean(axis=0)] if k == 1 else kmeans2(P, k, minit="++", seed=1854)[0]
    stack_no += 1
    bars += [[round(float(x), 1), round(float(y), 1), stack_no] for x, y in centres_k]
for x, y in reading["missed_bars"]:
    stack_no += 1
    bars.append([float(x), float(y), stack_no])

trace["detected"] = {
    "one_bar_pixels": float(one_bar),
    "pumps": pumps,
    "bars": sorted(bars, key=lambda b: (b[2], b[1], b[0])),
}
with open(trace_path, "w") as f:
    json.dump(trace, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(f"{len(bars)} bars in {stack_no} stacks; {len(pumps)} pumps; one bar is {one_bar} pixels of ink")

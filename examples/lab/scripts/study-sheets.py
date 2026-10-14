"""Technique study, step 2: blind rating sheets from .artifacts/study/cells.

fidelity-<object>-<angle>.png: one row per distance band, the supersampled TRUTH and
    every technique, shuffled and lettered (same letters for the whole object).
switch-<object>-<angle>-<band>.png: numbered pairs of two techniques at that size (same
    numbers for the whole object): how noticeable would a swap between them be?
key.json maps letters and pair numbers back; raters never see it. Also writes small
evidence images for the decision tool to evidence/.

    python3 scripts/study-sheets.py
"""
import json, pathlib, random
from PIL import Image, ImageDraw

root = pathlib.Path(__file__).resolve().parents[3] / ".artifacts" / "study"
OBJECTS = ["oak", "spruce", "rooibos", "grass", "boulder", "barrel", "car", "mansion", "streetlamp", "moonrock"]
ANGLES = ["ground", "elevated", "top", "any"]
BANDS = [("close", "close-up"), ("300", "300 px"), ("100", "100 px"), ("30", "30 px")]
TECHS = ["real", "lod", "baked", "hemi", "full"]
PAIRS = [("real", "lod"), ("real", "baked"), ("real", "hemi"), ("real", "full"), ("lod", "baked"), ("lod", "hemi"), ("lod", "full"), ("baked", "hemi"), ("baked", "full")]
random.seed(23)
(root / "sheets").mkdir(exist_ok=True)
(root / "evidence").mkdir(exist_ok=True)


def tiles(obj, angle, band, tech, size):
    """(truth, technique) tiles of a cell at about `size` px: small renders enlarged with
    nearest neighbour (honest pixels), large ones shrunk."""
    im = Image.open(root / "cells" / f"{obj}-{angle}-{band}-{tech}.png").convert("RGB")
    w = im.width // 3
    out = []
    for i in (0, 1):
        t = im.crop((i * w, 0, (i + 1) * w, im.height))
        if w < size:
            k = max(1, round(size / w))
            out.append(t.resize((w * k, w * k), Image.NEAREST))
        else:
            out.append(t.resize((size, size), Image.LANCZOS))
    return out


def sheet(title, rows):
    width = max(sum(t.width + 8 for _, t in r) for _, r in rows) + 8
    height = sum(max(t.height for _, t in r) + 40 for _, r in rows) + 40
    img = Image.new("RGB", (width, height), (24, 24, 24))
    d = ImageDraw.Draw(img)
    d.text((8, 8), title, fill=(235, 235, 235))
    y = 30
    for label, r in rows:
        d.text((8, y), label, fill=(180, 180, 180))
        y += 16
        x = 8
        for name, t in r:
            img.paste(t, (x, y))
            d.text((x + 4, y + 4), name, fill=(255, 255, 0))
            x += t.width + 8
        y += max(t.height for _, t in r) + 24
    return img


key = {}
for obj in OBJECTS:
    letters = [chr(65 + i) for i in range(len(TECHS))]
    order = TECHS[:]
    random.shuffle(order)
    pairs = PAIRS[:]
    random.shuffle(pairs)
    key[obj] = {"letters": dict(zip(letters, order)), "pairs": {str(i + 1): list(p) for i, p in enumerate(pairs)}}
    for angle in ANGLES:
        rows = []
        for band, label in BANDS:
            truth = tiles(obj, angle, band, TECHS[0], 290)[0]
            rows.append((label, [("TRUTH", truth)] + [(l, tiles(obj, angle, band, t, 290)[1]) for l, t in zip(letters, order)]))
            # Evidence for the tool: truth + every technique in fixed order, 160 px each.
            strip = Image.new("RGB", (160 * 6, 160), (26, 26, 25))
            strip.paste(tiles(obj, angle, band, TECHS[0], 160)[0].resize((160, 160)), (0, 0))
            for i, t in enumerate(TECHS):
                strip.paste(tiles(obj, angle, band, t, 160)[1].resize((160, 160)), ((i + 1) * 160, 0))
            strip.save(root / "evidence" / f"{obj}-{angle}-{band}.webp", quality=82)
            # Switch sheet: three rows of three pairs.
            pair_rows = []
            for k in range(0, len(pairs), 3):
                r = []
                for n, (a, b) in list(enumerate(pairs))[k:k + 3]:
                    first, second = (a, b) if random.random() < 0.5 else (b, a)
                    r += [(f"{n + 1}", tiles(obj, angle, band, first, 240)[1]), (f"{n + 1}'", tiles(obj, angle, band, second, 240)[1])]
                pair_rows.append((f"pairs {k + 1}-{min(k + 3, len(pairs))}", r))
            sheet(f"{obj}, {angle} view, {label} - SWITCH: if tile N were replaced by tile N' while the camera moves, how noticeable is the swap?", pair_rows).save(root / "sheets" / f"switch-{obj}-{angle}-{band}.png")
        sheet(f"{obj}, {angle} view - FIDELITY: how close is each letter to TRUTH at that size?", rows).save(root / "sheets" / f"fidelity-{obj}-{angle}.png")

(root / "key.json").write_text(json.dumps(key, indent=1))
print("sheets:", root / "sheets")

"""Blind sheets for the strategy study (.artifacts/strategy), one per use case and size.

fidelity-<row>-<px>.png: per subject, the supersampled TRUTH and every representation,
    shuffled and lettered (same letters for every size of a row).
switch-<row>-<px>.png: per subject, numbered pairs of two representations at the same
    size: how noticeable would swapping one for the other be?
key.json maps letters and pair numbers back; raters never see it.

    python3 scripts/strategy-sheets.py
"""
import itertools, json, pathlib, random
from PIL import Image, ImageDraw

root = pathlib.Path(__file__).resolve().parents[3] / ".artifacts" / "strategy"
index = json.loads((root / "index.json").read_text())
REPS = index["reps"]
PAIRS = [("real", "lod-simple"), ("real", "lod-baked"), ("real", "octa"), ("lod-simple", "octa"), ("lod-baked", "octa")]
random.seed(11)
(root / "sheets").mkdir(exist_ok=True)
key = {}


def tiles(row, subject, px, rep):
    """(truth, representation) tiles of a cell, scaled for viewing."""
    im = Image.open(root / "cells" / f"{row}-{subject}-{px}-{rep}.png").convert("RGB")
    w = im.width // 3
    truth, proxy = im.crop((0, 0, w, im.height)), im.crop((w, 0, 2 * w, im.height))
    # Enlarge small sizes with nearest neighbour (honest pixels); shrink only the largest.
    if w < 260:
        k = max(1, round(260 / w))
        size, method = (w * k, w * k), Image.NEAREST
    else:
        size, method = (min(w, 320),) * 2, Image.LANCZOS
    return truth.resize(size, method), proxy.resize(size, method)


def sheet(title, blocks):
    width = max(sum(t.width + 8 for _, t in tiles_) for _, tiles_ in blocks) + 8
    height = sum(max(t.height for _, t in tiles_) + 40 for _, tiles_ in blocks) + 44
    out = Image.new("RGB", (width, height), (24, 24, 24))
    d = ImageDraw.Draw(out)
    d.text((8, 8), title, fill=(235, 235, 235))
    y = 32
    for label, tiles_ in blocks:
        d.text((8, y), label, fill=(180, 180, 180))
        y += 16
        x = 8
        for name, im in tiles_:
            out.paste(im, (x, y))
            d.text((x + 4, y + 4), name, fill=(255, 255, 0))
            x += im.width + 8
        y += max(t.height for _, t in tiles_) + 24
    return out


for row in index["rows"]:
    rid = row["id"]
    letters = [chr(65 + i) for i in range(len(REPS))]
    order = REPS[:]
    random.shuffle(order)
    numbers = list(range(1, len(PAIRS) + 1))
    pairs = PAIRS[:]
    random.shuffle(pairs)
    key[rid] = {"letters": dict(zip(letters, order)), "pairs": {str(n): list(p) for n, p in zip(numbers, pairs)}}
    for px in index["sizes"]:
        fidelity, switch = [], []
        for subject in row["subjects"]:
            truth = tiles(rid, subject, px, REPS[0])[0]
            fidelity.append((f"{subject}, {px} px on screen", [("TRUTH", truth)] + [(l, tiles(rid, subject, px, r)[1]) for l, r in zip(letters, order)]))
            pair_tiles = []
            for n, (a, b) in zip(numbers, pairs):
                # Left/right order of each pair is random too.
                first, second = (a, b) if random.random() < 0.5 else (b, a)
                pair_tiles += [(f"{n}", tiles(rid, subject, px, first)[1]), (f"{n}'", tiles(rid, subject, px, second)[1])]
            switch.append((f"{subject}, {px} px on screen", pair_tiles))
        sheet(f"Use case {rid}: {row['title']} - FIDELITY at {px} px: how close is each letter to TRUTH?", fidelity).save(root / "sheets" / f"fidelity-{rid}-{px}.png")
        sheet(f"Use case {rid}: {row['title']} - SWITCH at {px} px: if tile N were replaced by tile N' in a game, how noticeable is the swap?", switch).save(root / "sheets" / f"switch-{rid}-{px}.png")

(root / "key.json").write_text(json.dumps(key, indent=1))
print("sheets:", root / "sheets")

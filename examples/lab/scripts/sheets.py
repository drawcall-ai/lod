"""Blind rating sheets from .artifacts/matrix/cells: one sheet per row (use case).

Each sheet shows, per subject and view, the real object (labelled REFERENCE) and every
kind's render, shuffled and labelled with letters. The letter-to-kind key goes to
key.json, which raters never see. Small renders are enlarged with nearest-neighbour so
pixels stay honest.

    python3 scripts/sheets.py [matrix-realistic]
"""
import json, random, pathlib, sys
from PIL import Image, ImageDraw

root = pathlib.Path(__file__).resolve().parents[3] / ".artifacts" / (sys.argv[1] if len(sys.argv) > 1 else "matrix")
index = json.loads((root / "index.json").read_text())
# Cells come from the file names (row-subject-vN-kind.png), so partial re-renders of
# some kinds never lose the others.
cells = []
for f in sorted((root / "cells").glob("*.png")):
    rid, subject, view, kind = f.stem.split("-", 3)
    cells.append({"row": rid, "subject": subject, "view": int(view[1:]), "kind": kind, "file": f"cells/{f.name}"})
rows = {r["id"]: r for r in index["rows"]}
random.seed(7)
key = {}
(root / "sheets").mkdir(exist_ok=True)

def tile(path, which):
    """Tile `which` of a compare image: 0 = real, 1 = proxy."""
    im = Image.open(root / path).convert("RGB")
    w = im.width // 3
    return im.crop((which * w, 0, (which + 1) * w, im.height))

for rid, row in rows.items():
    mine = [c for c in cells if c["row"] == rid]
    if not mine:
        continue
    kinds = sorted({c["kind"] for c in mine})
    letters = [chr(65 + i) for i in range(len(kinds))]
    shuffled = kinds[:]
    random.shuffle(shuffled)
    key[rid] = dict(zip(letters, shuffled))
    blocks = []
    for subject in row["subjects"]:
        for v in range(len(row["views"])):
            group = {c["kind"]: c for c in mine if c["subject"] == subject and c["view"] == v}
            if not group:
                continue
            ref = tile(next(iter(group.values()))["file"], 0)
            scale = max(1, round(260 / ref.width))
            size = (ref.width * scale, ref.height * scale)
            tiles = [("REFERENCE", ref.resize(size, Image.NEAREST))]
            for letter, kind in zip(letters, shuffled):
                if kind in group:
                    tiles.append((letter, tile(group[kind]["file"], 1).resize(size, Image.NEAREST)))
            blocks.append((f"{subject}, view {v + 1}", tiles, size))
    width = max(len(t) * (s[0] + 8) for _, t, s in blocks) + 8
    height = sum(s[1] + 40 for _, _, s in blocks) + 50
    sheet = Image.new("RGB", (width, height), (24, 24, 24))
    d = ImageDraw.Draw(sheet)
    mode = "SWITCHING: the proxy replaces the real object at this size" if row["mode"] == "switch" else "STANDALONE: the proxy is the only version ever shown"
    d.text((8, 8), f"Row {rid}: {row['title']}  ({mode})", fill=(235, 235, 235))
    y = 34
    for label, tiles, size in blocks:
        d.text((8, y), label, fill=(180, 180, 180))
        y += 16
        x = 8
        for name, im in tiles:
            sheet.paste(im, (x, y))
            d.text((x + 4, y + 4), name, fill=(255, 255, 0))
            x += size[0] + 8
        y += size[1] + 24
    sheet.save(root / "sheets" / f"row-{rid}.png")

(root / "key.json").write_text(json.dumps(key, indent=2))
print("sheets:", root / "sheets")

"""Joins blind ratings (ratings/r*.json), the letter key and perf.json into results.json,
one entry per row x kind, and renders an evidence strip per row (real object, then every
kind, first subject and view) into strips/.

    python3 scripts/merge.py [matrix-realistic]
"""
import json, pathlib, statistics, sys
from PIL import Image, ImageDraw

root = pathlib.Path(__file__).resolve().parents[3] / ".artifacts" / (sys.argv[1] if len(sys.argv) > 1 else "matrix")
index = json.loads((root / "index.json").read_text())
key = json.loads((root / "key.json").read_text())
ratings = [json.loads(f.read_text()) for f in sorted((root / "ratings").glob("r*.json"))]
perf = json.loads((root / "perf.json").read_text())
KINDS = ["octa-hemi", "octa-full", "ring", "cross", "sprite", "lod-simple", "lod-4px", "lod-16px", "lod-baked"]

results = []
for row in index["rows"]:
    rid = row["id"]
    for letter, kind in key[rid].items():
        given = [r[rid][letter] for r in ratings if letter in r.get(rid, {})]
        cells = [p for p in perf if p["row"] == rid and p["kind"] == kind]
        mean = lambda field: round(statistics.mean(c[field] for c in cells), 3) if cells else None
        results.append({
            "row": rid, "title": row["title"], "mode": "switch" if row["mode"] == "switch" else "still", "count": row["count"],
            "subjects": row["subjects"], "kind": kind,
            "score": round(statistics.mean(g["score"] for g in given), 2), "scores": [g["score"] for g in given], "notes": [g["note"] for g in given],
            "gpuMs": mean("gpuMs"), "memoryMB": mean("memoryMB"), "triangles": round(mean("triangles") or 0),
        })
(root / "results.json").write_text(json.dumps(results, indent=1))

# Evidence strips: 10 tiles of 160 px with a caption bar.
(root / "strips").mkdir(exist_ok=True)
names = {"octa-hemi": "Octa hemi", "octa-full": "Octa full", "ring": "Ring", "cross": "Cross", "sprite": "Sprite",
         "lod-simple": "LOD 1px", "lod-4px": "LOD 4px", "lod-16px": "LOD 16px", "lod-baked": "LOD baked"}
T = 160
for row in index["rows"]:
    subject = row["subjects"][0]
    strip = Image.new("RGB", (T * 10, T + 18), (26, 26, 25))
    d = ImageDraw.Draw(strip)
    for i, kind in enumerate(["real"] + KINDS):
        f = root / "cells" / f"{row['id']}-{subject}-v0-{kind if kind != 'real' else KINDS[0]}.png"
        im = Image.open(f).convert("RGB")
        w = im.width // 3
        tile = im.crop((0 if kind == "real" else w, 0, w if kind == "real" else 2 * w, im.height)).resize((T, T), Image.LANCZOS)
        strip.paste(tile, (i * T, 0))
        d.text((i * T + 6, T + 3), "Real" if kind == "real" else names[kind], fill=(220, 220, 214))
    strip.save(root / "strips" / f"row-{row['id']}.webp", quality=88)
print(len(results), "cells ->", root / "results.json")

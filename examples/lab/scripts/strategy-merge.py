"""Strategy study, step 5: adds GPU time (perf.json, mean over subjects) and memory to
every composed strategy (chains.json) and writes strategies.json for the decision page.

Memory is everything the strategy keeps resident, per asset:
- the real asset (geometry + textures) when the strategy draws it;
- simple LODs: their geometry, plus the source textures they reuse when the real asset
  is not already counted;
- baked LODs: geometry + their own textures, per level;
- the impostor atlas.
"compressed" assumes block-compressed textures (BC7/ASTC: 1/4 of RGBA8); geometry as is.

    python3 scripts/strategy-merge.py
"""
import json, pathlib, statistics

root = pathlib.Path(__file__).resolve().parents[3] / ".artifacts" / "strategy"
chains = json.loads((root / "chains.json").read_text())
perf = json.loads((root / "perf.json").read_text())
sources = json.loads((root / "sources.json").read_text())
metrics = json.loads((root / "metrics.json").read_text())
index = json.loads((root / "index.json").read_text())
rows = {r["id"]: r for r in index["rows"]}
ratings = [json.loads(f.read_text()) for f in sorted((root / "ratings").glob("r*.json"))]
key = json.loads((root / "key.json").read_text())
MIPS = 4 / 3


def metric(row, subject, px, rep):
    return next(m for m in metrics if m["row"] == row and m["subject"] == subject and m["px"] == px and m["rep"] == rep)


def memory(chain, subject):
    raw = compressed = 0.0
    kinds = {l["kind"] for l in chain["levels"]}
    src = sources[subject]
    if "real" in kinds:
        raw += src["totalMB"]
        compressed += src["totalMB"] - src["textureMB"] * 3 / 4
    elif "lod-simple" in kinds:
        raw += src["textureMB"]
        compressed += src["textureMB"] / 4
    for level in chain["levels"]:
        if level["kind"] == "lod-simple":
            mb = metric(chain["row"], subject, level["buildPx"], "lod-simple")["memoryMB"]
            raw += mb
            compressed += mb
        elif level["kind"] == "lod-baked":
            mb = metric(chain["row"], subject, level["buildPx"], "lod-baked")["memoryMB"]
            textures = 3 * level["texture"] ** 2 * 4 * MIPS / 2**20
            raw += mb
            compressed += mb - textures * 3 / 4
        elif level["kind"] == "octa":
            mb = metric(chain["row"], subject, index["sizes"][0], "octa")["memoryMB"]
            raw += mb
            compressed += mb / 4
    return raw, compressed


out = []
for c in chains:
    subjects = rows[c["row"]]["subjects"]
    runs = [p for p in perf if p["row"] == c["row"] and p["strategy"] == c["strategy"] and p["lod"] == c["lod"]]
    mems = [memory(c, s) for s in subjects]
    out.append(c | {
        "count": rows[c["row"]]["count"],
        "gpuMs": round(statistics.mean(p["gpuMs"] for p in runs), 2) if runs else None,
        "triangles": round(statistics.mean(p["triangles"] for p in runs)) if runs else None,
        "memoryMB": round(statistics.mean(m[0] for m in mems), 2),
        "memoryCompressedMB": round(statistics.mean(m[1] for m in mems), 2),
    })

# Per row, the raters' notes on each representation (for tooltips).
notes = {rid: {rep: [r["notes"][rid][letter] for r in ratings if rid in r.get("notes", {})] for letter, rep in key[rid]["letters"].items()} for rid in rows}
(root / "strategies.json").write_text(json.dumps({"strategies": out, "notes": notes, "rows": index["rows"], "sizes": index["sizes"]}, indent=1))
for c in out:
    print(f"{c['row']} {c['strategy']:<22} {(c['lod'] or ''):<10} worst {c['worst']:.1f}  {c['gpuMs'] or 0:7.2f} ms  {c['memoryMB']:6.1f} MB ({c['memoryCompressedMB']:5.1f} compressed)")

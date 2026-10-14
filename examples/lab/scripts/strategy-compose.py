"""Strategy study, step 3: composes strategies from the rated representations.

A strategy is a chain of representations from near to far (e.g. real -> LOD -> impostor).
For each use case it gets the switch points that use the cheaper (further) representation
as early as possible while every size the use case shows rates >= GOOD and every switch
rates >= GOOD; when no placement reaches that, the one with the best worst-case.

Reads strategy/ratings/r*.json (fidelity + switch scores) and key.json; writes
strategy/chains.json (per use case and strategy: active representation per size,
scores, switch scores and the levels for the GPU measurement).

    python3 scripts/strategy-compose.py
"""
import itertools, json, math, pathlib, statistics

root = pathlib.Path(__file__).resolve().parents[3] / ".artifacts" / "strategy"
index = json.loads((root / "index.json").read_text())
key = json.loads((root / "key.json").read_text())
ratings = [json.loads(f.read_text()) for f in sorted((root / "ratings").glob("r*.json"))]
GOOD = 7

STRATEGIES = {
    "impostor only": ["octa"],
    "impostor + real": ["real", "octa"],
    "impostor + LOD + real": ["real", "LOD", "octa"],
    "impostor + LOD": ["LOD", "octa"],
    "LOD only": ["LOD"],
    "LOD + real": ["real", "LOD"],
    "real only": ["real"],
}


def fidelity(rid, rep, px):
    letter = next(l for l, r in key[rid]["letters"].items() if r == rep)
    return statistics.mean(r["fidelity"][rid][str(px)][letter] for r in ratings)


def switch(rid, a, b, px):
    n = next(n for n, p in key[rid]["pairs"].items() if set(p) == {a, b})
    return statistics.mean(r["switch"][rid][str(px)][n] for r in ratings)


out = []
for row in index["rows"]:
    rid = row["id"]
    lo, hi = row["range"][1], row["range"][0]
    sizes = [s for s in index["sizes"] if lo <= s <= hi]  # near to far
    for name, template in STRATEGIES.items():
        for lod in (["lod-simple", "lod-baked"] if "LOD" in template else [None]):
            chain = [lod if r == "LOD" else r for r in template]
            best = None
            # Monotone placements that use every representation of the chain at least once.
            for cuts in itertools.combinations(range(1, len(sizes)), len(chain) - 1):
                bounds = (0,) + cuts + (len(sizes),)
                active = [chain[i] for i in range(len(chain)) for _ in range(bounds[i], bounds[i + 1])]
                scores = [fidelity(rid, r, s) for r, s in zip(active, sizes)]
                switches = [
                    {"from": active[i], "to": active[i + 1], "between": [sizes[i], sizes[i + 1]],
                     "score": (switch(rid, active[i], active[i + 1], sizes[i]) + switch(rid, active[i], active[i + 1], sizes[i + 1])) / 2}
                    for i in range(len(sizes) - 1) if active[i] != active[i + 1]
                ]
                worst = min(scores + [s["score"] for s in switches])
                # Prefer meeting GOOD, then the cheapest placement (further representations
                # as early as possible), then the best worst case.
                rank = (worst >= GOOD, sum(chain.index(a) for a in active) if worst >= GOOD else worst, worst)
                if best is None or rank > best["rank"]:
                    best = {"rank": rank, "active": active, "scores": scores, "switches": switches, "worst": worst}
            if best is None:
                continue  # more representations than sizes
            # GPU levels: switch halfway (geometrically) between measured sizes; mesh LODs get
            # one level per size, built for 1 px of error at that size.
            levels = []
            for i, (rep, px) in enumerate(zip(best["active"], sizes)):
                min_px = 0 if i == len(sizes) - 1 else px / math.sqrt(2)
                level = {"kind": rep, "minPx": min_px}
                if rep.startswith("lod"):
                    level |= {"buildPx": px, "texture": min(1024, max(64, 2 ** math.ceil(math.log2(px * 2))))}
                if levels and levels[-1]["kind"] == rep and not rep.startswith("lod"):
                    levels[-1]["minPx"] = min_px  # same representation: one level
                else:
                    levels.append(level)
            out.append({
                "row": rid, "title": row["title"], "strategy": name, "lod": lod, "chain": chain, "sizes": sizes,
                "active": best["active"], "scores": [round(s, 2) for s in best["scores"]],
                "switches": [s | {"score": round(s["score"], 2)} for s in best["switches"]],
                "worst": round(best["worst"], 2), "good": best["worst"] >= GOOD, "levels": levels,
            })

(root / "chains.json").write_text(json.dumps(out, indent=1))
for c in out:
    print(f"{c['row']} {c['strategy']:<22} {(c['lod'] or ''):<10} worst {c['worst']:.1f} {'ok ' if c['good'] else '   '} " + " ".join(f"{s}:{a[:6]}" for s, a in zip(c["sizes"], c["active"])))

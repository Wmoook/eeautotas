# The hand-built measures on the held-out judge routes (kind 3 rows of build.js's datasets): the reach field, the
# door-aware walk (lexicographic: the trophy walkable in this room first, else 5000 + the static walk), the truth.
#   python baselines.py /root/nnguide/v4
import sys, os, glob, json
import numpy as np
from analyze import yard
d = sys.argv[1]
feats, metas = [], []
for x in sorted(glob.glob(os.path.join(d, 'ds_*'))):
    J = json.load(open(os.path.join(x, 'grids.json')))
    feats.append(np.fromfile(os.path.join(x, 'feat.f32'), dtype=np.float32).reshape(-1, J['NFW']))
    metas.append(np.fromfile(os.path.join(x, 'meta.i32'), dtype=np.int32).reshape(-1, J['NM']))
    groups, NF, FEATS = J['groups'], J['NF'], J['features']
feat = np.concatenate(feats); meta = np.concatenate(metas)
fi = {n: i for i, n in enumerate(FEATS)}
print('| held out | measure | cov300 | cov1000 | covRelay | above% | longest trap |')
print('|---|---|---|---|---|---|---|')
for h in ['ip', 'octo', 'fv', 'ice', 'dotring', 'egg', 'sfox']:
    g = groups.index(h)
    ev = np.where((meta[:, 5] == g) & (meta[:, 4] == 3))[0]; ev = ev[np.argsort(meta[ev, 7])]
    if not len(ev): continue
    rc = feat[ev, NF].astype(np.float64)
    dw = np.where(feat[ev, fi['dw_none']] > 0, 5000 + np.expm1(feat[ev, fi['sw_log']]), np.expm1(feat[ev, fi['dw_log']]))
    reach_frac = float((feat[ev, fi['dw_none']] == 0).mean())
    print(f'| {h} | reach field | ' + ' | '.join(map(str, yard(np.where(rc >= 0, rc, np.nan)))) + ' |')
    print(f'| {h} | door-aware walk, lexicographic (trophy walkable in the room on {100 * reach_frac:.0f}% of the ticks) | ' + ' | '.join(map(str, yard(dw))) + ' |')

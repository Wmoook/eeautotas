# Trains the CNN of src/nnguide.js (PyTorch, on the rented GPU) on the datasets of build.js (--data: a folder of ds_*),
# leave-one-level-family-out, and evaluates it with the judge's yardstick (src/out/judge/evalm.js, traps.js) on the
# held-out family's judge route, the excursion pairs and the failed attempts. Writes <tag>_<hold>.json (the weights
# src/nnguide.js load()s), <tag>_<hold>_series.npy (truth, model, reach, door-aware walk along the route, tiles),
# <tag>_<hold>_check.json, <tag>_results.json.
#   CUDA_VISIBLE_DEVICES=7 python train.py --data=<dir> --holdout=ip,octo,fv,ice,dotring [--all=1] [--steps=6000]
import argparse, glob, json, math, os, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='/root/nnguide')
ap.add_argument('--holdout', default='ip,octo,fv,ice,dotring')
ap.add_argument('--all', type=int, default=0)          # also a model on every group (for the search)
ap.add_argument('--steps', type=int, default=6000)
ap.add_argument('--bs', type=int, default=2048)
ap.add_argument('--lr', type=float, default=2e-3)
ap.add_argument('--wex', type=float, default=1.0)      # excursion lower-bound hinge weight
ap.add_argument('--wpair', type=float, default=1.0)    # excursion vs twin ranking weight
ap.add_argument('--margin', type=float, default=0.05)  # (normalized units)
ap.add_argument('--wrank', type=float, default=0.0)    # within-level pairwise ranking of route states (any two states of one group)
ap.add_argument('--wreg', type=float, default=1.0)     # the regression on log ticks to go
ap.add_argument('--wlocal', type=float, default=0.0)   # differences along a route: (p_i - p_j) ~ (y_i - y_j) for two states of one route
ap.add_argument('--flip', type=int, default=0)         # augmentation: mirror half the training samples left <-> right
ap.add_argument('--E', type=int, default=8)
ap.add_argument('--ch', default='16,32,32')
ap.add_argument('--hid', default='128,64')
ap.add_argument('--nofeat', default='')                # feature names to zero (ablations)
ap.add_argument('--nopatch', type=int, default=0)
ap.add_argument('--tag', default='m')
ap.add_argument('--out', default='/root/nnguide/models')
ap.add_argument('--seed', type=int, default=1)
ap.add_argument('--gexp', type=float, default=0.5)     # group sampling ~ n_g^gexp
ap.add_argument('--keep', type=float, default=1.0)     # the data question: train on this share of the other groups only (a random draw, --keepSeed)
ap.add_argument('--keepSeed', type=int, default=1)
a = ap.parse_args()
torch.manual_seed(a.seed); np.random.seed(a.seed)
dev = 'cuda'
os.makedirs(a.out, exist_ok=True)

# ---------------------------------------------------------------- data
dirs = sorted(glob.glob(os.path.join(a.data, 'ds_*')))
feats, metas, g8s, w16s, goff, gWp, glv = [], [], [], [], [], [], []
gbase = 0; obase = 0; groups = None
for d in dirs:
    J = json.load(open(os.path.join(d, 'grids.json')))
    groups = groups or J['groups']
    assert groups == J['groups']
    f = np.fromfile(os.path.join(d, 'feat.f32'), dtype=np.float32).reshape(-1, J['NFW'])
    m = np.fromfile(os.path.join(d, 'meta.i32'), dtype=np.int32).reshape(-1, J['NM']).copy()
    g8 = np.fromfile(os.path.join(d, 'grids.u8'), dtype=np.uint8)
    w16 = np.fromfile(os.path.join(d, 'walks.u16'), dtype=np.uint16)
    m[:, 0] += gbase
    for gr in J['grids']:
        goff.append(gr['off'] + obase); gWp.append(gr['Wp']); glv.append(gr['lv'])
    gbase += len(J['grids']); obase += len(g8)
    feats.append(f); metas.append(m); g8s.append(g8); w16s.append(w16)
    NF, PAD, P, FEATS, CLASSES = J['NF'], J['PAD'], J['P'], J['features'], J['classes']
feat = np.concatenate(feats); meta = np.concatenate(metas)
print(f'{len(dirs)} datasets, {len(feat)} samples, {gbase} grids, NF {NF}', flush=True)
G8 = torch.from_numpy(np.concatenate(g8s)).to(dev)
W16 = torch.from_numpy(np.concatenate(w16s).astype(np.int32)).to(dev)
GOFF = torch.tensor(goff, dtype=torch.int64, device=dev); GWP = torch.tensor(gWp, dtype=torch.int64, device=dev)
X = torch.from_numpy(feat[:, :NF]).to(dev)
RC = feat[:, NF].astype(np.float64)
M = torch.from_numpy(meta.astype(np.int64)).to(dev)
KIND = meta[:, 4]; GRP = meta[:, 5]; TTG = meta[:, 3].astype(np.float64); TT = meta[:, 7]
FAR = 65535
dy = torch.arange(P, device=dev); dx = torch.arange(P, device=dev)

def patches(idx):
    g = M[idx, 0]; tx = M[idx, 1]; ty = M[idx, 2]
    wp = GWP[g]; base = GOFF[g] + ty * wp + tx
    ii = base[:, None, None] + dy[None, :, None] * wp[:, None, None] + dx[None, None, :]
    cls = G8[ii].long()
    w = W16[ii]
    c = W16[GOFF[g] + (ty + PAD) * wp + tx + PAD][:, None, None]
    rel = torch.where(c == FAR, torch.zeros_like(w, dtype=torch.float32),
                      torch.where(w == FAR, torch.full_like(w, 3, dtype=torch.float32), ((w - c).float() / 8).clamp(-2, 2)))
    return cls, rel

# ---------------------------------------------------------------- model (mirrors src/nnguide.js)
NCLS = len(CLASSES)
chs = [int(x) for x in a.ch.split(',')]; hid = [int(x) for x in a.hid.split(',')]
class Net(nn.Module):
    def __init__(s):
        super().__init__()
        s.emb = nn.Embedding(NCLS, a.E)
        cin = a.E + 1; s.convs = nn.ModuleList()
        for c in chs: s.convs.append(nn.Conv2d(cin, c, 3, 2, 1)); cin = c
        side = P >> len(chs)
        dims = [chs[-1] * side * side + NF] + hid + [1]
        s.fc = nn.ModuleList([nn.Linear(dims[i], dims[i + 1]) for i in range(len(dims) - 1)])
    def forward(s, cls, rel, x):
        h = torch.cat([s.emb(cls).permute(0, 3, 1, 2), rel[:, None]], 1)
        if a.nopatch: h = h * 0
        for c in s.convs: h = Fn.relu(c(h))
        h = torch.cat([h.flatten(1), x], 1)
        for i, l in enumerate(s.fc):
            h = l(h)
            if i < len(s.fc) - 1: h = Fn.relu(h)
        return h[:, 0]

# ---------------------------------------------------------------- the yardstick (traps.js / evalm.js)
def trap_stats(f, tol=0.5):
    m = math.inf; above = 0; cnt = 0; traps = []; cur = None
    for t in range(len(f)):
        v = f[t]
        if v != v: continue
        cnt += 1
        if v > m + tol:
            above += 1
            if cur is None: cur = {'a': t, 'b': t, 'height': v - m, 'base': m}
            cur['b'] = t
            if v - cur['base'] > cur['height']: cur['height'] = v - cur['base']
        elif cur is not None and v <= cur['base'] + tol:
            cur['ticks'] = cur['b'] - cur['a'] + 1; traps.append(cur); cur = None
        if v < m: m = v
    if cur is not None: cur['ticks'] = cur['b'] - cur['a'] + 1; traps.append(cur)
    return traps, above, cnt
def yard(f):
    f = [float(v) for v in f]
    n = len(f); traps, above, cnt = trap_stats(f)
    lst = sorted(traps, key=lambda t: t['a'])
    def cov(p):
        for t in lst:
            if p(t): return round(t['a'] / n, 3)
        return 1.0
    lg = max(traps, key=lambda t: t['ticks']) if traps else None
    return {'cov300': cov(lambda t: t['ticks'] > 300), 'cov1000': cov(lambda t: t['ticks'] > 1000),
            'covRelay': cov(lambda t: t['ticks'] > 400 or t['height'] > 30 + 0.1 * t['base']),
            'above': round(100 * above / max(1, cnt), 1), 'longest': f"{lg['ticks']}t +{lg['height']:.0f} @{lg['a']}" if lg else '-'}

# ---------------------------------------------------------------- normalization
fi = {n: i for i, n in enumerate(FEATS)}
zero = [fi[n] for n in a.nofeat.split(',') if n]
def train_one(hold):
    """hold: a group name (left out) or None (every group)"""
    hid_g = groups.index(hold) if hold else -1
    trn = (GRP != hid_g) & (KIND != 3) & (KIND != 2)
    if a.keep < 1:
        others = [g for g in range(len(groups)) if g != hid_g and ((GRP == g) & trn).any()]
        rs = np.random.RandomState(a.keepSeed + max(hid_g, 0))
        kept = rs.choice(others, max(1, int(round(a.keep * len(others)))), replace=False)
        trn &= np.isin(GRP, kept)
        print(f'  [{hold or "all"}] training groups kept: {sorted(groups[g] for g in kept)}', flush=True)
    rt = np.where(trn & ((KIND == 0) | (KIND == 4)))[0]
    ex = np.where(trn & (KIND == 1))[0]
    ex = ex[(ex + 1 < len(KIND))]; ex = ex[KIND[ex + 1] == 4]
    fm = feat[np.concatenate([rt, ex]), :NF].mean(0); fs = feat[np.concatenate([rt, ex]), :NF].std(0); fs[fs < 1e-6] = 1
    y = np.log1p(np.maximum(TTG, 0)); mu = float(y[rt].mean()); sd = float(y[rt].std())
    good = rt[(RC[rt] > 2) & (TTG[rt] > 0)]
    scale = float(np.median(TTG[good] / RC[good]))
    FM = torch.tensor(fm, device=dev); FS = torch.tensor(fs, device=dev)
    Y = torch.tensor((y - mu) / sd, dtype=torch.float32, device=dev)
    FLIPF = torch.tensor([fi[n] for n in ['fx', 'vx', 'mox', 'morx', 'tro_dx']], device=dev)
    CMAP = torch.arange(NCLS, device=dev)
    for u, v in [('arrow_left', 'arrow_right'), ('boost_left', 'boost_right')]:
        CMAP[CLASSES.index(u)] = CLASSES.index(v); CMAP[CLASSES.index(v)] = CLASSES.index(u)
    def xn(idx, fl=None):
        x = X[idx]
        if fl is not None:
            x = x.clone(); x[:, FLIPF] = torch.where(fl[:, None], -x[:, FLIPF], x[:, FLIPF])
        x = (x - FM) / FS
        if zero: x[:, zero] = 0
        return x
    # group-balanced sampling
    def probs(ix):
        cnt = np.bincount(GRP[ix], minlength=len(groups)).astype(np.float64)
        p = (cnt[GRP[ix]] ** (a.gexp - 1)); return torch.tensor(p / p.sum(), device=dev)
    prt, pex = probs(rt), probs(ex)
    RT = torch.tensor(rt, device=dev); EX = torch.tensor(ex, device=dev)
    # route rows by group (for the ranking pairs: a second state of the same group)
    order = rt[np.argsort(GRP[rt], kind='stable')]
    gcnt = np.bincount(GRP[order], minlength=len(groups)); gst = np.concatenate([[0], np.cumsum(gcnt)[:-1]])
    ORD = torch.tensor(order, device=dev); GST = torch.tensor(gst, device=dev); GCN = torch.tensor(gcnt, device=dev)
    GRPT = torch.tensor(GRP, device=dev)
    # the route of each row (its level and route index): a local pair is a row and one up to 8 rows later on the same route
    lvid = {lv: i for i, lv in enumerate(sorted(set(glv)))}
    glvi = np.array([lvid[x] for x in glv])
    RKEY = glvi[meta[:, 0]].astype(np.int64) * 1000000 + meta[:, 6]
    okl = []
    for m_ in range(1, 9):
        a_ = rt[rt + m_ < len(KIND)]
        b_ = a_ + m_
        good_ = (KIND[b_] == 0) & (KIND[a_] == 0) & (RKEY[a_] == RKEY[b_]) & (TT[b_] > TT[a_])
        okl.append(np.stack([a_[good_], b_[good_]], 1))
    LP = torch.tensor(np.concatenate(okl), device=dev)
    print(f'  local pairs {len(LP)}', flush=True)
    net = Net().to(dev)
    nparam = sum(p.numel() for p in net.parameters())
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    sch = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.steps, pct_start=0.05)
    t0 = time.time()
    for step in range(a.steps):
        i = RT[torch.multinomial(prt, a.bs, replacement=True)]
        j = EX[torch.multinomial(pex, a.bs // 2, replacement=True)] if len(ex) else RT[:0]
        k2 = RT[:0]
        if a.wrank > 0:
            gi = GRPT[i]
            k2 = ORD[GST[gi] + (torch.rand(len(i), device=dev) * GCN[gi]).long().clamp(max=GCN[gi] - 1)]
        idx = torch.cat([i, j, j + 1, k2])
        cls, rel = patches(idx)
        fl = None
        if a.flip:
            # a mirrored sample: an excursion and its twin together
            fl = torch.rand(len(idx), device=dev) < 0.5
            n1_, n2_ = len(i), len(i) + len(j)
            fl[n2_:n2_ + len(j)] = fl[n1_:n2_]
            cls = torch.where(fl[:, None, None], CMAP[cls].flip(2), cls)
            rel = torch.where(fl[:, None, None], rel.flip(2), rel)
        p = net(cls, rel, xn(idx, fl))
        n1, n2 = len(i), len(i) + len(j)
        pr, pe, pt, pk = p[:n1], p[n1:n2], p[n2:n2 + len(j)], p[n2 + len(j):]
        loss = a.wreg * Fn.smooth_l1_loss(pr, Y[i], beta=0.1)
        if a.wlocal > 0:
            q = LP[torch.randint(len(LP), (a.bs // 2,), device=dev)]
            cls2, rel2 = patches(q.flatten())
            p2 = net(cls2, rel2, xn(q.flatten())).view(-1, 2)
            loss = loss + a.wlocal * Fn.smooth_l1_loss(p2[:, 0] - p2[:, 1], Y[q[:, 0]] - Y[q[:, 1]], beta=0.05) * 10
        if a.wrank > 0:
            dyk = Y[i] - Y[k2]
            w = (dyk.abs() > 0.02).float()
            loss = loss + a.wrank * (w * Fn.softplus(-(pr - pk) * torch.sign(dyk) * 4)).sum() / w.sum().clamp(min=1)
        if len(j):
            loss = loss + a.wex * Fn.relu(Y[j] - pe).pow(2).mean() + a.wpair * Fn.relu(pt + a.margin - pe).mean()
        opt.zero_grad(); loss.backward(); opt.step(); sch.step()
        if step % 1000 == 0 or step == a.steps - 1: print(f'  [{hold or "all"}] step {step} loss {loss.item():.4f} {time.time() - t0:.0f}s', flush=True)
    net.eval()
    def predict(idx):
        out = []
        with torch.no_grad():
            for k in range(0, len(idx), 16384):
                b = torch.tensor(idx[k:k + 16384], device=dev)
                cls, rel = patches(b)
                out.append(net(cls, rel, xn(b)).double().cpu().numpy())
        return np.concatenate(out) * sd + mu if out else np.zeros(0)
    res = {'hold': hold, 'params': nparam, 'scale': scale, 'sec': round(time.time() - t0)}
    if hold:
        ev = np.where((GRP == hid_g) & (KIND == 3))[0]; ev = ev[np.argsort(TT[ev])]
        pl = predict(ev)
        model = np.expm1(np.maximum(pl, 0)) / scale
        reach = np.where(RC[ev] >= 0, RC[ev], np.nan)
        dwl = feat[ev, fi['dw_log']]; dwn = feat[ev, fi['dw_none']]
        # the door-aware walk, lexicographic: trophy walkable in this room first (else 5000 + the static walk)
        dw = np.where(dwn > 0, 5000 + np.expm1(feat[ev, fi['sw_log']]), np.expm1(dwl))
        truth = TTG[ev] / scale
        res['n'] = len(ev)
        res['model'] = yard(model); res['reach'] = yard(reach); res['doorwalk'] = yard(dw); res['truth'] = yard(truth)
        # A (the judge's series) when there is one
        an = {'ip': 'infinity-pain-kiraninja-pwe7_ow', 'octo': 'octorage-oc-08e189_ow', 'fv': 'forgotten-veil-d30867_ow'}.get(hold)
        af = os.path.join(a.data, 'judge', f'{an}.series.json') if an else None
        if af and os.path.exists(af):
            A = json.load(open(af))['neu'][:len(ev)]
            res['A'] = yard([np.nan if v is None else v for v in A])
        # the log-space fit along the route and the rank correlation
        yl = np.log1p(TTG[ev]); res['mae_log'] = float(np.abs(pl - yl).mean())
        rk = lambda v: np.argsort(np.argsort(v))
        res['spearman_model'] = float(np.corrcoef(rk(pl), rk(yl))[0, 1])
        ok = ~np.isnan(reach); res['spearman_reach'] = float(np.corrcoef(rk(reach[ok]), rk(yl[ok]))[0, 1])
        # excursion pairs: the excursion should cost more than its twin (the route state at the same tick)
        exh = np.where((GRP == hid_g) & (KIND == 1))[0]; exh = exh[exh + 1 < len(KIND)]; exh = exh[KIND[exh + 1] == 4]
        if len(exh):
            pe = predict(exh); pt = predict(exh + 1)
            res['pairs'] = int(len(exh))
            res['pair_model'] = float(((pe > pt) + 0.5 * (pe == pt)).mean())
            re, rt2 = RC[exh], RC[exh + 1]
            re = np.where(re < 0, 1e9, re); rt2 = np.where(rt2 < 0, 1e9, rt2)
            res['pair_reach'] = float(((re > rt2) + 0.5 * (re == rt2)).mean())
            de = np.where(feat[exh, fi['dw_none']] > 0, 1e9, feat[exh, fi['dw_log']]); dt = np.where(feat[exh + 1, fi['dw_none']] > 0, 1e9, feat[exh + 1, fi['dw_log']])
            res['pair_doorwalk'] = float(((de > dt) + 0.5 * (de == dt)).mean())
        # attempts that never finished (ice, dot ring): how they rank against the route (share of attempt states the
        # model / reach puts BELOW the route's median cost = looks promising)
        at = np.where((GRP == hid_g) & (KIND == 2))[0]
        if len(at):
            pa = predict(at)
            res['attempts'] = int(len(at))
            res['att_below_median_model'] = float((pa < np.median(pl)).mean())
            ra = np.where(RC[at] < 0, 1e9, RC[at]); res['att_below_median_reach'] = float((ra < np.nanmedian(reach)).mean())
        np.save(os.path.join(a.out, f'{a.tag}_{hold}_series.npy'), np.stack([truth, model, reach, dw]))
    # export for src/nnguide.js
    sdict = {k: v.detach().cpu().numpy().tolist() for k, v in net.state_dict().items()}
    mj = {'classes': CLASSES, 'features': FEATS, 'emb': sdict['emb.weight'],
          'convs': [{'w': sdict[f'convs.{k}.weight'], 'b': sdict[f'convs.{k}.bias']} for k in range(len(chs))],
          'fc': [{'w': sdict[f'fc.{k}.weight'], 'b': sdict[f'fc.{k}.bias']} for k in range(len(hid) + 1)],
          'featMean': fm.tolist(), 'featStd': fs.tolist(), 'zero': zero, 'outMean': mu, 'outStd': sd, 'scale': scale, 'hold': hold,
          'args': vars(a), 'params': nparam}
    json.dump(mj, open(os.path.join(a.out, f'{a.tag}_{hold or "all"}.json'), 'w'))
    # a few samples to check the JS inference against
    chk = np.random.RandomState(0).choice(rt, 32, replace=False)
    json.dump({'idx': chk.tolist(), 'pred': predict(chk).tolist()}, open(os.path.join(a.out, f'{a.tag}_{hold or "all"}_check.json'), 'w'))
    return res

results = []
for h in [x for x in a.holdout.split(',') if x]:
    r = train_one(h); results.append(r)
    print(json.dumps(r), flush=True)
if a.all:
    r = train_one(None); results.append(r); print(json.dumps(r), flush=True)
json.dump(results, open(os.path.join(a.out, f'{a.tag}_results.json'), 'w'), indent=1)
print('\n| held out | measure | cov300 | cov1000 | covRelay | above% | longest trap |')
print('|---|---|---|---|---|---|---|')
for r in results:
    if not r['hold']: continue
    for k in ['reach', 'A', 'doorwalk', 'model', 'truth']:
        if k in r: y = r[k]; print(f"| {r['hold']} | {k} | {y['cov300']} | {y['cov1000']} | {y['covRelay']} | {y['above']} | {y['longest']} |")
print('\n| held out | spearman model / reach | pair acc model / reach / doorwalk | attempts below median model / reach |')
for r in results:
    if not r['hold']: continue
    print(f"| {r['hold']} | {r['spearman_model']:.3f} / {r['spearman_reach']:.3f} | {r.get('pair_model', float('nan')):.3f} / {r.get('pair_reach', float('nan')):.3f} / {r.get('pair_doorwalk', float('nan')):.3f} | {r.get('att_below_median_model', float('nan'))} / {r.get('att_below_median_reach', float('nan'))} |")

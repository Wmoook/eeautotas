# The structured model of src/nnguide.js (kind "room"). Within a room (the door state and the discrete state) the cost
# is a positive combination of the reach cost and the door-aware walk, so it is as smooth as they are; across rooms a
# learned offset:
#   cost(tiles) = softplus(a(room)) * reach + softplus(b(room)) * doorwalk + softplus(g(room)) * 100
# a, b, g = a small MLP of the room's features only (no position, no patch). Trained leave-one-group-out on the route
# states (log(1 + cost) vs log(1 + ticks to go / scale)) and the excursion pairs (an excursion should cost more than its
# twin). Evaluated like train.py (the yardstick along the judge routes, the excursion pairs).
#   CUDA_VISIBLE_DEVICES=7 python train5.py --data=<dir> --holdout=ip,octo,fv,ice,dotring [--wpair=3] [--seed=1] [--all=1] --tag=v5
import argparse, glob, json, math, os, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import yard

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='/root/nnguide/v4')
ap.add_argument('--holdout', default='ip,octo,fv,ice,dotring')
ap.add_argument('--all', type=int, default=0)
ap.add_argument('--steps', type=int, default=3000)
ap.add_argument('--bs', type=int, default=8192)
ap.add_argument('--lr', type=float, default=3e-3)
ap.add_argument('--wpair', type=float, default=1.0)
ap.add_argument('--hid', type=int, default=64)
ap.add_argument('--seed', type=int, default=1)
ap.add_argument('--tag', default='v5')
ap.add_argument('--out', default='/root/nnguide/models')
ap.add_argument('--roomf', default='walk_mode,dw_none,multijump,fly,flipgrav,jumpboost,speedboost,lowgrav,protect,timed_killer,god,keys,switches,coins,bluecoins,crown,team,terr,shut,size')
a = ap.parse_args()
torch.manual_seed(a.seed); np.random.seed(a.seed)
dev = 'cuda'
dirs = sorted(glob.glob(os.path.join(a.data, 'ds_*')))
feats, metas = [], []
for d in dirs:
    J = json.load(open(os.path.join(d, 'grids.json')))
    feats.append(np.fromfile(os.path.join(d, 'feat.f32'), dtype=np.float32).reshape(-1, J['NFW']))
    metas.append(np.fromfile(os.path.join(d, 'meta.i32'), dtype=np.int32).reshape(-1, J['NM']))
    groups, NF, FEATS = J['groups'], J['NF'], J['features']
feat = np.concatenate(feats); meta = np.concatenate(metas)
fi = {n: i for i, n in enumerate(FEATS)}
KIND = meta[:, 4]; GRP = meta[:, 5]; TTG = meta[:, 3].astype(np.float64); TT = meta[:, 7]
RC = feat[:, NF].astype(np.float64)
reach = np.where(RC >= 0, RC, 0.0)
dw = np.where(feat[:, fi['dw_none']] > 0, 0.0, np.expm1(feat[:, fi['dw_log']]))
rf = [fi[n] for n in a.roomf.split(',')]
R = feat[:, rf]
print(f'{len(feat)} samples, room features {len(rf)}', flush=True)

class Net(nn.Module):
    def __init__(s):
        super().__init__()
        s.f = nn.Sequential(nn.Linear(len(rf), a.hid), nn.ReLU(), nn.Linear(a.hid, a.hid), nn.ReLU(), nn.Linear(a.hid, 3))
    def forward(s, r, rc, w):
        o = s.f(r)
        return Fn.softplus(o[:, 0]) * rc + Fn.softplus(o[:, 1]) * w + Fn.softplus(o[:, 2]) * 100

def run(hold):
    hid_g = groups.index(hold) if hold else -1
    trn = (GRP != hid_g) & (KIND != 3) & (KIND != 2)
    rt = np.where(trn & ((KIND == 0) | (KIND == 4)))[0]
    ex = np.where(trn & (KIND == 1))[0]; ex = ex[ex + 1 < len(KIND)]; ex = ex[KIND[ex + 1] == 4]
    good = rt[(RC[rt] > 2) & (TTG[rt] > 0)]
    scale = float(np.median(TTG[good] / RC[good]))
    rm = R[np.concatenate([rt, ex])].mean(0); rs = R[np.concatenate([rt, ex])].std(0); rs[rs < 1e-6] = 1
    T = lambda v: torch.tensor(v, dtype=torch.float32, device=dev)
    RN = T((R - rm) / rs); RCt = T(reach); DWt = T(dw); Y = T(np.log1p(np.maximum(TTG, 0) / scale))
    cnt = np.bincount(GRP[rt], minlength=len(groups)).astype(np.float64); p = cnt[GRP[rt]] ** -0.5; prt = torch.tensor(p / p.sum(), device=dev)
    cnt = np.bincount(GRP[ex], minlength=len(groups)).astype(np.float64); p = cnt[GRP[ex]] ** -0.5; pex = torch.tensor(p / p.sum(), device=dev)
    RT = torch.tensor(rt, device=dev); EX = torch.tensor(ex, device=dev)
    net = Net().to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    sch = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.steps, pct_start=0.05)
    f = lambda idx: net(RN[idx], RCt[idx], DWt[idx])
    t0 = time.time()
    for step in range(a.steps):
        i = RT[torch.multinomial(prt, a.bs, replacement=True)]
        j = EX[torch.multinomial(pex, a.bs // 2, replacement=True)]
        loss = Fn.smooth_l1_loss(torch.log1p(f(i)), Y[i], beta=0.1)
        pe, pt = torch.log1p(f(j)), torch.log1p(f(j + 1))
        loss = loss + a.wpair * Fn.relu(pt + 0.01 - pe).mean()
        opt.zero_grad(); loss.backward(); opt.step(); sch.step()
    net.eval()
    res = {'hold': hold, 'scale': scale, 'sec': round(time.time() - t0)}
    with torch.no_grad():
        if hold:
            ev = np.where((GRP == hid_g) & (KIND == 3))[0]; ev = ev[np.argsort(TT[ev])]
            m = f(torch.tensor(ev, device=dev)).double().cpu().numpy()
            res['model'] = yard(m); res['reach'] = yard(np.where(RC[ev] >= 0, RC[ev], np.nan))
            yl = np.log1p(TTG[ev]); rk = lambda v: np.argsort(np.argsort(v))
            res['spearman_model'] = float(np.corrcoef(rk(m), rk(yl))[0, 1])
            exh = np.where((GRP == hid_g) & (KIND == 1))[0]; exh = exh[exh + 1 < len(KIND)]; exh = exh[KIND[exh + 1] == 4]
            if len(exh):
                pe = f(torch.tensor(exh, device=dev)).cpu().numpy(); pt = f(torch.tensor(exh + 1, device=dev)).cpu().numpy()
                res['pair_model'] = float(((pe > pt) + 0.5 * (pe == pt)).mean())
                re, r2 = RC[exh], RC[exh + 1]; re = np.where(re < 0, 1e9, re); r2 = np.where(r2 < 0, 1e9, r2)
                res['pair_reach'] = float(((re > r2) + 0.5 * (re == r2)).mean())
            np.save(os.path.join(a.out, f'{a.tag}_{hold}_series.npy'), np.stack([TTG[ev] / scale, m, np.where(RC[ev] >= 0, RC[ev], np.nan), np.where(feat[ev, fi['dw_none']] > 0, np.nan, dw[ev])]))
    sd = {k: v.detach().cpu().numpy().tolist() for k, v in net.state_dict().items()}
    json.dump({'kind': 'room', 'features': FEATS, 'roomf': a.roomf.split(','), 'rmean': rm.tolist(), 'rstd': rs.tolist(), 'layers': [[sd[f'f.{k}.weight'], sd[f'f.{k}.bias']] for k in (0, 2, 4)],
               'scale': scale, 'hold': hold}, open(os.path.join(a.out, f'{a.tag}_{hold or "all"}.json'), 'w'))
    return res
out = []
for h in [x for x in a.holdout.split(',') if x] + ([None] if a.all else []):
    r = run(h); out.append(r); print(json.dumps(r), flush=True)
json.dump(out, open(os.path.join(a.out, f'{a.tag}_results.json'), 'w'), indent=1)

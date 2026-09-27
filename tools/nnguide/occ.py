# The "learned guide line" (research): a fully convolutional network reads a whole level (the classes, the walks to
# the trophy, the start and the trophy) and marks the tiles a finishing route passes, trained leave-one-level-family-
# out on occ.js's data. On the held-out family's judge route: how well it ranks the route's tiles (AUC over the open
# tiles) against the geometric corridor (the walk from the start + the walk to the trophy, lowest on the shortest walk),
# and the guide field it makes (a walk from the trophy whose step onto a tile costs 1 + beta x (1 - p)) along the route
# with the judge's yardstick, next to the plain walk, the reach field and the route's own tiles (the line oracle).
#   CUDA_VISIBLE_DEVICES=7 python occ.py --data=occ.jsonl --holdout=ip,octo,fv,ice,dotring [--series=<models dir>/v6] [--out=<dir>]
import argparse, base64, collections, heapq, json, math, os, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='/root/nnguide/fin/occ.jsonl')
ap.add_argument('--holdout', default='ip,octo,fv,ice,dotring')
ap.add_argument('--steps', type=int, default=3000)
ap.add_argument('--crop', type=int, default=96)
ap.add_argument('--bs', type=int, default=16)
ap.add_argument('--lr', type=float, default=2e-3)
ap.add_argument('--ch', type=int, default=32)
ap.add_argument('--dil', default='1,2,4,8,16,32')
ap.add_argument('--betas', default='2,8')
ap.add_argument('--series', default='/root/nnguide/models/v6')   # <prefix>_<hold>_series.npy: truth, model, reach, door-aware walk per tick
ap.add_argument('--out', default='/root/nnguide/fin/occ')
ap.add_argument('--seed', type=int, default=1)
a = ap.parse_args()
torch.manual_seed(a.seed); np.random.seed(a.seed)
dev = 'cuda'
os.makedirs(a.out, exist_ok=True)
CLASSES = ['out', 'empty', 'solid', 'door_shut', 'door_open', 'oneway', 'half', 'arrow_left', 'arrow_up', 'arrow_right', 'arrow_down', 'dot',
           'boost_left', 'boost_right', 'boost_up', 'boost_down', 'liquid', 'climbable', 'deadly', 'coin', 'portal', 'key', 'switch', 'effect', 'trophy', 'checkpoint']
NC = len(CLASSES); SOLID = CLASSES.index('solid'); FAR = 65535
FLIPC = np.arange(NC)
for u, v in [('arrow_left', 'arrow_right'), ('boost_left', 'boost_right')]:
    FLIPC[CLASSES.index(u)] = CLASSES.index(v); FLIPC[CLASSES.index(v)] = CLASSES.index(u)
dec = lambda s, t: np.frombuffer(base64.b64decode(s), dtype=t)

def bfs(W, H, passable, srcs):
    """8-way walk, no corner cut between two walls (as nnguide.js)"""
    d = np.full(W * H, FAR, np.int32); q = collections.deque()
    for s in srcs:
        if d[s] == FAR: d[s] = 0; q.append(s)
    while q:
        t = q.popleft(); x, y = t % W, t // W
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if not dx and not dy: continue
                xx, yy = x + dx, y + dy
                if xx < 0 or yy < 0 or xx >= W or yy >= H: continue
                j = yy * W + xx
                if d[j] != FAR or not passable[j]: continue
                if dx and dy and not passable[y * W + xx] and not passable[yy * W + x]: continue
                d[j] = d[t] + 1; q.append(j)
    return d

levels = []
for line in open(a.data):
    r = json.loads(line)
    W, H = r['W'], r['H']; N = W * H
    cls = dec(r['cls'], np.uint8).astype(np.int64)
    walk = dec(r['walk'], np.uint16).astype(np.float32); sw = dec(r['swalk'], np.uint16).astype(np.float32)
    occ = dec(r['occ'], np.uint8).astype(np.float32)
    passable = cls != SOLID
    st = r['start'][1] * W + r['start'][0]
    fs_ = bfs(W, H, passable, [st]).astype(np.float32)
    ft = bfs(W, H, passable, [y * W + x for x, y in r['trophies']]).astype(np.float32)
    def lg(v): return np.where(v >= FAR - 1, 0, np.log1p(np.minimum(v, FAR - 2)) / 8).astype(np.float32)
    def none(v): return (v >= FAR - 1).astype(np.float32)
    corridor = np.where((fs_ < FAR) & (ft < FAR), fs_ + ft, 1e9)   # (lowest on the shortest walk from the start to the trophy)
    extra = np.stack([lg(walk), none(walk), lg(sw), none(sw), lg(fs_), none(fs_), lg(ft), none(ft), np.zeros(N, np.float32), np.zeros(N, np.float32),
                      ((corridor - corridor[st]) / max(1.0, float(corridor[st]))).clip(0, 4).astype(np.float32)])
    extra[8, st] = 1
    for x, y in r['trophies']: extra[9, y * W + x] = 1
    lv = dict(lv=r['lv'], group=r['group'], eval=r['eval'], W=W, H=H, cls=cls.reshape(H, W), extra=extra.reshape(-1, H, W), occ=occ.reshape(H, W),
              mask=passable.reshape(H, W).astype(np.float32), corridor=corridor, walkT=ft, passable=passable)
    if r.get('evalOcc'):
        lv['evalOcc'] = dec(r['evalOcc'], np.uint8); lv['evalPath'] = dec(r['evalPath'], np.uint32).astype(np.int64)
    levels.append(lv)
NE = levels[0]['extra'].shape[0]
print(f'{len(levels)} levels, {sum(l["occ"].sum() for l in levels):.0f} route tiles', flush=True)

dils = [int(x) for x in a.dil.split(',')]
class Net(nn.Module):
    def __init__(s):
        super().__init__()
        s.emb = nn.Embedding(NC, 8)
        s.inp = nn.Conv2d(8 + NE, a.ch, 3, padding=1)
        s.convs = nn.ModuleList([nn.Conv2d(a.ch, a.ch, 3, padding=d, dilation=d) for d in dils])
        s.outc = nn.Conv2d(a.ch, 1, 1)
    def forward(s, cls, ex):
        h = Fn.relu(s.inp(torch.cat([s.emb(cls).permute(0, 3, 1, 2), ex], 1)))
        for c in s.convs: h = h + Fn.relu(c(h))
        return s.outc(h)[:, 0]

def batch(tr):
    C_ = a.crop; cl, ex, oc, mk = [], [], [], []
    for _ in range(a.bs):
        l = tr[np.random.randint(len(tr))]
        H, W = l['cls'].shape
        y0 = np.random.randint(0, max(1, H - C_ + 1)); x0 = np.random.randint(0, max(1, W - C_ + 1))
        c = np.zeros((C_, C_), np.int64); e = np.zeros((NE, C_, C_), np.float32); o = np.zeros((C_, C_), np.float32); m = np.zeros((C_, C_), np.float32)
        h, w = min(C_, H - y0), min(C_, W - x0)
        c[:h, :w] = l['cls'][y0:y0 + h, x0:x0 + w]; e[:, :h, :w] = l['extra'][:, y0:y0 + h, x0:x0 + w]
        o[:h, :w] = l['occ'][y0:y0 + h, x0:x0 + w]; m[:h, :w] = l['mask'][y0:y0 + h, x0:x0 + w]
        if np.random.rand() < 0.5: c, e, o, m = FLIPC[c[:, ::-1]], e[:, :, ::-1], o[:, ::-1], m[:, ::-1]
        cl.append(np.ascontiguousarray(c)); ex.append(np.ascontiguousarray(e)); oc.append(np.ascontiguousarray(o)); mk.append(np.ascontiguousarray(m))
    T = lambda v, dt=torch.float32: torch.tensor(np.stack(v), dtype=dt, device=dev)
    return T(cl, torch.int64), T(ex), T(oc), T(mk)

def predict(net, l):
    with torch.no_grad():
        p = torch.sigmoid(net(torch.tensor(l['cls'][None], device=dev), torch.tensor(l['extra'][None], device=dev)))[0]
    return p.cpu().numpy().reshape(-1)

def auc(score, pos, mask):
    s = score[mask]; y = pos[mask].astype(bool)
    if y.all() or not y.any(): return float('nan')
    order = np.argsort(s, kind='stable'); rk = np.empty(len(s)); rk[order] = np.arange(1, len(s) + 1)
    # (ties: average ranks)
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=rk); rk = sums[inv] / cnt[inv]
    n1 = y.sum(); n0 = len(y) - n1
    return float((rk[y].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))

def field(l, p, beta):
    """a walk from the trophy whose step onto tile j costs 1 + beta (1 - p[j]) (Dijkstra; no corner cut between walls)"""
    W, H = l['W'], l['H']; ps = l['passable']; N = W * H
    d = np.full(N, np.inf); hq = []
    for j in np.where(l['walkT'] == 0)[0]: d[j] = 0; heapq.heappush(hq, (0.0, int(j)))
    cost = 1 + beta * (1 - p)
    while hq:
        dt, t = heapq.heappop(hq)
        if dt > d[t]: continue
        x, y = t % W, t // W
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if not dx and not dy: continue
                xx, yy = x + dx, y + dy
                if xx < 0 or yy < 0 or xx >= W or yy >= H: continue
                j = yy * W + xx
                if not ps[j]: continue
                if dx and dy and not ps[y * W + xx] and not ps[yy * W + x]: continue
                nd = dt + cost[j]
                if nd < d[j]: d[j] = nd; heapq.heappush(hq, (nd, j))
    return d

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
    return [cov(lambda t: t['ticks'] > 300), cov(lambda t: t['ticks'] > 1000), cov(lambda t: t['ticks'] > 400 or t['height'] > 30 + 0.1 * t['base']), round(100 * above / max(1, cnt), 1)]

betas = [float(x) for x in a.betas.split(',')]
rows = []
for hold in a.holdout.split(','):
    tr = [l for l in levels if l['group'] != hold]
    ev = [l for l in levels if l['group'] == hold and 'evalOcc' in l]
    if not ev: print(f'{hold}: no evaluation level', flush=True); continue
    l = ev[0]
    net = Net().to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    sch = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.steps, pct_start=0.05)
    pw = torch.tensor(float(sum(x['mask'].sum() - x['occ'].sum() for x in tr) / max(1, sum(x['occ'].sum() for x in tr))), device=dev)
    t0 = time.time()
    for step in range(a.steps):
        cl, ex, oc, mk = batch(tr)
        lo = Fn.binary_cross_entropy_with_logits(net(cl, ex), oc, pos_weight=pw.sqrt(), reduction='none')
        loss = (lo * mk).sum() / mk.sum().clamp(min=1)
        opt.zero_grad(); loss.backward(); opt.step(); sch.step()
        if step % 1000 == 0 or step == a.steps - 1: print(f'  [{hold}] step {step} loss {loss.item():.4f} {time.time() - t0:.0f}s', flush=True)
    net.eval()
    p = predict(net, l)
    np.save(os.path.join(a.out, f'occ_{hold}_p.npy'), p.astype(np.float32))
    torch.save(net.state_dict(), os.path.join(a.out, f'occ_{hold}.pt'))
    mask = l['passable']; pos = l['evalOcc']
    corr = -l['corridor']
    res = {'hold': hold, 'lv': l['lv'], 'sec': round(time.time() - t0), 'auc_model': auc(p, pos, mask), 'auc_corridor': auc(corr, pos, mask),
           'route_tiles': int(pos.sum()), 'open_tiles': int(mask.sum())}
    # the guide fields along the judge route (tiles), next to the plain walk, the reach field and the line oracle
    path = l['evalPath']
    series = {}
    sp = f'{a.series}_{hold}_series.npy'
    if os.path.exists(sp):
        s = np.load(sp)
        if s.shape[1] == len(path): series['reach field'] = np.where(s[2] >= 0, s[2], np.nan)
    series['walk (beta 0)'] = field(l, np.zeros_like(p), 0)[path]
    pc = np.exp(-np.clip((l['corridor'] - l['corridor'].min()) / 10, 0, 50))   # (the corridor as a soft line: 1 on the shortest walk)
    for b in betas:
        series[f'learned line beta {b:g}'] = field(l, p, b)[path]
        series[f'corridor line beta {b:g}'] = field(l, pc, b)[path]
        series[f'route line (oracle) beta {b:g}'] = field(l, pos.astype(np.float64), b)[path]
    w0 = series['walk (beta 0)'][0]
    for k, v in series.items():
        v = np.where(np.isfinite(v), v, np.nan)
        if k != 'reach field' and v[0] > 0: v = v * (w0 / v[0])   # (in tiles of the walk at the start: the yardstick's 0.5 tile tolerance)
        res[k] = yard(v)
        rows.append((hold, k, res[k]))
    print(json.dumps(res), flush=True)
print('\n| held out | measure | cov300 | cov1000 | covRelay | above% |\n|---|---|---|---|---|---|')
for h, k, y in rows: print(f'| {h} | {k} | ' + ' | '.join(map(str, y)) + ' |')

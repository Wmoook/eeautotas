# The yardstick on saved series (train.py: <tag>_<hold>_series.npy rows truth, model, reach, doorwalk; tiles), also for
# mixes of the model with the reach cost (what goexplore --guideMix orders by).
#   python analyze.py /root/nnguide/models v1 [v2 ...]
import sys, os, math, json
import numpy as np
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
    return (cov(lambda t: t['ticks'] > 300), cov(lambda t: t['ticks'] > 1000), cov(lambda t: t['ticks'] > 400 or t['height'] > 30 + 0.1 * t['base']),
            round(100 * above / max(1, cnt), 1), f"{lg['ticks']}t +{lg['height']:.0f}" if lg else '-')
if __name__ == '__main__':
    d = sys.argv[1]
    print('| held out | measure | cov300 | cov1000 | covRelay | above% | longest trap |')
    print('|---|---|---|---|---|---|---|')
    for h in ['ip', 'octo', 'fv', 'ice', 'dotring']:
        base_done = False
        for tag in sys.argv[2:]:
            p = os.path.join(d, f'{tag}_{h}_series.npy')
            if not os.path.exists(p): continue
            s = np.load(p)
            truth, model, reach, dw = s
            if not base_done:
                print(f'| {h} | reach field | ' + ' | '.join(map(str, yard(np.where(reach >= 0, reach, np.nan)))) + ' |')
                print(f'| {h} | door-aware walk (lexicographic) | ' + ' | '.join(map(str, yard(dw))) + ' |')
                base_done = True
            print(f'| {h} | model {tag} | ' + ' | '.join(map(str, yard(model))) + ' |')
            r = np.where(reach >= 0, reach, np.nan)
            print(f'| {h} | {tag} mix 0.5 with reach | ' + ' | '.join(map(str, yard(0.5 * model + 0.5 * r))) + ' |')

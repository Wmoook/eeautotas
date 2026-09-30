'use strict';
// THE POLISH CURVE (lane 5, TAS-perfect): polish.js polishRoute on a finished route (a .eetas) for a given time, the gain
// and the steps printed as one JSON line. A tool only: nothing of the compiler changes.
//   node tools/cmp/polcurve.js <level.eelvl> <route.eetas> [--ms=60000] [--out=<file.eetas>] [--win=32] [--cap=60000]
const path = require('path');
const T = require('../../src/plan/types.js');
const C = require('../../src/common.js');
const P = require('../../src/plan/polish.js');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const [lv, rf] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const L = T.loadLevelFile(lv);
const masks = C.readEetas(rf);
const ev0 = C.evaluate(L, masks);
const t0 = Date.now();
const o = { ms: +arg('ms', 60000) };
for (const k of ['win', 'cap', 'mutShare', 'segShare', 'segWin', 'segStep']) if (arg(k)) o[k] = +arg(k);
const r = P.polishRoute(L, masks, o);
const ev = r.masks ? C.evaluate(L, r.masks instanceof Uint8Array ? r.masks : T.masksOf(r.masks)) : null;
if (arg('out') && ev && ev.runTicks < ev0.runTicks) C.writeEetas(arg('out'), ev.ms);
console.log(JSON.stringify({ level: path.basename(lv), from: ev0 && ev0.runTicks, to: ev ? ev.runTicks : null, ms: Date.now() - t0, steps: (r.steps || []).map((s) => `${s.how}: ${s.from}->${s.to} @${Math.round(s.at / 100) / 10}s`) }));

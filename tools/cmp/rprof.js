'use strict';
// THE ROUTE FIELD PROFILE (a doctor's tool, n5): along a known route, from a leg's start (the route's previous trigger, or
// --from) to its first entry into the target, the goal field's cost c(t) (the executor's RCH3 goal field as the doors stand
// at the leg's start: the field the skeleton's sub-level sets and the finders' ordering read) and its DECEPTION: the largest
// rise of c above its running minimum along the route (a route that must climb the field before it descends: the skeleton's
// sub-level sets are entered first by ways that dead-end), and the route's ticks per field tile.
//   node tools/cmp/rprof.js <level.eelvl> <route.eetas> "<label>|trophy" [--from=tick] [--every=25]
// A tool only (reads the level and the route; no compiler file reads it).
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const RF = require(path.join(root, 'src/reach.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const [file, rfile, label0] = argv.filter((s) => !s.startsWith('--'));
const every = +opt('every', 25) || 25;
const label = String(label0).replace(/ x\d+$/, '');
const L = T.loadLevelFile(file), W = L.width, H = L.height;
const masks = C.readEetas(rfile);
const ev = TS.routeEvents(L, masks);
let tiles, inTarget;
if (label === 'trophy') {
	tiles = [];
	for (let i = 0; i < W * H; i++) if (L.fg[i] === 121) tiles.push(i);
	inTarget = (s) => !!s.has_silver_crown;
} else {
	const M = MD.compileModel(L);
	const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
	if (!X) { console.log(JSON.stringify({ label, err: 'no trigger' })); process.exit(0); }
	tiles = X.tiles.slice();
	const ts = new Set(tiles);
	inTarget = (s) => ts.has(T.tileOf(s, W, H));
}
const sim = new E.EESim(L), inp = new E.EEInput();
sim.reset();
let hit = -1;
for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (inTarget(sim)) { hit = t + 1; break; } if (sim.has_silver_crown) break; }
if (hit < 0) { console.log(JSON.stringify({ label, err: 'the route never enters the target' })); process.exit(0); }
const prevEv = ev.events.filter((e) => e.tick < hit && e.feat !== 'deaths' && e.feat !== 'fx').pop();
const t0 = opt('from', null) !== null ? +opt('from', 0) : (prevEv ? prevEv.tick : 0);
sim.reset();
for (let t = 0; t < t0; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
const tb = Date.now();
// (--fx=1: the executor's field for the ball's own start state, types.js plainOf: EEAT_FX_FIELD's plain-ball field or
// EEAT_FX_STATE's effect-state field; the default: the field without either)
const f = T.goalField(T.levelNow(L, sim), tiles, opt('fx', '0') === '1' ? { plainFx: T.plainOf(sim) } : {});
const fms = Date.now() - tb;
const prof = [];
let cmin = Infinity, rise = 0, riseAt = -1, riseFrom = -1, cminAt = t0;
const c0 = RF.costAt(f, sim);
const tl = (s) => { const t = T.tileOf(s, W, H); return `${t % W},${(t / W) | 0}`; };
for (let t = t0; t < hit; t++) {
	const c = RF.costAt(f, sim);
	if (c >= 0 && c < cmin) { cmin = c; cminAt = t; }
	if (c >= 0 && c - cmin > rise) { rise = c - cmin; riseAt = t; riseFrom = cminAt; }
	if ((t - t0) % every === 0) prof.push(`${t - t0}:${c < 0 ? 'X' : c.toFixed(0)}@${tl(sim)}`);
	E.applyMask(inp, masks[t] & 31); sim.tick(inp);
}
console.log(JSON.stringify({ level: path.basename(file), label, from: t0, prev: prevEv ? prevEv.feat : 'spawn', hit, leg: hit - t0, c0: +(+c0).toFixed(1),
	rise: +rise.toFixed(1), riseFromTick: riseFrom - t0, riseAtTick: riseAt - t0, fieldMs: fms, ticksPerTile: +((hit - t0) / Math.max(1, c0)).toFixed(2),
	order: TS.orderOf(ev.events.filter((e) => e.tick <= hit)).map((s) => `${s.feat}@${s.tick}(${s.tile % W},${(s.tile / W) | 0})`).join(' ') }));
console.log(prof.join(' '));

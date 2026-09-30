'use strict';
// THE MOVE SOLVER FROM A KNOWN ROUTE'S STATES (c6 lane 2, fields in chains): src/plan/msolve.js leg() or chain() from the
// known route's own exact engine states at the ticks listed to a target (tiles + a support class), each answer the
// solver's own replay. Where the direct leg finds the target from a state near it and not from one further back, the leg
// is a CHAIN (the field passage needs the speed / support the route brought into it); where chain() does not find what
// leg() finds, the chain's edges are the gap (e.g. a plain node's direct leg is the plain solver's alone: EEAT_CHAIN_PFIELD).
//   node tools/cmp/msprobe.js <level.eelvl> <route.eetas> "<x,y;x,y>" <cls|any> <t1,t2,...> [--Tmax=200] [--chain=<ms>]
//        [--opts=<json: the solver's options, e.g. {"pfield":true,"legT":120} or {"tricks":"all"}>]
// Prints one JSON line per tick: ok, T (ticks), tool, member, why, and for a chain expanded / legs / nodes / pfield, ms.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const MS = require(path.join(root, 'src/plan/msolve.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
const [file, rfile, tilesS, cls, tsS] = pos;
if (!file || !rfile || !tilesS || !tsS) { console.error('usage: node tools/cmp/msprobe.js <level.eelvl> <route.eetas> "<x,y;...>" <cls|any> <t1,t2,...> [--Tmax=200] [--chain=<ms>] [--opts=<json>]'); process.exit(2); }
const L = T.loadLevelFile(file), W = L.width;
const masks = C.readEetas(rfile);
const tiles = tilesS.split(';').map((p) => { const [x, y] = p.split(',').map(Number); return y * W + x; });
const ts = tsS.split(',').map(Number);
const need = new Set(ts);
const sim = new E.EESim(L), inp = new E.EEInput();
sim.reset();
const snaps = new Map();
for (let t = 0; t < masks.length && snaps.size < need.size; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (need.has(t + 1)) snaps.set(t + 1, sim.snapshot()); }
const S = MS.createSolver(L, {});
const extra = JSON.parse(opt('opts', '{}'));
const Tmax = +opt('Tmax', 200), chainMs = +opt('chain', 0);
for (const t of ts) {
	const snap = snaps.get(t);
	if (!snap) { console.log(JSON.stringify({ t, err: 'the route ends before this tick' })); continue; }
	const t0 = Date.now();
	let res;
	try {
		res = chainMs > 0 ? S.chain(snap, { tiles, cls }, Object.assign({ ms: chainMs, Tmax }, extra))
			: S.leg(snap, { tiles, cls }, Object.assign({ Tmax, K: 2, coupled: true, fields: true, chain: false, prove: false }, extra));
	} catch (e) { res = { ok: false, why: 'error: ' + e.message }; }
	console.log(JSON.stringify({ t, ok: !!res.ok, T: res.T || 0, tool: res.tool, member: res.member, why: res.why, expanded: res.expanded, legs: res.legs, nodes: res.nodes, pfield: res.pfield, ms: Date.now() - t0 }));
}

'use strict';
// THE ROUTES' OWN FIELD LEGS (n5-tricks): every field passage of the truth set's routes (fieldmine.js's passages: a run of
// ticks whose current tile has one field class) as a LEG for the move solver: from the route's own state P ticks before
// the entry (the setup window) to the route's centre tile D ticks after the exit (the tile the route reaches past the
// field), within the route's own ticks (Tmax = the route's ticks for that stretch: coverage at <= the route). Per leg: solved,
// the solver's ticks vs the route's, the tier (plain / field / coupled / chain), the time. EEAT_TRICKS=1 in the environment
// switches the solver's trick derivations on (the A/B's var arm). General: no level code.
// Usage: EEAT_TRUTH_ROOT=<truth> node tools/tricks/fieldlegs.js --shard=i/n --out=<dir> [--P=12] [--D=4] [--maxLeg=120]
//        [--every=1] [--fieldMs=120] [--coupled=1] [--chain=0] [--chainMs=400] [--tag=base]
//        node tools/tricks/fieldlegs.js --agg=<dir> [--tag=base] [--vs=var]
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const F = require('../../src/math/fields.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const fieldClass = (id) => { const c = F.classOfId(id); return (c === 'air' || c === 'other') ? null : c; };
const cellOf = (p) => Math.trunc(p + 8) >> 4;
const PULL = { arrowU: [0, -1], arrowD: [0, 1], arrowL: [-1, 0], arrowR: [1, 0], boostU: [0, -1], boostD: [0, 1], boostL: [-1, 0], boostR: [1, 0] };
const rel = (face, pull) => {
	if (!pull) return 'free';
	if (face[0] === 0 && face[1] === 0) return 'none';
	const d = face[0] * pull[0] + face[1] * pull[1];
	return d > 0 ? 'along' : d < 0 ? 'against' : 'across';
};

function legsOf(L, masks, o) {
	const n = masks.length, W = L.width;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const snaps = new Array(n + 1);
	const px = new Float64Array(n + 1), py = new Float64Array(n + 1), cur = new Int32Array(n + 1), dead = new Uint8Array(n + 1);
	snaps[0] = sim.snapshot(); px[0] = sim.px; py[0] = sim.py;
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		snaps[t + 1] = sim.snapshot();
		px[t + 1] = sim.px; py[t + 1] = sim.py; cur[t + 1] = sim.current_tile; dead[t + 1] = sim.is_dead ? 1 : 0;
	}
	const out = [];
	let t = 1;
	while (t <= n) {
		const fc = fieldClass(cur[t]);
		if (!fc || dead[t]) { t++; continue; }
		let b = t;
		while (b + 1 <= n && fieldClass(cur[b + 1]) === fc && !dead[b + 1]) b++;
		const a = t;
		t = b + 1;
		if (b >= n || dead[b + 1]) continue;
		const s0 = Math.max(0, a - 1 - o.P);
		const gT = Math.min(n, b + o.D);
		const Lr = gT - s0;
		if (Lr > o.maxLeg || Lr < 2) continue;
		let deadIn = false;
		for (let k = s0 + 1; k <= gT; k++) if (dead[k]) { deadIn = true; break; }
		if (deadIn) continue;
		const lX = cellOf(px[b - 1]), lY = cellOf(py[b - 1]), eX = cellOf(px[b]), eY = cellOf(py[b]);
		const ia = Math.max(0, a - 2);
		const inFace = [Math.sign(cellOf(px[a - 1]) - cellOf(px[ia])), Math.sign(cellOf(py[a - 1]) - cellOf(py[ia]))];
		const outFace = [Math.sign(eX - lX), Math.sign(eY - lY)];
		const pull = PULL[fc] || null;
		out.push({ fc, a, b, n: b - a + 1, s0, gT, Lr, tile: cellOf(py[gT]) * W + cellOf(px[gT]), snap: snaps[s0],
			inRel: rel(inFace, pull), outRel: rel(outFace, pull), preFc: fieldClass(cur[a - 1]) || 'air' });
	}
	return out;
}

function main() {
	const TS = require('../../src/plan/truthset.js');
	const MS = require('../../src/plan/msolve.js');
	const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
	const OUT = argv.out || 'fieldlegs_out';
	const tag = argv.tag || (process.env.EEAT_TRICKS === '1' ? 'var' : 'base');
	fs.mkdirSync(OUT, { recursive: true });
	const o = { P: +(argv.P || 12), D: +(argv.D || 4), maxLeg: +(argv.maxLeg || 120) };
	const every = +(argv.every || 1);
	const routes = TS.knownRoutes();
	const fd = fs.openSync(path.join(OUT, `legs_${tag}_${SH}.jsonl`), 'w');
	const t0 = Date.now();
	let nl = 0, ok = 0, idx = 0;
	for (let r = 0; r < routes.length; r++) {
		if ((r % NSH) !== SH) continue;
		if (argv.only && !routes[r].name.includes(argv.only)) continue;
		let tr;
		try { tr = TS.loadTruth(routes[r]); } catch (e) { continue; }
		if (!tr) continue;
		const legs = legsOf(tr.L, tr.masks, o);
		const S = MS.createSolver(tr.L, {});
		for (const lg of legs) {
			if ((idx++ % every) !== 0) continue;
			const tl = Date.now();
			let res;
			try {
				res = S.leg(lg.snap, { tiles: [lg.tile], cls: 'any' }, { Tmax: lg.Lr, chain: argv.chain === '1', chainMs: +(argv.chainMs || 400), prove: false,
					fieldMs: +(argv.fieldMs || 120), coupled: argv.coupled !== '0', coupledTicks: +(argv.coupledTicks || 300000), nodes: 400000 });
			} catch (e) { res = { ok: false, why: 'error: ' + (e && e.message) }; }
			const ms = Date.now() - tl;
			nl++; if (res.ok) ok++;
			fs.writeSync(fd, JSON.stringify({ r, name: routes[r].name, fc: lg.fc, a: lg.a, n: lg.n, Lr: lg.Lr, inRel: lg.inRel, outRel: lg.outRel, preFc: lg.preFc,
				ok: !!res.ok, T: res.ok ? res.T : null, tool: res.tool || null, member: res.member || null, why: res.ok ? null : res.why || null, ms }) + '\n');
		}
		console.log(`${r} ${routes[r].name}: ${legs.length} legs (${Date.now() - t0} ms)`);
	}
	fs.closeSync(fd);
	console.log(`shard ${SH}/${NSH} ${tag}: ${nl} legs, ${ok} solved, ${Date.now() - t0} ms`);
}

function load(dir, tag) {
	const rows = new Map();
	for (const f of fs.readdirSync(dir)) {
		const m = /^legs_(.+)_(\d+)\.jsonl$/.exec(f);
		if (!m || m[1] !== tag) continue;
		for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) { const x = JSON.parse(l); rows.set(`${x.r}:${x.a}`, x); }
	}
	return rows;
}
function agg(dir) {
	const A = load(dir, argv.tag || 'base');
	const B = argv.vs ? load(dir, argv.vs) : null;
	const groups = new Map();
	for (const [k, x] of A) {
		const g = `${x.fc}`;
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g).push([x, B ? B.get(k) : null]);
	}
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
	const hdr = B ? 'class     legs  solvedA  solvedB  fasterA  fasterB  ticksA(sum over both)  ticksB  onlyA  onlyB  msA   msB' : 'class     legs  solved  faster  equal  ticks/route(solved)  field  coupled  plain  chain  ms(med)';
	console.log(hdr);
	const tot = { n: 0, a: 0, b: 0, fa: 0, fb: 0, ta: 0, tb: 0, oa: 0, ob: 0, r: 0 };
	for (const [g, arr] of [...groups].sort((x, y) => y[1].length - x[1].length)) {
		const n = arr.length;
		const okA = arr.filter(([x]) => x.ok), fA = okA.filter(([x]) => x.T < x.Lr).length;
		const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
		if (!B) {
			const eq = okA.filter(([x]) => x.T === x.Lr).length;
			const ratio = okA.reduce((s, [x]) => s + x.T, 0) / Math.max(1, okA.reduce((s, [x]) => s + x.Lr, 0));
			const by = (t) => okA.filter(([x]) => x.tool === t).length;
			console.log(`${g.padEnd(8)} ${String(n).padStart(5)} ${pct(okA.length, n).padStart(6)}% ${String(fA).padStart(7)} ${String(eq).padStart(6)} ${ratio.toFixed(3).padStart(19)} ${String(by('field')).padStart(6)} ${String(by('coupled')).padStart(8)} ${String(by('plain')).padStart(6)} ${String(by('chain')).padStart(6)} ${String(med(arr.map(([x]) => x.ms))).padStart(8)}`);
			tot.n += n; tot.a += okA.length; tot.fa += fA;
		} else {
			const both = arr.filter(([x, y]) => y);
			const okB = both.filter(([, y]) => y.ok), fB = okB.filter(([, y]) => y.T < y.Lr).length;
			const common = both.filter(([x, y]) => x.ok && y.ok);
			const ta = common.reduce((s, [x]) => s + x.T, 0), tb = common.reduce((s, [, y]) => s + y.T, 0);
			const onlyA = both.filter(([x, y]) => x.ok && !y.ok).length, onlyB = both.filter(([x, y]) => !x.ok && y.ok).length;
			console.log(`${g.padEnd(8)} ${String(both.length).padStart(5)} ${pct(both.filter(([x]) => x.ok).length, both.length).padStart(7)}% ${pct(okB.length, both.length).padStart(7)}% ${String(both.filter(([x]) => x.ok && x.T < x.Lr).length).padStart(7)} ${String(fB).padStart(7)} ${String(ta).padStart(21)} ${String(tb).padStart(7)} ${String(onlyA).padStart(6)} ${String(onlyB).padStart(6)} ${String(med(both.map(([x]) => x.ms))).padStart(5)} ${String(med(both.map(([, y]) => y.ms))).padStart(5)}`);
			tot.n += both.length; tot.a += both.filter(([x]) => x.ok).length; tot.b += okB.length; tot.ta += ta; tot.tb += tb; tot.oa += onlyA; tot.ob += onlyB;
		}
	}
	if (!B) console.log(`ALL ${tot.n} legs: solved ${tot.a} (${pct(tot.a, tot.n)}%), faster than the route ${tot.fa}`);
	else console.log(`ALL ${tot.n} legs: solved A ${tot.a} (${pct(tot.a, tot.n)}%) B ${tot.b} (${pct(tot.b, tot.n)}%); only A ${tot.oa}, only B ${tot.ob}; ticks on the common legs A ${tot.ta} B ${tot.tb}`);
}

if (argv.agg) agg(argv.agg); else main();

'use strict';
// n4u-moves: a PROTOTYPE of the study's recommendations applied to a copy of the primitives builder's prims.js (never
// to the builder's branch): node src/plan/understand/prims_patch.js <in prims.js> <out prims.js> [hop] [pt1]
//   hop: every edge / chain that ends on a LANDING also emits the child whose landing tick is replayed with the jump bit
//        (the pre-landing state is kept while in the air; +1 tick per landing edge): the routes' hops (53.5% of landings).
//   pt1: the per-tick one-change arcs on plain ground nodes: JUMPC(d0 > d1 @ c): press with d0 (- / L / R), d0 held
//        until tick c, then d1, for every c in 1..44 (the late hold 0 > d included), to the landing.
// Text patches on the builder's f6911f4 prims.js: each anchor must be found, else it throws (the builder's file changed).
const fs = require('fs');
const [, , inF, outF, ...opts] = process.argv;
let s = fs.readFileSync(inF, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('anchor not found: ' + a.slice(0, 90)); s = s.replace(a, b); };
const HOP = opts.includes('hop'), PT1 = opts.includes('pt1');

if (PT1) {
	rep(`	const multi = [];`, `	// n4u pt1: the per-tick one-change arcs (the late hold included)
	for (const d0 of [0, 2, 4]) for (const d1 of [0, 2, 4]) {
		if (d1 === d0) continue;
		for (let c = 1; c <= 44; c++) plain.push({ name: \`JUMPC(\${d0}>\${d1}@\${c})\`, fam: 'JUMPC', max: MAXT, land: true, mask: (k) => (k === 0 ? 1 | d0 : k < c ? d0 : d1) });
	}
	const multi = [];`);
}
if (HOP) {
	// simEdge: keep the pre-tick state while in the air; on a landing, the hop child into ctx.hops
	rep(`		let n = 0, event = 'end', goal = false;
		for (let k = 0; k < macro.max; k++) {
			const m = macro.mask(k, s, stt);
			if (m < 0) break;
			E.applyMask(inp, m);
			s.tick(inp);`, `		let n = 0, event = 'end', goal = false;
		for (let k = 0; k < macro.max; k++) {
			const m = macro.mask(k, s, stt);
			if (m < 0) break;
			if (!onG && !macro.whole) hopPre = s.snapshot(hopPre);
			E.applyMask(inp, m);
			s.tick(inp);`);
	rep(`		st.ticks += n;
		if (n === 0) return null;
		const hash = s.stateHash();
		if (hash === h0) return null;`, `		st.ticks += n;
		if (n === 0) return null;
		if (event === 'land' && ctx.hops) {
			const keep = s.snapshot();
			hopChild(s, buf, n, macro.name, macro.fam, ctx, ctx.hops);
			s.restore(keep);
		}
		const hash = s.stateHash();
		if (hash === h0) return null;`);
	// simChain: the same on its landing emit
	rep(`		for (let k = 0, n = 0; k < chain.max; k++) {
			const m = chain.mask(k, s);
			E.applyMask(inp, m);`, `		for (let k = 0, n = 0; k < chain.max; k++) {
			const m = chain.mask(k, s);
			if (!onG) hopPre = s.snapshot(hopPre);
			E.applyMask(inp, m);`);
	rep(`			if (!onG && s.on_ground) { emit(n, 'land', false); return; }
			if (chain.stops.has(n) || n === chain.max) emit(n, 'end', false);`, `			if (!onG && s.on_ground) { emit(n, 'land', false); const hh = []; hopChild(s, buf, n, chain.name + ',land', chain.fam, ctx, hh); for (const e of hh) push(e); return; }
			if (chain.stops.has(n) || n === chain.max) emit(n, 'end', false);`);
	// the helper + the rolling snapshot, before simEdge
	rep(`	function simEdge(s, snap, macro, ctx, buf0) {`, `	let hopPre = null;
	/** n4u hop: the landing tick (buf[n - 1]) replayed from the pre-landing state with the jump bit: a child when it jumps */
	function hopChild(s, buf, n, name, fam, ctx, out) {
		if (!hopPre || (buf[n - 1] & 1) === 1) return;
		s.restore(hopPre);
		const m = buf[n - 1] | 1;
		E.applyMask(inp, m);
		s.tick(inp);
		st.ticks++;
		if (s.is_dead || !s.on_ground || s.jump_count === 0) return;
		const hash = s.stateHash();
		if (hash === ctx.parentHash) return;
		const goal = !!(ctx.goal && ctx.goal.test(s));
		const e = { macro: name + '+HOP', fam, edge: null, ticks: n, event: goal ? 'goal' : 'land', goal, dead: false, hash, snap: null, tile: T.tileOf(s, W, H),
			px: s.px, py: s.py, vx: s.speed_x, vy: s.speed_y, onGround: !!s.on_ground, jumps: s.jump_count, finished: !!s.has_silver_crown };
		if (ctx.onChild && !ctx.onChild(s, e)) return;
		const ed = buf.slice(0, n); ed[n - 1] = m;
		e.edge = ed;
		e.snap = s.snapshot();
		out.push(e);
	}
	function simEdge(s, snap, macro, ctx, buf0) {`);
	// expandNode: drain the hop children after each simEdge
	rep(`		for (const m of fam.list) push(simEdge(s, snap, m, ctx, buf));`, `		ctx.hops = [];
		for (const m of fam.list) { push(simEdge(s, snap, m, ctx, buf)); for (const e of ctx.hops) push(e); ctx.hops.length = 0; }`);
	rep(`		if (fam.steps) for (const m of fam.steps) push(simEdge(s, snap, { name: \`STEP(\${m})\`, fam: 'STEP', max: 1, mask: (k) => (k === 0 ? m : -1) }, ctx, buf));`,
		`		ctx.hops = null;
		if (fam.steps) for (const m of fam.steps) push(simEdge(s, snap, { name: \`STEP(\${m})\`, fam: 'STEP', max: 1, mask: (k) => (k === 0 ? m : -1) }, ctx, buf));`);
}
fs.writeFileSync(outF, s);
console.log('patched', outF, HOP ? 'hop' : '', PT1 ? 'pt1' : '');

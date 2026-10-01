'use strict';
// tools/cmp/xlvab.js: the shared approach's A/B (executor.js EEAT_SKEL_XLV) of two fullc.js --json=1 runs: per level both
// arms: compiled, triggers, ok steps, waypoints with a skeleton, the waypoints' depth (per waypoint its least c / c0 over
// its skeleton calls, c the level a call ended at: resumed and seeded levels count, they are real engine states), the
// waypoints within 0.1 x c0 / within 60 tiles, and the knob's seeds (exec.xlv: calls, seeds, their c / top, ms); the
// totals over the levels both arms finished.
//   node tools/cmp/xlvab.js <off dir> <on dir>
const fs = require('fs'), path = require('path');
function read(dir) {
	const out = new Map();
	let files = [];
	try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort(); } catch (e) { return out; }
	for (const f of files) {
		const id = f.replace(/\.log$/, '').replace(/^campaign__/, '');
		const ev = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
		const rep = ev.find((e) => e.ev === 'report');
		const done = ev.some((e) => e.ev === 'done') || !!rep;
		const prog = ev.filter((e) => e.ev === 'progress');
		const lastP = prog[prog.length - 1] || {};
		const steps = ev.filter((e) => e.ev === 'step');
		const W = new Map();
		for (const e of ev) {
			if (e.ev !== 'exec.skel' || !(e.c0 > 0)) continue;
			let w = W.get(e.label);
			if (!w) { w = { c0: e.c0, c: e.c0 }; W.set(e.label, w); }
			w.c0 = Math.max(w.c0, e.c0);
			let m = e.c;
			for (const l of e.levels || []) if (l.ok && l.c < m) m = l.c;
			w.c = Math.min(w.c, m);
		}
		let depth = 0, near = 0, close = 0;
		for (const w of W.values()) { const fr = w.c / w.c0; depth += fr; if (fr <= 0.1) near++; if (w.c <= 60) close++; }
		const xl = ev.filter((e) => e.ev === 'exec.xlv');
		const seeds = xl.filter((e) => e.c !== null && e.c !== undefined);
		const seedFr = seeds.map((e) => e.c / Math.max(1, e.top || e.c0));
		out.set(id, {
			done, ok: !!(rep && rep.ok), runTicks: rep && rep.runTicks ? rep.runTicks : null, trig: lastP.triggers || 0,
			steps: steps.length, okSteps: steps.filter((s) => s.ok).length, wps: W.size, depth: W.size ? depth / W.size : 1, near, close,
			xlCalls: xl.length, seeds: seeds.length, seedFr: seedFr.length ? seedFr.reduce((a, b) => a + b, 0) / seedFr.length : null,
			xlMs: xl.reduce((s, e) => s + (e.ms || 0), 0),
		});
	}
	return out;
}
const A = read(process.argv[2]), B = read(process.argv[3]);
const T = { a: { ok: 0, trig: 0, okSteps: 0, near: 0, close: 0, depth: 0, n: 0 }, b: { ok: 0, trig: 0, okSteps: 0, near: 0, close: 0, depth: 0, n: 0, seeds: 0, xlCalls: 0, xlMs: 0 } };
const f2 = (x) => (x === null || x === undefined ? '-' : x.toFixed(2));
console.log('level'.padEnd(30) + ' | off: ok trig okSteps wps depth near<=0.1 c<=60 | on: ok trig okSteps wps depth near c<=60 | seeds/calls seedFr ms');
for (const id of [...new Set([...A.keys(), ...B.keys()])].sort()) {
	const a = A.get(id), b = B.get(id);
	if (!a || !b || !a.done || !b.done) { console.log(`${id.padEnd(30)} | ${a ? (a.done ? 'done' : 'running') : '-'} | ${b ? (b.done ? 'done' : 'running') : '-'}`); continue; }
	for (const [k, x] of [['a', a], ['b', b]]) { const t = T[k]; t.ok += x.ok ? 1 : 0; t.trig += x.trig; t.okSteps += x.okSteps; t.near += x.near; t.close += x.close; t.depth += x.depth; t.n++; }
	T.b.seeds += b.seeds; T.b.xlCalls += b.xlCalls; T.b.xlMs += b.xlMs;
	console.log(`${id.padEnd(30)} | ${a.ok ? a.runTicks : '-'} ${a.trig} ${a.okSteps} ${a.wps} ${f2(a.depth)} ${a.near} ${a.close} | ${b.ok ? b.runTicks : '-'} ${b.trig} ${b.okSteps} ${b.wps} ${f2(b.depth)} ${b.near} ${b.close} | ${b.seeds}/${b.xlCalls} ${f2(b.seedFr)} ${b.xlMs}`);
}
console.log(`TOTAL (${T.a.n} levels both done): off compiled ${T.a.ok}, triggers ${T.a.trig}, ok steps ${T.a.okSteps}, mean waypoint depth ${f2(T.a.depth / Math.max(1, T.a.n))}, waypoints <= 0.1 c0 ${T.a.near}, <= 60 tiles ${T.a.close} | on compiled ${T.b.ok}, triggers ${T.b.trig}, ok steps ${T.b.okSteps}, depth ${f2(T.b.depth / Math.max(1, T.b.n))}, <= 0.1 ${T.b.near}, <= 60 ${T.b.close}; seeds ${T.b.seeds} of ${T.b.xlCalls} calls, ${T.b.xlMs} ms measuring`);

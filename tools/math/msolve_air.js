'use strict';
// AIRBORNE LEGS ON THE REAL ROUTES (n4-math, the coverage iteration): the compile's missed trigger / trophy legs start
// in the air (79% of them: an arrival is the touch of a coin or a switch mid-flight), and the move solver's airborne
// start was ONE trajectory to its landing, so a leg that lands and acts again (a hop, a jump, a walk-off, a walk on)
// needed the chain tier. This bench takes the route's exact state in the AIR (the middle of a flight move, class A)
// and asks msolve.leg for the support `--span` moves ahead (the end of the flight's NEXT move: land + act + arrive),
// Tmax = the route's ticks from there + slack; the same leg with the land-and-act members off (o.land false) beside it
// (both arms in one process, the same state and target); every answer replayed again here by a separate EESim with the
// moves study's test (the class letter and the centre tile).
// Usage: EEAT_TRUTH_ROOT=<root> node tools/math/msolve_air.js --moves=<exact_jsonl dir> --out=<dir> [--shard=i/n]
//          [--limit=N routes] [--every=N] [--span=2] [--slack=10] [--tmax=150] [--coupled=0|1] [--fields=0|1] [--cls=any]
//        node tools/math/msolve_air.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const MS = require('../../src/plan/msolve.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { aggregate(argv.agg); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/msolve/air';
fs.mkdirSync(OUT, { recursive: true });
const SLACK = +(argv.slack || 10), EVERY = +(argv.every || 1), SPAN = +(argv.span || 2), TMAXC = +(argv.tmax || 150);
const FLIGHT = new Set(['hop', 'jump', 'fall']);

function loadMoves(dir) {
	const byR = new Map();
	for (const f of fs.readdirSync(dir)) {
		if (!/^moves_\d+\.jsonl$/.test(f)) continue;
		for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
			if (!line) continue;
			const m = JSON.parse(line);
			if (!byR.has(m.r)) byR.set(m.r, []);
			byR.get(m.r).push(m);
		}
	}
	for (const a of byR.values()) a.sort((p, q) => p.t0 - q.t0);
	return byR;
}

function main() {
	const byR = loadMoves(argv.moves || path.join(process.env.EEAT_TRUTH_ROOT || '.', 'src/out/n4plan/understand/moves/exact_jsonl'));
	const all = TS.knownRoutes({});
	all.forEach((e, i) => { e._idx = i; });
	const mine = all.filter((e) => e._idx % NSH === SH && byR.has(e._idx)).slice(0, +(argv.limit || 1e9));
	const outF = fs.openSync(path.join(OUT, `air_${SH}.jsonl`), 'w');
	const t00 = Date.now();
	let n = 0;
	for (const entry of mine) {
		const tr = TS.loadTruth(entry);
		if (!tr) continue;
		const { L, masks } = tr;
		const moves = byR.get(entry._idx);
		const W = L.width, H = L.height;
		// the legs: the middle of a flight move i (c0 != D), to the end of move i + SPAN - 1
		const legs = [];
		for (let i = 0; i + SPAN - 1 < moves.length; i++) {
			if (i % EVERY !== 0) continue;
			const a = moves[i], b = moves[i + SPAN - 1];
			if (!FLIGHT.has(a.label) || a.len < 6) continue;
			if (moves.slice(i, i + SPAN).some((m) => m.c0 === 'D' || m.c1 === 'D' || m.label === 'respawn' || m.endKind === 'portal')) continue;
			const tm = a.t0 + (a.len >> 1);
			const routeT = b.t1 - tm;
			if (routeT + SLACK > TMAXC) continue;
			legs.push({ i, tm, b, routeT });
		}
		if (!legs.length) continue;
		const need = new Set(legs.map((q) => q.tm));
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const snaps = new Map();
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); if (need.has(t + 1)) snaps.set(t + 1, sim.snapshot()); }
		const S = MS.createSolver(L, { K: +(argv.K || 2) });
		const chk = new E.EESim(L), cinp = new E.EEInput();
		chk.reset();
		const flags = chk._flags;
		for (const q of legs) {
			const snap = snaps.get(q.tm);
			if (!snap) continue;
			chk.restore(snap);
			if (MS.clsOf(chk, flags) !== 'A') continue;           // airborne starts only
			const cls = argv.cls || q.b.c1;
			const target = { tiles: [q.b.tile1], cls };
			const base = { Tmax: q.routeT + SLACK, K: +(argv.K || 2), coupled: argv.coupled === '1', fields: argv.fields === '1', chain: false, prove: false };
			const rec = { r: entry._idx, m: q.i, len: q.routeT, c1: q.b.c1, label: moves[q.i].label, next: moves[q.i + 1] ? moves[q.i + 1].label : null };
			// --arms=bonk: the land-and-act members with (on) and without (off) their bonk variants (coverage iteration 2)
			const ARMS = argv.arms === 'bonk' ? [['on', { land: true, landBonk: true }], ['off', { land: true, landBonk: false }]] : [['on', { land: true }], ['off', { land: false }]];
			for (const [k, armO] of ARMS) {
				const res = S.leg(snap, target, Object.assign({}, base, armO));
				const r = { ok: !!res.ok, T: res.T || 0, tool: res.tool || null, member: res.member, us: Math.round(res.us), why: res.ok ? undefined : res.why };
				if (res.ok) {
					chk.restore(snap);
					for (let t = 0; t < res.masks.length; t++) { E.applyMask(cinp, res.masks[t]); chk.tick(cinp); }
					const tile = T.tileOf(chk, W, H);
					r.verified = !chk.is_dead && tile === q.b.tile1 && (cls === 'any' || MS.clsOf(chk, flags) === cls);
				}
				rec[k] = r;
			}
			fs.writeSync(outF, JSON.stringify(rec) + '\n');
			n++;
		}
		process.stdout.write(`${entry._idx} ${entry.name} legs=${n} ${((Date.now() - t00) / 1000).toFixed(1)}s\n`);
	}
	fs.closeSync(outF);
}

function aggregate(dir) {
	const recs = [];
	for (const f of fs.readdirSync(dir)) if (/^air_\d+\.jsonl$/.test(f)) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) recs.push(JSON.parse(line));
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
	const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	const p90 = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
	const lines = [];
	const groups = new Map();
	for (const r of recs) { for (const k of ['ALL', `${r.label}>${r.next}`]) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); } }
	lines.push('| legs (airborne start, the support 2 moves on) | n | solved on / off | <= route on / off | < route on | land members | us median on / off | us p90 on / off |', '|---|---:|---|---|---:|---:|---|---|');
	const keys = Array.from(groups.keys()).sort((a, b) => (a === 'ALL' ? -1 : b === 'ALL' ? 1 : groups.get(b).length - groups.get(a).length)).slice(0, 12);
	for (const k of keys) {
		const g = groups.get(k);
		const okOn = g.filter((r) => r.on.ok && r.on.verified), okOff = g.filter((r) => r.off.ok && r.off.verified);
		const leOn = okOn.filter((r) => r.on.T <= r.len), leOff = okOff.filter((r) => r.off.T <= r.len), ltOn = okOn.filter((r) => r.on.T < r.len);
		const landM = okOn.filter((r) => /land/.test(r.on.member || '')).length;
		lines.push(`| ${k} | ${g.length} | ${pct(okOn.length, g.length)}% / ${pct(okOff.length, g.length)}% | ${pct(leOn.length, g.length)}% / ${pct(leOff.length, g.length)}% | ${pct(ltOn.length, g.length)}% | ${landM} | ${med(g.map((r) => r.on.us))} / ${med(g.map((r) => r.off.us))} | ${p90(g.map((r) => r.on.us))} / ${p90(g.map((r) => r.off.us))} |`);
	}
	const bad = recs.filter((r) => (r.on.ok && !r.on.verified) || (r.off.ok && !r.off.verified)).length;
	const onlyOn = recs.filter((r) => r.on.ok && r.on.verified && !(r.off.ok && r.off.verified)).length;
	const onlyOff = recs.filter((r) => r.off.ok && r.off.verified && !(r.on.ok && r.on.verified)).length;
	const both = recs.filter((r) => r.on.ok && r.off.ok && r.on.verified && r.off.verified);
	lines.push('', `legs ${recs.length}; answers the independent replay rejected: ${bad}; solved only with the land members ${onlyOn}, only without ${onlyOff}; both ${both.length}: shorter with ${both.filter((r) => r.on.T < r.off.T).length}, longer ${both.filter((r) => r.on.T > r.off.T).length}`);
	const whys = new Map(); for (const r of recs) if (!r.on.ok) whys.set(r.on.why, (whys.get(r.on.why) || 0) + 1);
	lines.push('failures (on): ' + Array.from(whys.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('; '));
	const txt = lines.join('\n');
	console.log(txt);
	fs.writeFileSync(path.join(dir, 'summary.md'), txt + '\n');
}

main();

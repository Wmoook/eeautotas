'use strict';
// THE TRICKS A/B ON THE ROUTES' OWN MOVES (n5-tricks): the moves of the moves study (exact_jsonl) that carry a trick of the
// census (tools/tricks/mine.js --out json), each given to src/plan/msolve.js as the bench does (the route's exact state at the
// move's start, the route's next support as the target, Tmax = the route's ticks + slack), with the tricks off and on in
// one process (o.tricks false / the list); every answer replayed again by a separate EESim with the moves study's test.
// Usage: EEAT_TRUTH_ROOT=<root> node tools/tricks/legab.js --mine=<mine.json> --tags=airjump[,..] [--labels=..]
//          [--tricks=airjump] [--out=<file.jsonl>] [--shard=i/n] [--limit=N] [--slack=10] [--fields=0] [--coupled=0] [--chain=0]
//        node tools/tricks/legab.js --agg=<file.jsonl,...>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const MS = require('../../src/plan/msolve.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { agg(argv.agg.split(',')); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const SLACK = +(argv.slack || 10);
const TAGS = (argv.tags || 'airjump').split(',');
const LABELS = argv.labels ? new Set(argv.labels.split(',')) : null;
const TRICKS = argv.tricks || TAGS.join(',');

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
	const mine = JSON.parse(fs.readFileSync(argv.mine, 'utf8'));
	const want = new Map();
	for (const m of mine.moves) if (TAGS.some((k) => m.tags[k]) && (!LABELS || LABELS.has(m.label))) { if (!want.has(m.r)) want.set(m.r, new Set()); want.get(m.r).add(m.m); }
	const byR = loadMoves(argv.moves || path.join(process.env.EEAT_TRUTH_ROOT || '.', 'src/out/n4plan/understand/moves/exact_jsonl'));
	const all = TS.knownRoutes({});
	const outF = fs.openSync(argv.out || 'src/out/tricks/legab.jsonl', 'w');
	let n = 0;
	const t00 = Date.now();
	for (const [r, set] of want) {
		if (r % NSH !== SH) continue;
		if (argv.routes && !argv.routes.split(',').includes(String(r))) continue;
		const tr = TS.loadTruth(all[r]);
		if (!tr) continue;
		const { L, masks } = tr;
		const moves = byR.get(r);
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const need = new Set(); for (const mi of set) { need.add(moves[mi].t0); need.add(moves[mi].t1); }
		const snaps = new Map(), hashes = new Map();
		if (need.has(0)) { snaps.set(0, sim.snapshot()); hashes.set(0, sim.stateHash()); }
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); if (need.has(t + 1)) { snaps.set(t + 1, sim.snapshot()); hashes.set(t + 1, sim.stateHash()); } }
		const S = MS.createSolver(L, {});
		const chk = new E.EESim(L), cinp = new E.EEInput(); chk.reset();
		const flags = chk._flags;
		for (const mi of Array.from(set).sort((a, b) => a - b)) {
			if (argv.limit && n >= +argv.limit) break;
			const mv = moves[mi];
			if (mv.c0 === 'D' || mv.c1 === 'D' || mv.label === 'respawn' || mv.len > 400) continue;
			const tele = mv.endKind === 'portal';
			if (tele) continue;
			const target = { tiles: [mv.tile1], cls: mv.c1 };
			const snap = snaps.get(mv.t0);
			const rec = { r, m: mi, label: mv.label, len: mv.len, c0: mv.c0, c1: mv.c1 };
			for (const [arm, tricks] of [['off', false], ['on', TRICKS]]) {
				const res = S.leg(snap, target, { Tmax: mv.len + SLACK, K: 2, tricks, fields: argv.fields !== '0', coupled: argv.coupled !== '0', chain: argv.chain === '0' ? false : undefined });
				const q = { ok: !!res.ok, T: res.T || 0, tool: res.tool || null, member: res.member, us: Math.round(res.us), why: res.ok ? undefined : res.why };
				if (res.ok) {
					chk.restore(snap);
					let dead = false;
					for (let t = 0; t < res.masks.length; t++) { E.applyMask(cinp, res.masks[t]); chk.tick(cinp); if (chk.is_dead) { dead = true; break; } }
					q.verified = !dead && MS.clsOf(chk, flags) === mv.c1 && T.tileOf(chk, L.width, L.height) === mv.tile1;
					q.exact = chk.stateHash() === hashes.get(mv.t1) && res.T === mv.len;
				}
				rec[arm] = q;
			}
			fs.writeSync(outF, JSON.stringify(rec) + '\n');
			n++;
		}
		if (argv.verbose) process.stdout.write(`${r} ${all[r].name} legs=${n} ${((Date.now() - t00) / 1000).toFixed(1)}s\n`);
	}
	fs.closeSync(outF);
	console.log(`legs ${n}, ${((Date.now() - t00) / 1000).toFixed(1)} s`);
}

function agg(files) {
	const recs = [];
	for (const f of files) {
		const st = fs.statSync(f);
		const list = st.isDirectory() ? fs.readdirSync(f).filter((q) => /\.jsonl$/.test(q)).map((q) => path.join(f, q)) : [f];
		for (const g of list) for (const line of fs.readFileSync(g, 'utf8').split('\n')) if (line) recs.push(JSON.parse(line));
	}
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
	const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	const groups = new Map([['ALL', recs]]);
	for (const r of recs) { if (!groups.has(r.label)) groups.set(r.label, []); groups.get(r.label).push(r); }
	console.log('| class | legs | solved off / on | <= route off / on | < route off / on | on only | off only | faster with on | slower with on | us median off / on |');
	console.log('|---|---:|---|---|---|---:|---:|---:|---:|---|');
	for (const [k, g] of groups) {
		const ok = (r, a) => r[a] && r[a].ok && r[a].verified;
		const so = g.filter((r) => ok(r, 'off')), sn = g.filter((r) => ok(r, 'on'));
		const le = (a) => g.filter((r) => ok(r, a) && r[a].T <= r.len).length, lt = (a) => g.filter((r) => ok(r, a) && r[a].T < r.len).length;
		const onOnly = g.filter((r) => ok(r, 'on') && !ok(r, 'off')).length, offOnly = g.filter((r) => ok(r, 'off') && !ok(r, 'on')).length;
		const faster = g.filter((r) => ok(r, 'on') && ok(r, 'off') && r.on.T < r.off.T).length, slower = g.filter((r) => ok(r, 'on') && ok(r, 'off') && r.on.T > r.off.T).length;
		console.log(`| ${k} | ${g.length} | ${pct(so.length, g.length)} / ${pct(sn.length, g.length)} | ${pct(le('off'), g.length)} / ${pct(le('on'), g.length)} | ${pct(lt('off'), g.length)} / ${pct(lt('on'), g.length)} | ${onOnly} | ${offOnly} | ${faster} | ${slower} | ${med(g.map((r) => r.off.us))} / ${med(g.map((r) => r.on.us))} |`);
	}
	const bad = recs.filter((r) => (r.on.ok && !r.on.verified) || (r.off.ok && !r.off.verified)).length;
	console.log(`answers the independent replay rejected: ${bad}`);
	const tools = new Map(); for (const r of recs) if (r.on.ok && r.on.verified) tools.set(r.on.tool + (r.on.member && r.on.member.includes('>air@') ? '+air' : ''), (tools.get(r.on.tool + (r.on.member && r.on.member.includes('>air@') ? '+air' : '')) || 0) + 1);
	console.log('on tools: ' + Array.from(tools.entries()).map(([k, v]) => `${k} ${v}`).join(', '));
}

main();

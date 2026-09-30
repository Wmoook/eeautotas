'use strict';
// THE JOINS on finished routes (n5-perfect): src/plan/joins.js joinRoute on each compiled route, before / after, the proofs.
//   node tools/perfect/joins.js <level.eelvl> <route.eetas> [--ms=60000] [--F=6] [--M=4] [--A=3] [--out=<.eetas>] [--json]
//   node tools/perfect/joins.js --final=<n4plan dir> --levels=<levels dir> --out=<dir> [--only=substr,...] [--ms=] [--shard=i/n]
//     every compiled route of the chief's FINAL (final/cmp_chief_fin_A + _C: .eetas + .json), its best known from FINAL.jsonl;
//     one JSON line a level to <out>/joins_<shard>.jsonl and the improved .eetas to <out>/<id>.eetas
//     --threads=N: N worker threads in this one process (shard i/N each); --routes=<dir>: start from <dir>/<id>.eetas where
//     it exists (another pass's routes: the stack), the compiled route elsewhere
//   node tools/perfect/joins.js --agg=<dir> [--final=<n4plan dir>]   the table
const fs = require('fs'), path = require('path');
const C = require('../../src/common.js');
const T = require('../../src/plan/types.js');
const J = require('../../src/plan/joins.js');

const WT = require('worker_threads');
const ARGS = WT.isMainThread ? process.argv.slice(2) : WT.workerData.args;
const argv = Object.fromEntries(ARGS.filter((a) => a.startsWith('--')).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] === undefined ? '1' : m[2]]; }));
const pos = ARGS.filter((a) => !a.startsWith('--'));
const num = (v, d) => (v === undefined ? d : +v);
const opts = () => ({ ms: num(argv.ms, 60000), F: num(argv.F, 6), M: num(argv.M, 4), A: num(argv.A, 3), span: num(argv.span, 120), legMs: num(argv.legMs, 60), div: num(argv.div, 6),
	log: argv.verbose ? (s) => console.error(s) : null });

function one(levelFile, eetasFile) {
	const L = T.loadLevelFile(levelFile);
	const masks = C.readEetas(eetasFile);
	const r = J.joinRoute(L, masks, opts());
	// the output replayed from the level file alone (raw bytes, as eeo-tas plays them)
	let replayed = null;
	if (argv.out && r.accepted) {
		C.writeEetas(argv.out, r.masks);
		const ev = C.evaluate(T.loadLevelFile(levelFile), C.readEetas(argv.out));
		replayed = ev ? ev.runTicks : -1;
	}
	return Object.assign({ level: levelFile, eetas: eetasFile, replayed }, r, { masks: undefined });
}

function finalList(dir, lvDir) {
	const rows = new Map();
	try { for (const l of fs.readFileSync(path.join(dir, 'FINAL.jsonl'), 'utf8').split('\n')) if (l.trim()) { const o = JSON.parse(l); rows.set(o.rel.replace(/\.eelvl$/, ''), o); } } catch (e) { /* none */ }
	const out = [];
	for (const sub of ['cmp_chief_fin_A', 'cmp_chief_fin_C']) {
		const d = path.join(dir, 'final', sub);
		if (!fs.existsSync(d)) continue;
		for (const f of fs.readdirSync(d).filter((f) => f.endsWith('.eetas'))) {
			const id = f.replace(/\.eetas$/, ''), rel = id.replace(/__/g, '/');
			let rep = null;
			try { rep = JSON.parse(fs.readFileSync(path.join(d, id + '.json'), 'utf8')); } catch (e) { rep = null; }
			const row = rows.get(rel) || null;
			const alt = argv.routes ? path.join(argv.routes, id + '.eetas') : null;
			out.push({ id, rel, level: path.join(lvDir, rel + '.eelvl'), eetas: alt && fs.existsSync(alt) ? alt : path.join(d, f), from: alt && fs.existsSync(alt) ? 'routes' : 'compiled', lb: rep ? rep.lb : row ? row.lb : null, best: row ? row.best : null, compiled: rep ? rep.runTicks : null, pass: sub.endsWith('_A') ? 'A60' : 'C180' });
		}
	}
	return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function batch() {
	const list = finalList(argv.final, argv.levels);
	const only = argv.only ? argv.only.split(',') : null;
	const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
	fs.mkdirSync(argv.out, { recursive: true });
	const outF = path.join(argv.out, `joins_${SH}.jsonl`);
	const mine = list.filter((e, i) => i % NSH === SH && (!only || only.some((s) => e.rel.includes(s))));
	for (const e of mine) {
		const t = Date.now();
		let row;
		try {
			const L = T.loadLevelFile(e.level);
			const masks = C.readEetas(e.eetas);
			const r = J.joinRoute(L, masks, opts());
			let replayed = null;
			if (r.accepted) {
				const f = path.join(argv.out, e.id + '.eetas');
				C.writeEetas(f, r.masks);
				const ev = C.evaluate(T.loadLevelFile(e.level), C.readEetas(f));
				replayed = ev ? ev.runTicks : -1;
			}
			row = Object.assign({}, e, { before: r.before, after: r.runTicks, saved: r.saved, accepted: r.accepted, replayed, waypoints: r.waypoints, legs: r.legs.length,
				proven: r.proven, provenTicks: r.provenTicks, proveAsked: r.proveAsked, lbSum: r.lbSum, fasterLegs: r.fasterLegs, passes: r.passes, stats: r.stats, ms: r.ms,
				legSum: r.legs.reduce((a, g) => a + g.ticks, 0), provenBy: r.legs.reduce((a, g) => { if (g.proven) a[g.provenBy] = (a[g.provenBy] || 0) + 1; return a; }, {}) });
		} catch (err) { row = Object.assign({}, e, { error: String(err && err.stack || err) }); }
		row.wall = Date.now() - t;
		fs.appendFileSync(outF, JSON.stringify(row) + '\n');
		console.log(`${row.rel}: ${row.error ? 'ERROR ' + row.error.split('\n')[0] : `${row.before} -> ${row.after} (${row.saved}) proven ${row.proven}/${row.legs} legs, ${Math.round(row.wall / 100) / 10} s`}`);
	}
}

function agg() {
	const rows = [];
	for (const f of fs.readdirSync(argv.agg).filter((f) => /^joins_\d+\.jsonl$/.test(f))) for (const l of fs.readFileSync(path.join(argv.agg, f), 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l));
	rows.sort((a, b) => a.rel.localeCompare(b.rel));
	const r2 = (x) => (Number.isFinite(x) ? (Math.round(x * 100) / 100).toFixed(2) : '-');
	console.log('| level | pass | compiled | before | after | saved | best known | before / best | after / best | route lb | after / lb | legs (proven) | proven ticks | passes | wall s |');
	console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---:|');
	let sb = 0, sa = 0, pr = 0, lg = 0, sc = 0;
	for (const r of rows) {
		if (r.error) { console.log(`| ${r.rel} | ${r.pass} | ERROR ${r.error.split('\n')[0]} |`); continue; }
		sb += r.before; sa += r.after; pr += r.proven; lg += r.legs; sc += r.compiled || r.before;
		console.log(`| ${r.rel} | ${r.pass} | ${r.compiled} | ${r.before} | **${r.after}** | ${r.saved} | ${r.best || '-'} | ${r2(r.best ? r.before / r.best : NaN)} | ${r2(r.best ? r.after / r.best : NaN)} | ${r.lb || '-'} | ${r2(r.lb ? r.after / r.lb : NaN)} | ${r.legs} (${r.proven}) | ${r.provenTicks} | ${(r.passes || []).map((p) => p.to).join(' > ')} | ${Math.round(r.wall / 100) / 10} |`);
	}
	const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[b.length >> 1] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN; };
	const wb = rows.filter((r) => r.best && !r.error);
	console.log(`\nall: ${rows.length} levels, compiled ${sc}, before ${sb}, after ${sa} (saved ${sb - sa}; ${sc - sa} from the compile), legs ${lg}, proven ${pr}; median / best known over ${wb.length}: compiled ${r2(med(wb.map((r) => r.compiled / r.best)))}, before ${r2(med(wb.map((r) => r.before / r.best)))}, after ${r2(med(wb.map((r) => r.after / r.best)))}; at or under the best known: ${wb.filter((r) => r.after <= r.best).length}`);
}

if (argv.agg) agg();
else if (argv.final && WT.isMainThread && +argv.threads > 1) {
	const N = +argv.threads;
	for (let i = 0; i < N; i++) {
		const args = ARGS.filter((a) => !a.startsWith('--threads=') && !a.startsWith('--shard=')).concat([`--shard=${i}/${N}`]);
		const w = new WT.Worker(__filename, { workerData: { args } });
		w.on('error', (e) => console.error(`worker ${i}: ${e.stack || e}`));
	}
} else if (argv.final) batch();
else {
	const r = one(pos[0], pos[1]);
	if (argv.json) console.log(JSON.stringify(r));
	else console.log(`${r.before} -> ${r.runTicks} (saved ${r.saved}, accepted ${r.accepted}), ${r.waypoints} waypoints, legs ${r.legs.length}, proven ${r.proven} (${r.provenTicks} ticks), msolve faster on ${r.fasterLegs}, ${r.ms} ms; passes ${JSON.stringify(r.passes.map((p) => [p.gap, p.from, p.to, p.waypoints, p.skips, p.legsUsed, p.ms]))}; stats ${JSON.stringify(r.stats)}${r.replayed !== null ? `; replayed ${r.replayed}` : ''}`);
}

'use strict';
// THE GAP REPORT: per compiled level the route's run ticks, the compile's own lower bound (its report), the order-aware
// route bound (src/math/routelb.js runBound), the best of both, the gap before / after, and a proof when one exists.
//   node tools/perfect/gaprep.js <compile out dir (route .eetas + .json pairs)> <levels root (campaign/, hard/)>
//     [--shard=i/n] [--ms=20000] [--out=<file.jsonl>] [--only=<substring>] [--proofs=<dir of provelevel result jsons>]
// The .json is the compile's --report (runTicks, lb); the level file is <root>/<set>/<name>.eelvl from the report's
// file name (campaign__<name> / hard__<name>).
const fs = require('fs');
const path = require('path');
const T = require('../../src/plan/types.js');
const Cm = require('../../src/common.js');
const R = require('../../src/math/routelb.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const [dir, root] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [shI, shN] = (args.shard || '0/1').split('/').map(Number);
const ms = +args.ms || 20000;
const out = args.out ? fs.openSync(args.out, 'a') : null;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.eetas')).sort();
let k = 0;
for (const f of files) {
	if ((k++) % shN !== shI) continue;
	if (args.only && !f.toLowerCase().includes(String(args.only).toLowerCase())) continue;
	const base = f.replace(/\.eetas$/, '');
	const m = /^(campaign|hard|d4)__(.*)$/.exec(base);
	if (!m) continue;
	const lf = path.join(root, m[1], m[2] + '.eelvl');
	if (!fs.existsSync(lf)) { console.log(`  no level ${lf}`); continue; }
	let rep = {};
	try { rep = JSON.parse(fs.readFileSync(path.join(dir, base + '.json'), 'utf8')); } catch (e) { rep = {}; }
	const L = T.loadLevelFile(lf);
	const masks = Cm.readEetas(path.join(dir, f));
	const ev = Cm.evaluate(L, masks, false);
	if (!ev) { console.log(`  ${base}: the route does not finish`); continue; }
	const t0 = Date.now();
	let rb = { lb: 0 };
	try { const rl = R.createRouteLB(L, {}); rb = rl.runBound({ ms }); } catch (e) { rb = { lb: 0, error: e.message }; }
	const old = Number.isFinite(+rep.lb) ? +rep.lb : 0;
	const nb = Number.isFinite(rb.lb) ? rb.lb : 0;
	const best = Math.max(old, nb);
	const run = ev.runTicks;
	const rec = { level: base, run, oldLb: old, newLb: nb, lb: best, gapOld: run - old, gap: run - best, gapPctOld: Math.round(1000 * (run - old) / run) / 10, gapPct: Math.round(1000 * (run - best) / run) / 10,
		known: rep.known && rep.known.runTicks ? rep.known.runTicks : null, complete: !!rb.complete, order: (rb.order || []).slice(0, 8), ms: Date.now() - t0, error: rb.error || null };
	if (args.proofs) {
		try { const p = JSON.parse(fs.readFileSync(path.join(args.proofs, base + '.json'), 'utf8')); if (p.status === 'proof') { rec.proven = true; rec.provenC = p.C; if (p.C >= run) { rec.lb = run; rec.gap = 0; rec.gapPct = 0; } } } catch (e) { /* none */ }
	}
	if (out) fs.writeSync(out, JSON.stringify(rec) + '\n');
	console.log(`  ${base}: run ${run} lb ${old} -> ${nb} (best ${best}) gap ${rec.gapPctOld}% -> ${rec.gapPct}% ${rec.ms} ms ${rec.error || ''}`);
}

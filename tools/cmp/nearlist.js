'use strict';
// THE NEAR MISSES of a compile log (C6 lane 3 block 3): the failed steps whose closest tile is within --d tiles of the target
// (rung >= --rung), one row per (anchor, label), the latest first: the input of tools/cmp/nearkrt.js.
//   node tools/cmp/nearlist.js <compile.log> [--d=3] [--rung=2] [--max=2]
// Prints one JSON line per row: {anchor, label, rung, closest, ctile, t}.
const fs = require('fs');
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const file = argv.find((s) => !s.startsWith('--'));
const D = +opt('d', 3), R = +opt('rung', 2), MAX = +opt('max', 2);
const rows = new Map();
for (const s of fs.readFileSync(file, 'utf8').split('\n')) {
	if (!s.startsWith('{"ev":"step"')) continue;
	let e; try { e = JSON.parse(s); } catch (x) { continue; }
	if (e.ok || !e.closest || !(e.closest.dist >= 0) || e.closest.dist > D || (e.rung | 0) < R) continue;
	const k = e.anchor + '|' + e.label;
	const r = rows.get(k);
	if (!r || e.t > r.t) rows.set(k, { anchor: e.anchor, label: String(e.label).replace(/ x\d+$/, ''), rung: e.rung, closest: e.closest.dist, ctile: e.closest.tile, t: e.t });
}
const out = [...rows.values()].sort((a, b) => b.t - a.t);
const seenL = new Set(), pick = [];
for (const r of out) { if (seenL.has(r.label)) continue; seenL.add(r.label); pick.push(r); if (pick.length >= MAX) break; }
for (const r of pick) console.log(JSON.stringify(r));

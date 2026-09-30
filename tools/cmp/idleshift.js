'use strict';
// THE IDLE SHIFT on finished routes (n5-tricks 3; src/plan/polish.js idleShift): every rest of a route (the ball's
// clock-blind state the same tick after tick) cut, the clock kept by idle ticks before the first input (free: the run's
// timer starts at the first input), each candidate replayed by the engine and kept only when it finishes faster with no
// more deaths and no lower random-portal chance.
// node tools/cmp/idleshift.js [--known=1] [--root=<truth root>] [--only=<name>] [--ms=3000] [--out=<dir>]
//                             [--eetas=<file.eetas> --level=<file.eelvl>]... (pairs: a route and its level)
// -> one JSON line a route {name, runTicks, saved, rests, tries, steps} (and <out>/idleshift.jsonl). A tool only.
const fs = require('fs');
const path = require('path');
const C = require('../../src/common.js');
const T = require('../../src/plan/types.js');
const TS = require('../../src/plan/truthset.js');
const P = require('../../src/plan/polish.js');

const args = { eetas: [], level: [] };
for (const a of process.argv.slice(2)) {
	const m = /^--([^=]+)=(.*)$/.exec(a);
	if (!m) continue;
	if (m[1] === 'eetas' || m[1] === 'level') args[m[1]].push(m[2]); else args[m[1]] = m[2];
}
const MS = +args.ms || 3000;
const out = args.out ? path.resolve(args.out) : null;
if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'idleshift.jsonl'), ''); }
const emit = (r) => { const l = JSON.stringify(r); process.stdout.write(l + '\n'); if (out) fs.appendFileSync(path.join(out, 'idleshift.jsonl'), l + '\n'); };

let tot = 0, n = 0, gained = 0;
function one(name, L, masks) {
	const ev = C.evaluate(L, masks, true);
	if (!ev) { emit({ name, stale: true }); return; }
	const r = P.idleShift(L, ev.ms, { deadline: Date.now() + MS });
	const ev2 = C.evaluate(L, r.masks, true);
	const saved = ev2 ? ev.runTicks - ev2.runTicks : 0;
	n++; tot += saved; if (saved > 0) gained++;
	emit({ name, runTicks: ev.runTicks, saved, verified: !!ev2, deaths: ev2 ? ev2.deaths : null, rests: r.rests, tries: r.tries, steps: r.steps, ms: r.ms });
}
if (args.known !== '0' && !args.eetas.length) {
	let list = TS.knownRoutes({ root: args.root });
	if (args.only) list = list.filter((e) => e.name.toLowerCase().includes(args.only.toLowerCase()));
	for (const e of list) {
		const tr = TS.loadTruth(e);
		if (!tr) { emit({ name: e.name, route: e.route, stale: true }); continue; }
		one(e.name, tr.L, tr.masks);
	}
}
for (let i = 0; i < args.eetas.length; i++) one(path.basename(args.eetas[i]), T.loadLevelFile(args.level[i] || args.level[0]), C.readEetas(args.eetas[i]));
process.stderr.write(`idle shift: ${n} routes, ${gained} faster, ${tot} ticks saved\n`);

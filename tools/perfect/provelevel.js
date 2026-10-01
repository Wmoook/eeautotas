'use strict';
// node tools/perfect/provelevel.js <level.eelvl> [--route=<route.eetas>] [--C=<layers>] [--threads=4] [--seconds=600]
//   [--split=3] [--ttBits=22] [--out=<best.eetas>] [--json=<result.json>]
// The whole-level proof (src/plan/levelproof.js): with a route of R run ticks, C = R proves it TAS-perfect or finds a
// faster one (then proves that one). Prints JSON lines (tasks, found, progress) and the result.
const fs = require('fs');
const path = require('path');
const C = require('../../src/common.js');
const LP = require('../../src/plan/levelproof.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
(async () => {
	const o = {
		threads: +args.threads || 4, seconds: +args.seconds || 600, split: args.split !== undefined ? +args.split : 3, ttBits: +args.ttBits || 22,
		onProgress: (ev) => console.log(JSON.stringify(ev)),
	};
	if (args.route) o.route = C.readEetas(args.route);
	if (args.C) o.C = +args.C;
	const r = await LP.proveLevel({ file: path.resolve(file) }, o);
	const out = Object.assign({}, r, { level: path.basename(file), best: r.best ? r.best.length : null });
	if (r.best && args.out) { C.writeEetas(args.out, r.best); out.bestFile = args.out; }
	console.log(JSON.stringify(Object.assign({ ev: 'result' }, out)));
	if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
	process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

'use strict';
// test/fieldshare.js: types.js THE SHARED FIELDS (EEAT_FIELD_SHARE=1). The main thread builds a goal field, publishes it to a
// worker thread (as the executor's pool does), and the worker's goalField for the same key takes it (a hit, no build) with
// the same bytes as a field the worker builds itself; the field's arrays are SharedArrayBuffer-backed; with the knob off
// nothing is published. A level: --level=<file.eelvl>, else the first of a few known paths (skipped when none is here).
//   node test/fieldshare.js [--level=<file.eelvl>]
process.env.EEAT_FIELD_SHARE = '1';
const path = require('path'), fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const root = path.join(__dirname, '..');
const T = require(path.join(root, 'src/plan/types.js'));
const RF = require(path.join(root, 'src/reach.js'));
const M = require(path.join(root, 'src/plan/model.js'));

function goalsOf(file) {
	const L = T.loadLevelFile(file);
	const model = M.compileModel(L, { file });
	const sim = T.playTo(L, new Uint8Array(0)).sim;
	return { L, sim, tiles: model.triggers[0].tiles };
}
const same = (a, b) => {
	for (const k of Object.keys(a)) {
		const x = a[k], y = b[k];
		if (ArrayBuffer.isView(x)) { if (!ArrayBuffer.isView(y) || x.length !== y.length) return `${k}: length`; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${k}[${i}]`; }
		else if (typeof x !== 'object' && x !== y && k !== 'ms') return `${k}: ${x} vs ${y}`;
	}
	return null;
};

if (!isMainThread) {
	const { file } = workerData;
	const { L, sim, tiles } = goalsOf(file);
	let calls = 0;
	const rf0 = RF.reachField;
	RF.reachField = function () { calls++; return rf0.apply(this, arguments); };
	parentPort.on('message', (msg) => {
		if (msg.type === 'field') { T.shareIn(msg.key, msg.f); return; }
		if (msg.type === 'go') {
			const f = T.goalField(T.levelNow(L, sim), tiles, { deaths: false, plainFx: T.plainOf(sim) });
			const built = calls;
			const own = rf0(T.levelNow(L, sim), { goals: Array.from(tiles, (t) => ({ tile: t, cost: 0 })), deaths: false });
			const sab = Object.keys(f).filter((k) => ArrayBuffer.isView(f[k])).every((k) => f[k].buffer instanceof SharedArrayBuffer);
			parentPort.postMessage({ built, diff: f.mode === own.mode && !f.fx && !f.prot ? same(f, own) : 'skip', sab, stats: T.shareStats(), mode: f.mode });
		}
	});
	return;
}

const arg = process.argv.find((s) => s.startsWith('--level='));
const cands = [arg && arg.split('=')[1], path.join(root, '../../../src/out/god/levels/campaign/00_1_Tutorial_1.eelvl'), path.join(root, 'src/out/god/levels/campaign/00_1_Tutorial_1.eelvl'),
	process.env.EEAT_TRUTH_ROOT && path.join(process.env.EEAT_TRUTH_ROOT, 'src/out/god/levels/campaign/00_1_Tutorial_1.eelvl')].filter(Boolean);
const file = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!file) { console.log('fieldshare: no level file here (--level=<file.eelvl>): skipped'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok   ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const w = new Worker(__filename, { workerData: { file } });
const sent = [];
T.setFieldShare((key, f) => { sent.push(key); w.postMessage({ type: 'field', key, f }); });
const { L, sim, tiles } = goalsOf(file);
const f = T.goalField(T.levelNow(L, sim), tiles, { deaths: false, plainFx: T.plainOf(sim) });
ok(sent.length >= 1, `the main thread's build published (${sent.length} field(s))`);
ok(Object.keys(f).filter((k) => ArrayBuffer.isView(f[k])).every((k) => f[k].buffer instanceof SharedArrayBuffer), 'the published field\'s arrays are SharedArrayBuffer-backed');
w.postMessage({ type: 'go' });
w.on('message', (r) => {
	ok(r.built === 0, `the worker took the shared field (reachField calls ${r.built}, hits ${r.stats.hits}, got ${r.stats.got})`);
	ok(r.sab, 'the worker\'s field is the shared memory');
	ok(r.diff === null || r.diff === 'skip', `the shared field = the worker's own build (${r.diff === null ? 'the same bytes' : r.diff}, mode ${r.mode})`);
	console.log(`fieldshare: ${pass}/${fail}`);
	w.terminate();
	process.exitCode = fail ? 1 : 0;
});

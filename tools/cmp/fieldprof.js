'use strict';
// tools/cmp/fieldprof.js: one goal field (types.js goalField, the compiler's defaults applied) built R times on a level,
// with the memo cleared between builds, timed by phase through node's inspector profiler (self time by function).
//   node tools/cmp/fieldprof.js <level.eelvl> [--rounds=3] [--trig=0] [--top=15]
const path = require('path');
const root = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
require(path.join(root, 'src/plan/defaults.js')).apply();
const T = require(path.join(root, 'src/plan/types.js'));
const M = require(path.join(root, 'src/plan/model.js'));
const RF = require(path.join(root, 'src/reach.js'));
const opt = (k, d) => { const a = args.find((s) => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const file = args.find((s) => !s.startsWith('--'));
const R = +opt('rounds', 3), ti = +opt('trig', 0), top = +opt('top', 15);
const L = T.loadLevelFile(file);
const model = M.compileModel(L, { file });
const sim = T.playTo(L, new Uint8Array(0)).sim;
const tr = model.triggers[ti];
const insp = require('inspector');
const ses = new insp.Session();
ses.connect();
const post = (m, p) => new Promise((res, rej) => ses.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
(async () => {
	await post('Profiler.enable');
	await post('Profiler.setSamplingInterval', { interval: 200 });
	await post('Profiler.start');
	const ms = [];
	for (let r = 0; r < R; r++) {
		const Lc = T.levelNow(L, sim);   // a fresh fg copy: a memo miss every round
		const t0 = Date.now();
		RF.reachField(Lc, { goals: tr.tiles.map((t) => ({ tile: t, cost: 0 })), deaths: false });
		ms.push(Date.now() - t0);
	}
	const { profile: P } = await post('Profiler.stop');
	const byId = new Map(P.nodes.map((n) => [n.id, n]));
	const self = new Map();
	let total = 0;
	for (let i = 0; i < P.samples.length; i++) {
		const n = byId.get(P.samples[i]);
		const us = P.timeDeltas[i] || 0;
		total += us;
		const k = `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url || '')}:${n.callFrame.lineNumber + 1}`;
		self.set(k, (self.get(k) || 0) + us);
	}
	console.log(`${path.basename(file)} ${L.width}x${L.height} trigger ${tr.label}: builds ${ms.join(' / ')} ms`);
	for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${(us / 1000).toFixed(0).padStart(6)} ms ${(100 * us / total).toFixed(1).padStart(5)}%  ${k}`);
})();

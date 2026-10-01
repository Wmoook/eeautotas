'use strict';
// tools/cmp/cpuprof.js: the self time by function of V8 .cpuprofile files (node --cpu-prof; NODE_OPTIONS reaches the
// compile's worker threads and child processes too), and the inclusive time of a few named functions.
//   node tools/cmp/cpuprof.js <dir or files>... [--top=25] [--incl=reachField,goalField,...]
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const top = +((args.find((s) => s.startsWith('--top=')) || '--top=25').split('=')[1]);
const incl = ((args.find((s) => s.startsWith('--incl=')) || '--incl=reachField,goalField,fieldAt,levelNow').split('=')[1]).split(',').filter(Boolean);
let files = [];
for (const a of args.filter((s) => !s.startsWith('--'))) {
	if (fs.statSync(a).isDirectory()) files.push(...fs.readdirSync(a).filter((f) => f.endsWith('.cpuprofile')).map((f) => path.join(a, f)));
	else files.push(a);
}
for (const file of files.sort()) {
	const P = JSON.parse(fs.readFileSync(file, 'utf8'));
	const byId = new Map();
	for (const n of P.nodes) byId.set(n.id, n);
	const parent = new Map();
	for (const n of P.nodes) for (const c of n.children || []) parent.set(c, n.id);
	const dt = new Map();   // node id -> sampled microseconds
	for (let i = 0; i < P.samples.length; i++) dt.set(P.samples[i], (dt.get(P.samples[i]) || 0) + (P.timeDeltas[i + 1] || P.timeDeltas[i] || 0));
	let total = 0;
	const self = new Map(), inc = new Map();
	for (const [id, us] of dt) {
		total += us;
		const n = byId.get(id);
		const cf = n.callFrame;
		const key = `${cf.functionName || '(anon)'} ${path.basename(cf.url || '')}:${cf.lineNumber + 1}`;
		self.set(key, (self.get(key) || 0) + us);
		// inclusive: each named function once per sample stack
		const seen = new Set();
		for (let p = id; p !== undefined; p = parent.get(p)) {
			const fn = byId.get(p).callFrame.functionName;
			if (incl.includes(fn) && !seen.has(fn)) { seen.add(fn); inc.set(fn, (inc.get(fn) || 0) + us); }
		}
	}
	// --callers=<fn>: the call paths (up to 6 frames above it) of the samples inside that function, by their time
	const callersOf = (args.find((s) => s.startsWith('--callers=')) || '').split('=')[1];
	if (callersOf) {
		const paths = new Map();
		for (const [id, us] of dt) {
			let p = id, hit = -1;
			const chain = [];
			for (let q = id; q !== undefined; q = parent.get(q)) chain.push(q);
			for (let k = 0; k < chain.length; k++) if (byId.get(chain[k]).callFrame.functionName === callersOf) { hit = k; break; }
			if (hit < 0) continue;
			const up = chain.slice(hit + 1, hit + 7).map((q) => { const cf = byId.get(q).callFrame; return `${cf.functionName || '(anon)'}:${cf.lineNumber + 1}`; }).join(' < ');
			paths.set(up, (paths.get(up) || 0) + us);
			void p;
		}
		console.log(`  callers of ${callersOf}:`);
		for (const [k, us] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${(us / 1e6).toFixed(2).padStart(7)} s  ${k}`);
	}
	const idle = ['(idle)', '(program)', '(garbage collector)'].map((k) => [...self.entries()].filter(([s]) => s.startsWith(k + ' ')).reduce((a, [, v]) => a + v, 0));
	console.log(`== ${path.basename(file)} total ${(total / 1e6).toFixed(1)} s (idle ${(idle[0] / 1e6).toFixed(1)}, program ${(idle[1] / 1e6).toFixed(1)}, gc ${(idle[2] / 1e6).toFixed(1)}); inclusive ${incl.map((k) => `${k} ${((inc.get(k) || 0) / 1e6).toFixed(1)} s`).join(', ')}`);
	for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${(us / 1e6).toFixed(2).padStart(7)} s ${(100 * us / total).toFixed(1).padStart(5)}%  ${k}`);
}

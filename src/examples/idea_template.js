'use strict';
// Template for AI assistants and power users (copy it to src/out/ and edit it): try many small input changes around
// one moment of a job's best run, each checked EXACTLY (J.probe plays the inputs from the best run's exact state, then
// looks for an exact rejoin), and write the best verified candidate.
// usage: node src/examples/idea_template.js <job> <time|tick> [window ticks]
const path = require('path');
const C = require('../common.js');
const J = require('../jobs.js');

const [jobQ, at, win] = process.argv.slice(2);
const id = J.resolve(jobQ);
const level = J.loadJobLevel(id);
const best = C.readEetas(path.join(J.jobDir(id), 'best.eetas'));
const tr = C.replay(level, best, { trace: true });
const t0 = C.tickOf(tr, C.parseTime(at));
const W = +win || 40;
const base = Array.from(best.slice(t0, t0 + W + 20));   // the best run's inputs from t0
const nocoins = !!C.readJSON(path.join(J.jobDir(id), 'status.json'), {}).coinsOptional;
const ctx = J.probeContext(level, best, nocoins);   // built once: every probe below reuses it
const OPTS = [0, 1, 2, 3, 4, 5, 8, 9, 16, 17, 10, 12, 18, 20];   // - J L L+J R R+J U U+J D D+J L+U R+U L+D R+D
let top = null, tried = 0;
for (let d = 0; d < W; d++) {                  // where the change starts
	for (const L of [1, 2, 3]) {               // hold one input for L ticks...
		for (const D of [0, 1, 2]) {           // ...and drop D more ticks of the best run
			for (const o of OPTS) {
				const inputs = base.slice(0, d).concat(new Array(L).fill(o), base.slice(d + L + D));
				const p = J.probe(level, best, { tick: t0 }, inputs, { ctx, nocoins, shift: 0 });   // shift 0: rejoin within the inputs only
				tried++;
				if (p.candidate && p.candidate.saved > 0 && (!top || p.candidate.saved > top.saved)) {
					top = { saved: p.candidate.saved, time: p.candidate.time, change: `tick ${t0 + d}: ${C.maskName(o)} x${L}, drop ${D}`, masks: p.candidate.masks };
					console.log(`found -${top.saved}: ${top.change} -> ${top.time}`);
				}
			}
		}
	}
}
console.log(`${tried} variants tried around tick ${t0} (${C.fmt(tr.RUN[t0])})`);
if (top) {
	const file = path.join(J.jobDir(id), 'probes', `idea_${t0}.eetas`);
	C.writeEetas(file, top.masks);
	console.log(`best: ${top.change}, ${top.time}; hand it in: node src/tas.js try ${id} "${file}"`);
}

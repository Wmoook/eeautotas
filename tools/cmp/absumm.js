'use strict';
// The A/B summary of tools/cmp/abseq.sh's --json compiles: per level and side the result (routed, run ticks, triggers
// gained), the skeleton's progress (per waypoint label the deepest c any exec.skel event reached, the restarts: exec.skel
// 'resumed: false' after the label's first), the steps, the walls events.   node tools/cmp/absumm.js <ab dir>
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => /_[AB]\.log$/.test(x)).sort()) {
	const m = f.match(/^(.*)_([AB])\.log$/);
	const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
	const skel = new Map();
	let steps = 0, walls = 0, gain = 0, done = null, rep = null;
	for (const l of lines) {
		if (!l.startsWith('{')) continue;
		let e;
		try { e = JSON.parse(l); } catch (x) { continue; }
		if (e.ev === 'exec.skel') {
			let s = skel.get(e.label);
			if (!s) { s = { c0: e.c0, min: Infinity, calls: 0, restarts: 0 }; skel.set(e.label, s); }
			if (s.calls > 0 && !e.resumed) s.restarts++;
			s.calls++;
			s.min = Math.min(s.min, e.c);
		} else if (e.ev === 'step') steps++;
		else if (e.ev === 'exec.walls') walls++;
		else if (e.ev === 'progress' && e.triggers > gain) gain = e.triggers;
		else if (e.ev === 'done') done = e;
		else if (e.ev === 'report') rep = e;
	}
	const top = Array.from(skel.entries()).sort((a, b) => b[1].calls - a[1].calls).slice(0, 2).map(([k, s]) => `${k}: ${s.c0}->${s.min} (${s.calls} calls, ${s.restarts} restarts)`);
	rows.push({ level: m[1], side: m[2], ok: !!(rep && rep.ok), runTicks: rep ? rep.runTicks : null, gain, steps, walls, skel: top.join('; ') });
}
for (const r of rows) console.log(`${r.level.padEnd(30)} ${r.side} ok ${r.ok ? 'Y' : '-'} ticks ${r.runTicks === null ? '-' : r.runTicks} gain ${r.gain} steps ${r.steps} walls ${r.walls} | ${r.skel}`);

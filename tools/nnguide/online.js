'use strict';
// The online test: src/goexplore.js --track=<the judge's route> (the furthest tick of it a cell reached) on held-out
// levels, one worker per run with a tick budget (deterministic), without (mix 0) and with the held-out model ordering
// head A (--guide, --guideMix).
//   node tools/nnguide/online.js --models=<dir> --tag=v1 --levels=ice,octo,fv,ip,dotring --seeds=1,2,3 --maxTicks=100000000
//     [--par=6] [--mixes=0,1] [--out=online_v1.json]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const WORK = process.env.NN_WORK || path.join(__dirname, '..', '..', 'src', 'out', 'nnguide');
const bundle = path.join(WORK, 'bundle');
const cat = JSON.parse(fs.readFileSync(path.join(bundle, 'catalog.json'), 'utf8'));
const models = arg('models', '/root/nnguide/models'), tag = arg('tag', 'v1');
const levels = arg('levels', 'ice,octo,fv,ip,dotring').split(','), seeds = arg('seeds', '1,2,3').split(',').map(Number);
const mixes = arg('mixes', '0,1').split(',').map(Number), maxTicks = +arg('maxTicks', 60000000), par = +arg('par', 6);
const out = arg('out', `online_${tag}.json`);
// the level each group's search runs on: the judge route's level (ice: the .eelvl of Find a route, ice200)
const lvOf = { ice: 'ice200' };
const jobs = [];
for (const g of levels) {
	let lv = null, route = null;
	for (const c of cat) for (const r of c.routes) if (r.eval === g) { lv = c.lv; route = path.join(bundle, 'routes', c.lv, r.name); }
	if (lvOf[g]) lv = lvOf[g];
	for (const seed of seeds) for (const mix of mixes) jobs.push({ g, lv, route, seed, mix });
}
/** per level and mix: the furthest route tick reached (median, each seed), the seeds with a route, the seconds */
function summary(rs) {
	const lines = ['| level | guide mix | seeds | furthest route tick: median (each seed) | routes found | seconds (mean) |', '|---|---|---|---|---|---|'];
	const keys = [...new Set(rs.map((r) => `${r.g}|${r.mix}`))];
	for (const k of keys) {
		const [g, mix] = k.split('|');
		const s = rs.filter((r) => r.g === g && String(r.mix) === mix).sort((x, y) => x.seed - y.seed);
		const tm = s.map((r) => r.trackMax).sort((x, y) => x - y);
		const med = tm.length % 2 ? tm[(tm.length - 1) >> 1] : (tm[tm.length / 2 - 1] + tm[tm.length / 2]) / 2;
		const found = s.filter((r) => r.firstRoute);
		lines.push(`| ${g} | ${mix} | ${s.length} | ${med} (${s.map((r) => r.trackMax).join(', ')}) | ${found.length}${found.length ? ` (first after ${found.map((r) => (r.firstRoute.simTicks / 1e6).toFixed(1)).join(', ')} M ticks)` : ''} | ${(s.reduce((a, r) => a + (r.sec || 0), 0) / s.length).toFixed(0)} |`);
	}
	return lines.join('\n');
}
if (process.argv.includes('--summary')) { console.log(summary(JSON.parse(fs.readFileSync(out, 'utf8')))); process.exit(0); }
const results = [];
let next = 0, running = 0;
const t0 = Date.now();
function launch() {
	while (running < par && next < jobs.length) {
		const j = jobs[next++];
		running++;
		const args = [path.join(__dirname, '..', '..', 'src', 'goexplore.js'), path.join(bundle, 'levels', j.lv + '.json'), '--workers=1', `--seed=${j.seed}`, `--maxTicks=${maxTicks}`, '--seconds=3600',
			`--track=${j.route}`, '--mem=1500'];
		if (j.mix > 0) args.push(`--guide=${path.join(models, `${tag}_${j.g}.json`)}`, `--guideMix=${j.mix}`);
		const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let buf = '', done = null, first = null;
		p.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k); buf = buf.slice(k + 1);
				if (line.startsWith('{')) { try { const e = JSON.parse(line); if (e.ev === 'done') done = e; if (e.ev === 'result' && !first) first = e; } catch (e) { /* not json */ } }
			}
		});
		p.stderr.on('data', (d) => process.stderr.write(d));
		p.on('exit', () => {
			running--;
			const w = done && done.workers[0] || {};
			const r = Object.assign({}, j, { sec: done ? done.seconds : null, ticks: done ? done.ticks : null, end: done ? done.end : null, firstRoute: first ? { ticks: first.ticks, simTicks: first.simTicks, sec: first.sec } : null,
				best: done ? done.finish : 0, trackMax: w.trackMax, trackTicks: w.trackTicks, cells: w.cells, rooms: w.rooms, guideCalls: w.guideCalls, guideStates: w.guideStates });
			results.push(r);
			console.log(JSON.stringify(r));
			fs.writeFileSync(out, JSON.stringify(results, null, 1));
			if (next >= jobs.length && running === 0) {
				console.log(`all done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
				console.log(summary(results));
			}
			launch();
		});
	}
}
launch();

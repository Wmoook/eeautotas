'use strict';
// batch.js <out.jsonl> <jobs.json>: runs xp configs one after the other; jobs = [{exe, level, args: [...], watch}] ;
// appends {level, args, ...result, watch: first watch tick} per job and prints a summary line per job
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [out, jobsFile] = process.argv.slice(2);
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
const LV = path.join(__dirname, '..', 'lv');
for (const j of jobs) {
	const exe = path.join(__dirname, j.exe || 'xp_k.exe');
	const argv = [path.join(LV, `${j.level}.bin`), path.join(LV, `${j.level}.reach`), ...j.args];
	const t0 = Date.now();
	const r = spawnSync(exe, argv, { encoding: 'utf8', maxBuffer: 1 << 28 });
	const lines = (r.stdout || '').trim().split('\n');
	let res = null;
	try { res = JSON.parse(lines.pop()); } catch (e) { res = { error: (r.stderr || '').slice(-400) }; }
	const w = (r.stderr || '').split('\n').filter((l) => l.startsWith('watch'));
	res.level = j.level; res.args = j.args.join(' '); res.watchFirst = w[0] || null; res.wall = (Date.now() - t0) / 1000;
	fs.appendFileSync(out, JSON.stringify(res) + '\n');
	console.log(`${j.level} ${res.args}: ${res.end} finish ${res.finish} states ${(res.states / 1e6).toFixed(1)}M ticks ${(res.ticks / 1e6).toFixed(0)}M ${res.wall.toFixed(0)}s | ${res.watchFirst || 'no watch'}`);
}

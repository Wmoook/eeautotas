'use strict';
// sweep.js <out.jsonl> <level> <salts a-b> [xp args...]: runs xp.exe once per salt, appends the JSON lines (with the
// level and args) to out.jsonl, prints a one-line summary per run. Levels: user30s, shaft, stairs, 213 (src/out/lv).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [out, level, range, ...args] = process.argv.slice(2);
const [a, b] = range.split('-').map(Number);
const LV = path.join(__dirname, '..', 'lv');
const exe = process.env.XP_EXE || path.join(__dirname, 'xp.exe');
let hits = 0, n = 0;
for (let salt = a; salt <= (Number.isFinite(b) ? b : a); salt++) {
	const argv = [path.join(LV, `${level}.bin`), path.join(LV, `${level}.reach`), `--salt=${salt}`, '--quiet=1', ...args];
	const r = spawnSync(exe, argv, { encoding: 'utf8', maxBuffer: 1 << 26 });
	const line = (r.stdout || '').trim().split('\n').pop();
	let j = null;
	try { j = JSON.parse(line); } catch (e) { console.log(`salt ${salt}: bad output ${line} ${r.stderr.slice(-300)}`); continue; }
	j.level = level; j.args = args.join(' ');
	fs.appendFileSync(out, JSON.stringify(j) + '\n');
	n++; if (j.finish > 0) hits++;
	console.log(`${level} salt ${salt} ${args.join(' ')}: ${j.end} finish ${j.finish} layers ${j.layers} states ${(j.states / 1e6).toFixed(2)}M ticks ${(j.ticks / 1e6).toFixed(1)}M ${j.sec}s bestRc ${j.bestRc}`);
}
console.log(`${level} ${args.join(' ')}: ${hits}/${n} salts find a route`);

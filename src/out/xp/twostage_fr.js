'use strict';
// twostage.js <out.jsonl> <level> <salts a-b> [afx afv] [threads] [extra stage-2 args...]: "refine along the closest
// attempt": stage 1 = the plain finest pass (salt s); no route -> its closest attempt (the state nearest the trophy by
// the reach field, and its inputs); stage 2 = the same pass (salt s) where every state in a situation (exact py, vy,
// on ground, jumps, centre tile) that the closest attempt passed through gets cells afx x finer in px and afv x finer
// in vx. Appends one JSON line per salt: both stages' states / ticks and the routes.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [out, level, range, afx = '4', afv = '4', threads = '4', ...extra] = process.argv.slice(2);
const [a, b] = range.split('-').map(Number);
const LV = path.join(__dirname, '..', 'lv');
const W = { user30s: '--watch=496,527.99999,591.5,592.5,-1', shaft: '--watch=368,399.99999,207.5,208.5,-1' }[level];
const run = (exe, args) => {
	const r = spawnSync(path.join(__dirname, exe), [path.join(LV, `${level}.bin`), path.join(LV, `${level}.reach`), ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
	const j = JSON.parse((r.stdout || '').trim().split('\n').pop());
	const cl = (r.stderr || '').split('\n').find((l) => l.startsWith('closest:'));
	if (cl) j.closestInputs = cl.split('inputs ')[1].trim();
	return j;
};
for (let s = a; s <= (Number.isFinite(b) ? b : a); s++) {
	const t0 = Date.now();
	const ff = path.join(LV, `${level}_front_s${s}.txt`);
	const s1 = run('xp_fr.exe', ['--pass=2', `--salt=${s}`, `--threads=${threads}`, '--quiet=1', `--frontier=${ff}`, ...(W ? [W] : [])]);
	let s2 = null;
	if (!(s1.finish > 0)) {


		s2 = run('xp_fr.exe', ['--pass=2', '--rule=adapt', '--routeZone=1', `--zoneFiles=${ff}`, `--afx=${afx}`, `--afv=${afv}`, `--salt=${s}`, `--threads=${threads}`, '--quiet=1', ...extra, ...(W ? [W] : [])]);
	}
	const rec = { level, salt: s, afx: +afx, afv: +afv, extra: extra.join(' '), stage1: { finish: s1.finish, states: s1.states, ticks: s1.ticks, closestTick: s1.bestRcLayer + 1, closestRc: s1.bestRc },
		stage2: s2 && { finish: s2.finish, states: s2.states, ticks: s2.ticks, inputs: s2.inputs }, wall: (Date.now() - t0) / 1000 };
	fs.appendFileSync(out, JSON.stringify(rec) + '\n');
	const tot = s1.states + (s2 ? s2.states : 0);
	console.log(`${level} salt ${s} refine ${afx}x${afv}: stage 1 ${s1.finish > 0 ? `route ${s1.finish}` : 'no route'} (${(s1.states / 1e6).toFixed(1)}M)` +
		(s2 ? ` | stage 2 ${s2.finish > 0 ? `route ${s2.finish}` : 'no route'} (${(s2.states / 1e6).toFixed(1)}M)` : '') + ` | total ${(tot / 1e6).toFixed(1)}M states, ${rec.wall.toFixed(0)} s`);
}

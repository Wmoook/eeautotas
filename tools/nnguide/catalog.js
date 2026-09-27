'use strict';
// Builds the neural-guidance data bundle: every known level (job levels, Find a route levels) grouped by level family,
// with every known finishing route (verified by replay) and non-finishing search attempts.
//   node tools/nnguide/catalog.js -> src/out/nnguide/bundle/ (NN_WORK): levels/<lv>.json (level JSON), routes/<lv>/<name>.eetas,
//   catalog.json. Levels and runs are third-party data: the bundle goes to the rented training machine, never into git.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAIN = process.env.NN_MAIN || process.env.EEAT_HOME || path.join(__dirname, '..', '..', 'src');   // (jobs/, data/, out/)
const C = require('../../src/common.js');
const E = C.E;
const EL = require('../../src/eelvl.js');
const WORK = process.env.NN_WORK || path.join(__dirname, '..', '..', 'src', 'out', 'nnguide');   // (the data stays out of git)
const OUT = path.join(WORK, 'bundle');
const OUTSRC = path.join(MAIN, 'out');

const groupOfJob = (id) => {
	const rules = [[/^infinity-pain/, 'ip'], [/^octorage/, 'octo'], [/forgotten-veil/, 'fv'], [/^ice-level/, 'ice'], [/^good-egg/, 'egg'], [/^stupid-fox/, 'sfox'],
		[/^213|^celeste/, 'c213'], [/^arrowcourse/, 'arrow'], [/^my-level/, 'mylevel']];
	for (const [re, g] of rules) if (re.test(id)) return g;
	return id;
};
const levels = [];   // {lv, group, json (level JSON object), routes: [file], attempts: [file]}
function addLevel(lv, group, json, routes, attempts) { levels.push({ lv, group, json, routes, attempts: attempts || [] }); }
// jobs
for (const id of fs.readdirSync(path.join(MAIN, 'jobs'))) {
	const dir = path.join(MAIN, 'jobs', id);
	if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
	const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
	const lf = path.join(MAIN, 'data', (meta.levelId || 'job_' + id.replace(/-/g, '_')) + '.json');
	if (!fs.existsSync(lf)) continue;
	const routes = [];
	const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (f.endsWith('.eetas')) routes.push(p); else if ((f === 'pieces' || f === 'gpu' || f === 'probes') && fs.statSync(p).isDirectory()) walk(p); } };
	walk(dir);
	addLevel('job_' + id, groupOfJob(id), JSON.parse(fs.readFileSync(lf, 'utf8')), routes);
}
// eelvl levels with Find a route routes / attempts
const eel = (file, name) => { const L = EL.toSimLevel(EL.readEelvl(fs.readFileSync(path.join(OUTSRC, file))), { id: name, file: path.basename(file) }); return L; };
const O = (f) => path.join(OUTSRC, f);
const ls = (d, re) => { try { return fs.readdirSync(O(d)).filter((f) => re.test(f)).map((f) => O(path.join(d, f))); } catch (e) { return []; } };
addLevel('ice200', 'ice', eel('rf/ice200.eelvl', 'ice200'), [O('planner_b/ice200_route_ngx_10153.eetas'), ...ls('judge/runs', /^ice200_.*_route\.eetas$/), ...ls('planner_b/runs', /(ice).*_route\.eetas$/)],
	[...ls('rf', /^ice_cl\d+\.eetas$/), O('rf/ice200_closest.eetas'), O('rf/ice_pre.eetas')]);
addLevel('dotring', 'dotring', eel('rf/dotring.eelvl', 'dotring'), [O('planner_b/dotring_route974.eetas'), ...ls('planner_b/runs', /^(c_dot|dot_).*_route\.eetas$/)],
	[O('rf/dotring_closest.eetas'), O('rf/dot_cl9.eetas')]);
addLevel('arrowcourse', 'arrow', eel('arrowlevel/final/ArrowCourse.eelvl', 'arrowcourse'), [O('arrowlevel/final/ArrowCourse.eetas')]);
for (const b of ['213', 'coindoor', 'jth', 'portal', 'shaft', 'staircase', 'user30s', 'user_0253']) {
	const g = b === '213' ? 'c213' : 'b_' + b;
	addLevel('bench_' + b, g, eel(`bench/${b}.eelvl`, b), ls('planner_b/runs', new RegExp(`^s_${b}_[a-z]+_route\\.eetas$`)),
		b === 'user_0253' ? [O('bench/user_0253_closest.eetas')] : []);
}
for (const f of fs.readdirSync(O('pf_lv')).filter((x) => x.endsWith('.eelvl'))) {
	const b = f.slice(0, -6);
	addLevel('pf_' + b, 'p_' + b, eel(`pf_lv/${f}`, b), ls('planner_b/runs', new RegExp(`^s_${b}_[a-z]+_route\\.eetas$`)), b === 'user50' ? [O('pf_lv/user50_closest.eetas')] : []);
}
addLevel('dotstairs', 'p_dotstairs', eel('ed_level_dotstairs.eelvl', 'dotstairs'), [O('ed_level_dotstairs_route.eetas')]);

// the judge's routes (src/out/judge/routes/*.json) and the dot ring's: the evaluation routes (every tick)
const EVAL = { ip: 'jobs/infinity-pain-kiraninja-pwe7zf-v-b42e94/best_38657.eetas', octo: 'jobs/octorage-oc-08e189/best_5959.eetas',
	fv: 'jobs/forgotten-veil-d30867/best_11152.eetas', ice: 'jobs/ice-level-oc-850ef2/best_4639.eetas', dotring: 'out/planner_b/dotring_route974.eetas',
	egg: 'jobs/good-egg-galaxy-oc-0efb40/best_3864.eetas', sfox: 'jobs/stupid-fox-oc-a93a88/best_5784.eetas' };
const evalHash = {};
for (const [g, f] of Object.entries(EVAL)) evalHash[crypto.createHash('sha1').update(Buffer.from(C.readEetas(path.join(MAIN, f)))).digest('hex').slice(0, 10)] = g;
// verify, dedupe, write
fs.mkdirSync(path.join(OUT, 'levels'), { recursive: true });
const cat = [];
const evalUsed = new Set();
const fgKey = (L) => crypto.createHash('sha1').update(Buffer.from(L.fg.buffer)).update(`${L.width}x${L.height}`).digest('hex').slice(0, 12);
for (const lvd of levels) {
	let L;
	try { L = E.prepareLevel(lvd.json); } catch (e) { console.log(`${lvd.lv}: ${e.message}`); continue; }
	const seen = new Set();
	const rOut = [], aOut = [];
	const rdir = path.join(OUT, 'routes', lvd.lv);
	fs.mkdirSync(rdir, { recursive: true });
	for (const [list, kind] of [[lvd.routes, 'r'], [lvd.attempts, 'a']]) {
		for (const f of list) {
			if (!fs.existsSync(f)) continue;
			let ms;
			try { ms = C.readEetas(f); } catch (e) { continue; }
			const h = crypto.createHash('sha1').update(Buffer.from(ms)).digest('hex').slice(0, 10);
			if (seen.has(h) || ms.length < 10) continue;
			seen.add(h);
			const ev = C.evaluate(L, ms, false);
			if (kind === 'r' && !ev) continue;
			if (kind === 'a' && ev) continue;
			const name = `${kind}_${path.basename(f, '.eetas')}_${h}.eetas`;
			C.writeEetas(path.join(rdir, name), kind === 'r' ? ev.ms : ms);
			(kind === 'r' ? rOut : aOut).push({ name, eval: kind === 'r' && evalHash[h] === lvd.group && !evalUsed.has(h) ? (evalUsed.add(h), lvd.group) : null, src: path.relative(MAIN, f).replace(/\\/g, '/'), ticks: kind === 'r' ? ev.ms.length : ms.length, runTicks: ev ? ev.runTicks : null, deaths: ev ? ev.deaths : null });
		}
	}
	fs.writeFileSync(path.join(OUT, 'levels', lvd.lv + '.json'), JSON.stringify(lvd.json));
	cat.push({ lv: lvd.lv, group: lvd.group, size: `${L.width}x${L.height}`, fg: fgKey(L), routes: rOut, attempts: aOut });
	console.log(`${lvd.lv.padEnd(48)} ${lvd.group.padEnd(12)} ${L.width}x${L.height} fg ${fgKey(L)}: ${rOut.length} routes (${rOut.reduce((s, r) => s + r.ticks, 0)} ticks), ${aOut.length} attempts`);
}
fs.writeFileSync(path.join(OUT, 'catalog.json'), JSON.stringify(cat, null, 1));

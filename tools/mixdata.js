'use strict';
// tools/mixdata.js: the data behind goexplore.js --mixBandit (the yield mix): which search configuration routes which
// level, whether a configuration's EARLY yield picks a configuration that routes the level, and a data prior for the
// mix's classes. Reads the GPU filler's dataset and the portfolio's sweeps (git-ignored; read only):
//   node tools/mixdata.js [--root=<checkout with src/out>] [--files=<results.jsonl>,...] [--at=30,45,60] [--json=<out.json>]
// default files: src/out/fill/res/*/results.jsonl and src/out/pf/sweep/*/results.jsonl (their rows: level md5, config,
// seed, routed, searchStartedAt, progress [[t, "room+ ..." | "room ..." | "near X" | ...]]; results_light.jsonl, the
// filler's 1-worker runs, are not read). Prints:
//   (1) the set cover: per configuration its routed levels, the levels only it routes, a greedy cover;
//   (2) the yield check: on every level with 2+ configurations run and 1+ routed, the configuration with the most new
//       rooms ("room" / "room+" progress entries) in its first T s of search (ties: the fewest seconds to its last room
//       in the window, then the name) routes the level? against chance (the share of its configurations that route it);
//   (3) the prior: per mix class (MIX_BANDIT's order: 40:0.85, 120:0.95, 240:0.97, 255:0.985, blind) the routes of its
//       configurations over their runs, as the pseudo-counts a prior would start from (the configs mapped by their
//       GPU random runs: longruns / lrgpu 120:0.95, lr2 240:0.97, lr3 (480, the kernel's cap 255) 255:0.985, blind
//       the blind class, the others 40:0.85).
const fs = require('fs');
const path = require('path');
const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
// (the data is not in version control: a worktree has none; --root names the checkout whose src/out holds it)
const ROOT = path.resolve(opt.root || path.join(__dirname, '..'));
const AT = String(opt.at || '30,45,60').split(',').map(Number).filter((x) => x > 0);
function defaultFiles() {
	const out = [];
	for (const base of ['src/out/fill/res', 'src/out/pf/sweep']) {
		const d = path.join(ROOT, base);
		let names = [];
		try { names = fs.readdirSync(d); } catch (e) { continue; }
		for (const n of names) { const f = path.join(d, n, 'results.jsonl'); if (fs.existsSync(f)) out.push(f); }
	}
	return out;
}
const FILES = opt.files ? opt.files.split(',') : defaultFiles();
const CLASS_OF = (cfg) => (/^(longruns|lrgpu)$/.test(cfg) ? 1 : cfg === 'lr2' ? 2 : cfg === 'lr3' ? 3 : cfg === 'blind' ? 4 : 0);
const CLASSES = ['40:0.85', '120:0.95', '240:0.97', '255:0.985', '120:0.95:b'];
/** the rows: {lv, name, cfg, seed, routed, rooms(T)} */
function load() {
	const rows = [];
	for (const f of FILES) {
		let lines = [];
		try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { continue; }
		for (const l of lines) {
			if (!l.trim()) continue;
			let r;
			try { r = JSON.parse(l); } catch (e) { continue; }
			if (!r.config || r.preempted || r.light || r.error) continue;
			const lv = r.md5 || r.file || r.level;
			const s0 = +r.searchStartedAt || 0;
			const rooms = (r.progress || []).filter((p) => /^room/.test(p[1])).map((p) => +p[0] - s0);
			rows.push({ lv, name: r.file || r.level, cfg: r.config, seed: r.seed != null ? +r.seed : 1, routed: !!r.routed, rooms, file: path.relative(ROOT, f) });
		}
	}
	return rows;
}
const rows = load();
const byLv = new Map();
for (const r of rows) { if (!byLv.has(r.lv)) byLv.set(r.lv, []); byLv.get(r.lv).push(r); }
const cfgs = [...new Set(rows.map((r) => r.cfg))].sort();
console.log(`# tools/mixdata.js: ${rows.length} runs, ${byLv.size} levels, ${cfgs.length} configurations (${cfgs.join(', ')})`);
console.log(`# files: ${FILES.map((f) => path.relative(ROOT, f)).join(', ')}`);
// (1) the set cover (a config routes a level when any of its runs there routed)
const routes = new Map(cfgs.map((c) => [c, new Set()]));
const runs = new Map(cfgs.map((c) => [c, 0]));
const hits = new Map(cfgs.map((c) => [c, 0]));
for (const r of rows) { runs.set(r.cfg, runs.get(r.cfg) + 1); if (r.routed) { routes.get(r.cfg).add(r.lv); hits.set(r.cfg, hits.get(r.cfg) + 1); } }
const nameOf = (lv) => { const r = byLv.get(lv)[0]; return String(r.name).replace(/\.eelvl$/, ''); };
console.log('\n## (1) the set cover');
console.log('config | runs | routed runs | levels routed | only this config');
for (const c of cfgs) {
	const only = [...routes.get(c)].filter((lv) => cfgs.every((d) => d === c || !routes.get(d).has(lv)));
	console.log(`${c} | ${runs.get(c)} | ${hits.get(c)} | ${routes.get(c).size} | ${only.length ? only.map(nameOf).join(', ') : '-'}`);
}
const left = new Set([].concat(...cfgs.map((c) => [...routes.get(c)])));
const cover = [];
while (left.size) {
	let best = null, bn = 0;
	for (const c of cfgs) { let n = 0; for (const lv of routes.get(c)) if (left.has(lv)) n++; if (n > bn) { bn = n; best = c; } }
	if (!best) break;
	cover.push(`${best} +${bn}`);
	for (const lv of routes.get(best)) left.delete(lv);
}
console.log(`greedy cover of the ${new Set([].concat(...cfgs.map((c) => [...routes.get(c)]))).size} routed levels: ${cover.join(', ')}`);
// (2) the yield check
console.log('\n## (2) the early yield picks a config that routes the level?');
const yieldOut = [];
for (const T of AT) {
	let n = 0, hit = 0, chance = 0, nAll = 0, hitAll = 0, chanceAll = 0;
	const misses = [];
	for (const [lv, rs] of byLv) {
		const per = new Map();
		for (const r of rs) {
			const q = per.get(r.cfg) || { cfg: r.cfg, rooms: 0, runs: 0, routed: false, lastAt: 0 };
			const inT = r.rooms.filter((t) => t <= T);
			q.rooms += inT.length; q.runs++; q.routed = q.routed || r.routed; q.lastAt = Math.max(q.lastAt, inT.length ? inT[inT.length - 1] : 0);
			per.set(r.cfg, q);
		}
		const qs = [...per.values()].map((q) => Object.assign(q, { y: q.rooms / q.runs }));
		if (qs.length < 2 || !qs.some((q) => q.routed)) continue;
		qs.sort((a, b) => b.y - a.y || a.lastAt - b.lastAt || (a.cfg < b.cfg ? -1 : 1));
		const share = qs.filter((q) => q.routed).length / qs.length;
		nAll++; chanceAll += share; if (qs[0].routed) hitAll++;
		if (share < 1) { n++; chance += share; if (qs[0].routed) hit++; else misses.push(`${nameOf(lv)} (picked ${qs[0].cfg}, routed by ${qs.filter((q) => q.routed).map((q) => q.cfg).join('/')})`); }
	}
	console.log(`T ${T} s: on ${nAll} multi-config levels with a route the pick routes ${hitAll} (chance ${chanceAll.toFixed(1)}); on the ${n} where not every config routes: ${hit} (chance ${chance.toFixed(1)})`);
	if (T === AT[0] && misses.length) console.log(`  misses at ${T} s: ${misses.slice(0, 12).join('; ')}${misses.length > 12 ? ` (+${misses.length - 12})` : ''}`);
	yieldOut.push({ T, levels: nAll, hits: hitAll, chance: Math.round(chanceAll * 10) / 10, levelsMixed: n, hitsMixed: hit, chanceMixed: Math.round(chance * 10) / 10 });
}
// (3) the prior per class
console.log('\n## (3) the data prior per mix class (routed runs / runs of its configurations; the levels only its configurations route)');
const cls = CLASSES.map((c, j) => ({ cls: c, runs: 0, routed: 0, levels: new Set(), cfgs: cfgs.filter((d) => CLASS_OF(d) === j) }));
for (const r of rows) { const q = cls[CLASS_OF(r.cfg)]; q.runs++; if (r.routed) { q.routed++; q.levels.add(r.lv); } }
const uniq = cls.map((q, j) => [...q.levels].filter((lv) => cls.every((o, k) => k === j || !o.levels.has(lv))).length);
const tot = cls.reduce((s, q) => s + q.routed, 0) || 1;
for (let j = 0; j < cls.length; j++) {
	const q = cls[j];
	console.log(`${q.cls} (${q.cfgs.join(', ') || 'no data'}): ${q.routed} / ${q.runs} runs routed (${q.runs ? (100 * q.routed / q.runs).toFixed(1) : '-'}%), ${q.levels.size} levels, ${uniq[j]} only by it; pseudo-count ${(q.runs ? q.routed / q.runs : 0).toFixed(3)} a run`);
}
console.log(`(a mild prior: each class's rate of routed runs, e.g. as its initial reward per second over MB_TAU; the classes without data at the mean. The bandit starts each class once and follows the measured yield from there.)`);
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ files: FILES.map((f) => path.relative(ROOT, f)), runs: rows.length, levels: byLv.size,
	cover: cfgs.map((c) => ({ cfg: c, runs: runs.get(c), routedRuns: hits.get(c), levels: routes.get(c).size })), greedy: cover, yield: yieldOut,
	prior: cls.map((q, j) => ({ cls: q.cls, cfgs: q.cfgs, runs: q.runs, routed: q.routed, levels: q.levels.size, only: uniq[j] })) }, null, 1));

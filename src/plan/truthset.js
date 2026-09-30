'use strict';
// THE GROUND TRUTH for every part's offline checks (n4plan, the compiler; the architect, 2026-09-29). READ ONLY: it
// lists and replays routes that exist (the user's jobs src/jobs/<id>/best.eetas, the AutoTAS benchmark runs
// src/out/god/**/runs/<level>/best.eetas) on their levels, and turns a route into the facts the parts are checked
// against: the order in which it changed the features (coins, keys, switches, team, ...), the tick of each change and
// the tile it happened on. It never writes into src/jobs or src/out, and no level file goes into git.
//
//   levelFiles({sets, root}) -> [{name, file, set}]           the benchmark levels (sets: 'campaign', 'hard', 'd4')
//   knownRoutes({root, jobs, god}) -> [{name, source, levelFile, jobId, route}]   every candidate route file
//   loadTruth(entry) -> {L, masks, complete, runTicks, deaths} | null   the level + the route, replayed (null: it does not
//        finish the level: a stale file); a job's level comes from its job id (common.js loadLevel: its start mode)
//   routeEvents(L, masks, o) -> {complete, runTicks, deaths, events: [{tick, feat, from, to, tile}]}
//        tick: the first tick (1-based, the state after `tick` inputs) where featValue(sim, feat) differs from the tick
//        before; tile: the ball's centre tile then (types.js tileOf). feats: key0..key5, psw:<id>, osw:<id> (every id
//        whose switch changed), team, coins, bcoins, crown, silver, deaths, cp, fx, prot. o.until: stop after this tick.
//   orderOf(events, o) -> the trigger order as waypoint-like steps [{tick, feat, value, tile}] without the 'deaths' /
//        'cp' / 'fx' steps unless o.all (the planner's plan for this route, as the route did it)
//
// root: o.root, else EEAT_TRUTH_ROOT, else this repo (a worktree has no src/jobs / src/out: set EEAT_TRUTH_ROOT to the
// main checkout, e.g. C:\Users\super\eeautotas, or to the copy on a box).
const fs = require('fs');
const path = require('path');
const E = require('../eesim.js');
const T = require('./types.js');

const rootOf = (o) => path.resolve((o && o.root) || process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..', '..'));
const SETS = { campaign: ['src', 'out', 'god', 'levels', 'campaign'], hard: ['src', 'out', 'god', 'levels', 'hard'], d4: ['src', 'out', 'd4', 'levels'] };

/** the benchmark levels: [{name (the file name without .eelvl), file, set}] */
function levelFiles(o = {}) {
	const root = rootOf(o), out = [];
	for (const set of o.sets || ['campaign', 'hard', 'd4']) {
		const dir = path.join(root, ...SETS[set]);
		let names = [];
		try { names = fs.readdirSync(dir).filter((f) => /\.eelvl$/i.test(f)).sort(); } catch (e) { continue; }
		for (const f of names) out.push({ name: f.replace(/\.eelvl$/i, ''), file: path.join(dir, f), set });
	}
	return out;
}

/** every run directory named like a level under dir (recursive, depth-limited) with a best.eetas */
function runDirs(dir, depth, out) {
	let ents = [];
	try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
	for (const d of ents) {
		if (!d.isDirectory()) continue;
		const p = path.join(dir, d.name);
		if (path.basename(dir) === 'runs') { if (fs.existsSync(path.join(p, 'best.eetas'))) out.push({ name: d.name, route: path.join(p, 'best.eetas') }); continue; }
		if (depth > 0) runDirs(p, depth - 1, out);
	}
	return out;
}

/**
 * knownRoutes(o) -> [{name, source: 'job' | 'god', levelFile, jobId (jobs), route}]: the user's jobs (src/jobs/<id>/
 * best.eetas + original.eelvl) and the benchmark runs whose directory name is a benchmark level's name (several runs of
 * one level: every one, the smallest file first). o.jobs / o.god false: leave that source out.
 */
function knownRoutes(o = {}) {
	const root = rootOf(o), out = [];
	if (o.jobs !== false) {
		const jd = path.join(root, 'src', 'jobs');
		let ids = [];
		try { ids = fs.readdirSync(jd).sort(); } catch (e) { /* none */ }
		for (const id of ids) {
			const route = path.join(jd, id, 'best.eetas'), lf = path.join(jd, id, 'original.eelvl');
			if (!fs.existsSync(route) || !fs.existsSync(lf)) continue;
			let name = id;
			try { name = JSON.parse(fs.readFileSync(path.join(jd, id, 'meta.json'), 'utf8')).level.name || id; } catch (e) { /* the id */ }
			out.push({ name, source: 'job', levelFile: lf, jobId: id, route });
		}
	}
	if (o.god !== false) {
		const byName = new Map(levelFiles({ root, sets: ['campaign', 'hard'] }).map((l) => [l.name, l.file]));
		const runs = runDirs(path.join(root, 'src', 'out', 'god'), 6, []).filter((r) => byName.has(r.name));
		runs.sort((a, b) => a.name.localeCompare(b.name) || fs.statSync(a.route).size - fs.statSync(b.route).size || a.route.localeCompare(b.route));
		for (const r of runs) out.push({ name: r.name, source: 'god', levelFile: byName.get(r.name), jobId: null, route: r.route });
	}
	return out;
}

/** the level + the route of a knownRoutes entry, replayed from the start: null when it does not finish the level */
function loadTruth(entry) {
	const C = require('../common.js');
	let L = null;
	if (entry.jobId) {
		// (the job's level JSON: src/data/<meta.levelId>.json of the root the entry came from, its start mode baked in)
		const jd = path.dirname(entry.route);
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(jd, 'meta.json'), 'utf8'));
			const lj = path.join(jd, '..', '..', 'data', `${meta.levelId}.json`);
			if (meta.levelId && fs.existsSync(lj)) L = E.loadLevel(lj);
		} catch (e) { L = null; }
	}
	if (!L) L = T.loadLevelFile(entry.levelFile);
	const masks = C.readEetas(entry.route);
	const ev = C.evaluate(L, masks, false);
	if (!ev) return null;
	return { L, masks: masks.subarray(0, ev.complete), complete: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths };
}

const BASE_FEATS = ['key0', 'key1', 'key2', 'key3', 'key4', 'key5', 'team', 'coins', 'bcoins', 'crown', 'silver', 'deaths', 'cp', 'fx', 'prot'];
/** the switch ids on (sorted) of a sim's switch map */
const onIds = (m) => { const a = []; for (const [k, v] of m) if (v === true) a.push(k); return a.sort((x, y) => x - y); };

/** routeEvents(L, masks, o) -> {complete, runTicks, deaths, events}: every feature change of the route, in order */
function routeEvents(L, masks, o = {}) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const W = L.width, H = L.height;
	const until = Math.min(masks.length, +o.until > 0 ? +o.until : masks.length);
	const prev = new Map(BASE_FEATS.map((f) => [f, T.featValue(sim, f)]));
	let pOn = new Set(onIds(sim._switches)), oOn = new Set(onIds(sim._oswitches));
	const events = [];
	let complete = -1;
	for (let t = 0; t < until; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		const tile = T.tileOf(sim, W, H);
		for (const f of BASE_FEATS) {
			const v = T.featValue(sim, f);
			if (v !== prev.get(f)) { events.push({ tick: t + 1, feat: f, from: prev.get(f), to: v, tile }); prev.set(f, v); }
		}
		const p2 = new Set(onIds(sim._switches)), o2 = new Set(onIds(sim._oswitches));
		for (const id of new Set([...pOn, ...p2])) if (pOn.has(id) !== p2.has(id)) events.push({ tick: t + 1, feat: `psw:${id}`, from: pOn.has(id) ? 1 : 0, to: p2.has(id) ? 1 : 0, tile });
		for (const id of new Set([...oOn, ...o2])) if (oOn.has(id) !== o2.has(id)) events.push({ tick: t + 1, feat: `osw:${id}`, from: oOn.has(id) ? 1 : 0, to: o2.has(id) ? 1 : 0, tile });
		pOn = p2; oOn = o2;
		if (complete < 0 && sim.has_silver_crown) { complete = t + 1; if (!o.past) break; }
	}
	const C = require('../common.js');
	const ev = complete > 0 ? C.evaluate(L, masks.subarray(0, complete), false) : null;
	return { complete, runTicks: ev ? ev.runTicks : -1, deaths: sim.deaths, events };
}

/** the route's trigger order: [{tick, feat, value, tile}] (o.all: with deaths / cp / fx changes too) */
function orderOf(events, o = {}) {
	const skip = o.all ? new Set() : new Set(['deaths', 'cp', 'fx']);
	return events.filter((e) => !skip.has(e.feat)).map((e) => ({ tick: e.tick, feat: e.feat, value: e.to, tile: e.tile }));
}

module.exports = { levelFiles, knownRoutes, loadTruth, routeEvents, orderOf, BASE_FEATS };

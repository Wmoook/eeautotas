'use strict';
// src/rrank.js: ROUTE-RANK, a room progress rank learned from the GPU filler's routes (INNOLOOP box 4 round 2, lane 2,
// 2026-09-29; OPT-IN: editor.js EEAT_RRANK=1 / body rrank: 1, default off). A room = goexplore.js roomOf's description
// ("lowgrav coins=3 purple=[1,3,101] key:blue"); its FEATURES are normalized per level and count only what the level's
// own doors read ('useful' only: a coin past the level's highest coin door, a key no door reads, a switch no door or gate
// reads (roomOf leaves those out of the description already) add nothing); the model is a pairwise logistic one over
// them (tools/rrank.js --train, from the filler's routes: a later route room over an earlier one, a route room over a room
// the stalled runs found off every route and over the rooms of their nearest attempts), its score s(room) = w . f(room),
// its RANK CLASS floor(s / step). The editor's nearest attempt (S.closest: the page's ring, the relay, the wall breaker's
// and the stall escape's near starts, the precision stage) compares by the class first and the distance second. Order and
// measure only: nothing is pruned by it.
const fs = require('fs');
const path = require('path');
const GX = require('./goexplore.js');
const LM = require('./landmarks.js');

/** the features, in the model's order (tools/rrank.js writes the weights in this order; a model with other names is
 *  refused) */
const FEATS = ['gold', 'blue', 'goldAll', 'blueAll', 'keys', 'swCnt', 'swFrac', 'effGood', 'effKill', 'team', 'crown', 'lm', 'gain'];
const GOOD_FX = ['protection', 'fly', 'lowgrav'];
const GOOD_FX_V = /^(jumps|jump|speed|grav)=/;
const KILL_FX = ['curse', 'zombie', 'fire', 'poison'];
const KEY_BIT = { red: 0, green: 1, blue: 2, cyan: 3, magenta: 4, yellow: 5 };

/** the level's readers: {gMax, bMax (the highest coin / blue coin DOOR: goexplore.js paretoOf), keys (the key colours a key
 *  door or gate reads: bits), keyN, swN (the switch ids some door or gate reads, purple + orange), teams (the team values
 *  a team door reads), crown (a crown door stands), lm (the landmarks: landmarks.js), lmN} */
function levelInfo(L, opts = {}) {
	const P = GX.paretoOf(L) || { gMax: 0, bMax: 0, keys: 0 };
	const SR = GX.switchReaders(L);
	const N = L.width * L.height, teams = new Set();
	let crown = false, gN = 0, bN = 0;
	for (let i = 0; i < N; i++) {
		const id = L.fg[i];
		if (id === 100 || id === 110) gN++;
		else if (id === 101 || id === 111) bN++;
		else if (id === 1027 || id === 1028) teams.add(L.lookup0[i] | 0);
		else if (id === 1094 || id === 1095 || id === 1152 || id === 1153) crown = true;
	}
	let keyN = 0;
	for (let m = P.keys; m; m &= m - 1) keyN++;
	let lm = [];
	if (opts.landmarks !== false) { try { lm = LM.landmarksOf(L, { maxMs: opts.lmMs || 3000 }).landmarks; } catch (e) { lm = []; } }
	return { gMax: P.gMax, bMax: P.bMax, gN, bN, keys: P.keys, keyN, swN: SR.purple.size + SR.orange.size, teams, crown, lm, lmN: lm.length };
}

/** a description without the clock's part (the time doors: the phase, not progress) */
const normDesc = (d) => String(d || '').split(' ').filter((w) => w && !/^timedoors:/.test(w) && w !== '(start)').join(' ');

/** the features of a room description d (with its territory gain, tiles; 0 unknown) on a level of info I: numbers in
 *  [0, 1], FEATS' order */
function featuresOf(I, d, gain = 0) {
	d = String(d || '');
	const w = d.split(' ');
	const num = (re) => { const m = re.exec(d); return m ? +m[1] : 0; };
	const coins = num(/(?:^|\s)coins(?:>=|=)(\d+)/), blue = num(/(?:^|\s)bluecoins(?:>=|=)(\d+)/);
	let keys = 0;
	for (const x of w) { const m = /^key:(\w+)$/.exec(x); if (m && KEY_BIT[m[1]] !== undefined && (I.keys & (1 << KEY_BIT[m[1]])) !== 0) keys++; }
	let sw = 0;
	for (const m of d.matchAll(/(?:purple|orange)=\[([^\]]*)\]/g)) sw += m[1].split(',').filter(Boolean).length;
	let good = 0, kill = 0;
	for (const x of w) { if (GOOD_FX.includes(x) || GOOD_FX_V.test(x)) good++; else if (KILL_FX.includes(x)) kill = 1; }
	const team = num(/(?:^|\s)team=(\d+)/);
	return [
		I.gMax > 0 ? Math.min(coins, I.gMax) / I.gMax : 0,
		I.bMax > 0 ? Math.min(blue, I.bMax) / I.bMax : 0,
		I.gN > 0 ? Math.min(1, coins / I.gN) : 0,
		I.bN > 0 ? Math.min(1, blue / I.bN) : 0,
		I.keyN > 0 ? keys / I.keyN : 0,
		Math.log1p(sw) / Math.log(11) > 1 ? 1 : Math.log1p(sw) / Math.log(11),
		I.swN > 0 ? Math.min(1, sw / I.swN) : 0,
		Math.min(3, good) / 3,
		kill,
		team !== 0 && I.teams.has(team) ? 1 : 0,
		I.crown && /(?:^|\s)(crown|silvercrown)(?:\s|$)/.test(d) ? 1 : 0,
		I.lmN > 0 ? LM.progressOf(I.lm, d) / I.lmN : 0,
		Math.min(1, Math.log1p(Math.max(0, +gain || 0)) / Math.log1p(2000)),
	];
}

/** the model file (src/rrank.json, tools/rrank.js --train): {feats, w, step, ...}; null when missing or of other features */
let MODEL = undefined;
function loadModel(file) {
	if (!file && MODEL !== undefined) return MODEL;
	const f = file || process.env.EEAT_RRANK_MODEL || path.join(__dirname, 'rrank.json');
	let m = null;
	try {
		const j = JSON.parse(fs.readFileSync(f, 'utf8'));
		if (Array.isArray(j.feats) && j.feats.join(',') === FEATS.join(',') && Array.isArray(j.w) && j.w.length === FEATS.length && j.w.every(Number.isFinite) && j.step > 0) m = j;
	} catch (e) { m = null; }
	if (!file) MODEL = m;
	return m;
}
/** the score of features x by model M */
const scoreOf = (M, x) => { let s = 0; for (let k = 0; k < x.length; k++) s += M.w[k] * x[k]; return s; };
/** the rank class of a score */
const classOf = (M, s) => Math.floor(s / M.step + 1e-9);

/** a ranker for one level: {score(desc, gain), cls(desc, gain), info} (cached per description); null without a model */
function ranker(L, opts = {}) {
	const M = opts.model || loadModel();
	if (!M) return null;
	const I = opts.info || levelInfo(L, opts);
	const cache = new Map();
	const score = (desc, gain = 0) => {
		const d = normDesc(desc), k = `${d}|${Math.round(+gain || 0)}`;
		let s = cache.get(k);
		if (s === undefined) { s = scoreOf(M, featuresOf(I, d, gain)); cache.set(k, s); }
		return s;
	};
	return { M, info: I, score, cls: (desc, gain = 0) => classOf(M, score(desc, gain)) };
}

module.exports = { FEATS, levelInfo, normDesc, featuresOf, loadModel, scoreOf, classOf, ranker };

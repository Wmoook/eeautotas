'use strict';
// THE ROOM VALUE (goexplore.js --gpu=1 --gpuVal=1, OPT-IN, default off): a count-aware progress value for the GPU random
// runs' head A. Head A orders its cells by the reach cost with every door open (RCH3) + lambda x sqrt(picks); it has no
// coin, blue-coin or key term, so on a coin-door level it keeps picking the room whose cells sit nearest by RCH3, often
// the POORER room (a false near at a shut door). The filler's data (2026-09-29): on 17+ failing levels the nearest attempt
// holds fewer coins than the run's best; along the routes of failing levels RCH3 sits > 20 tiles above its running
// minimum 51% of the time. This value is RCH3 + a ROOM OFFSET (tiles, <= 0) from the room's counts, learned from routes
// (tools/roomval_train.js): pairwise, "later on a route scores lower" + "a route state with more of the counts scores
// below a failed run's nearest attempt".
//
// The features of a room (the counts the GPU's room key holds: layer-aware, one value per room):
//   fracC  useful coins / the highest coin door or gate threshold (useful = min(coins, that threshold); 0 without doors)
//   metC   the share of the coin thresholds met
//   lgC    log1p(useful coins)
//   fracB, metB, lgB  the same for blue coins
//   keys   the key colours held that have doors of that colour (23, 24, 25, 1005, 1006, 1007)
// Coins above the highest threshold add nothing (the value never rewards hoarding); a level with no coin or key doors
// gets offset 0 (head A exactly as without the flag, but for the offsets' ties: none).
// The weights file (JSON, numbers only): {version, feats: [names], w: [w_rc, w_fracC, ...], ...}: the value in the
// trainer's units is w_rc x RCH3 / 100 + sum w_k f_k; in tiles: RCH3 + offset, offset = 100 x sum_k w_k f_k / w_rc,
// softly capped at OFF_CAP (tanh: monotone). RETRAIN as the filler grows: see tools/roomval_train.js.
const fs = require('fs');
const path = require('path');

const FEATS = ['rc100', 'fracC', 'metC', 'lgC', 'fracB', 'metB', 'lgB', 'keys'];
const VERSION = 1;
const DEFAULT_W = path.join(__dirname, 'roomval_w.json');
// the key door ids -> the key colour's bit (sim._keysMask): doors open WITH the key (the gates 26-28 / 1008-1010 shut)
const KEY_DOOR_BIT = new Map([[23, 1], [24, 2], [25, 4], [1005, 8], [1006, 16], [1007, 32]]);
// the offset's soft cap (tiles): off = OFF_CAP x tanh(raw / OFF_CAP), monotone (more useful counts always score lower)
// and above -OFF_CAP: the learned weights put a full coin plan 3,000+ tiles ahead (near-lexicographic by the counts);
// near the cap a room is outranked only by cells of a poorer room that are nearer by what is left of the difference
const OFF_CAP = 2000;

/** the level's counters: the coin and blue thresholds (> 0, sorted), their highest, the key colours with doors (mask) */
function levelInfo(L) {
	const cTh = Array.from(L.coinDoorThresholds || []).filter((x) => x > 0).sort((a, b) => a - b);
	const bTh = Array.from(L.blueCoinDoorThresholds || []).filter((x) => x > 0).sort((a, b) => a - b);
	let kd = 0;
	for (let i = 0; i < L.width * L.height; i++) { const b = KEY_DOOR_BIT.get(L.fg[i]); if (b !== undefined) kd |= b; }
	return { cTh, bTh, cMax: cTh.length ? cTh[cTh.length - 1] : 0, bMax: bTh.length ? bTh[bTh.length - 1] : 0, kd, any: cTh.length > 0 || bTh.length > 0 || kd !== 0 };
}

const popc = (x) => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
const metShare = (th, v) => { if (!th.length) return 0; let n = 0; while (n < th.length && th[n] <= v) n++; return n / th.length; };

/** a state's room features (FEATS without rc100): from its coins, blue coins and keys */
function featsOf(I, coins, blue, keysMask) {
	const uc = I.cMax ? Math.min(coins, I.cMax) : 0, ub = I.bMax ? Math.min(blue, I.bMax) : 0;
	return [I.cMax ? uc / I.cMax : 0, metShare(I.cTh, uc), Math.log1p(uc), I.bMax ? ub / I.bMax : 0, metShare(I.bTh, ub), Math.log1p(ub), popc(keysMask & I.kd)];
}
const featsOfSim = (I, sim) => featsOf(I, sim.coins, sim.blue_coins, sim._keysMask | 0);

/** the weights: {w: [w_rc, ...]} checked (w_rc > 0, the count weights <= 0: more of a useful count never scores worse) */
function readWeights(file) {
	const W = JSON.parse(fs.readFileSync(file || DEFAULT_W, 'utf8'));
	if (!W || !Array.isArray(W.w) || W.w.length !== FEATS.length || !W.w.every(Number.isFinite)) throw new Error(`room value weights ${file || DEFAULT_W}: want w = ${FEATS.length} numbers (${FEATS.join(', ')})`);
	if (!(W.w[0] > 0)) throw new Error('room value weights: w_rc must be > 0');
	for (let k = 1; k < W.w.length; k++) if (W.w[k] > 0) throw new Error(`room value weights: ${FEATS[k]} must be <= 0 (more of a useful count never scores worse)`);
	return W;
}

/** a room's offset in tiles (<= 0) from its features */
function offsetOf(W, f) {
	let z = 0;
	for (let k = 0; k < f.length; k++) z += W.w[k + 1] * f[k];
	if (z === 0) return 0;
	const raw = 100 * z / W.w[0];
	return OFF_CAP * Math.tanh(raw / OFF_CAP);
}

module.exports = { FEATS, VERSION, DEFAULT_W, KEY_DOOR_BIT, OFF_CAP, levelInfo, featsOf, featsOfSim, readWeights, offsetOf };

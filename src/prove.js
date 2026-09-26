'use strict';
// The proof of Find a route: `eegpu prove` (native/prove.h, CPU only, one thread) seen from JS. A sound abstract
// interpretation of the engine's tick for levels of plain solids, air-like blocks and the trophy: when its fixpoint
// holds no state with the ball's centre in a trophy tile, no input sequence finishes the level. It proves levels the
// reach field (src/reach.js, a tile-level model) cannot, where the run-up speed decides (a gap a few tiles too wide for
// the run-up the level leaves). The editor (src/editor.js) runs it next to the searches once the reach field finds a
// way (a finite start cost), and says "No route (proven)" with its explanation.
// - run(cmd, levelBin, {reach, seconds, maxCells}, done): the process; done(result) with its done line ({verdict:
//   impossible | reached | limit | unsupported, sec, cells, pruned, reach, explain, why}) or {verdict: 'error', error}
//   (also when it has not answered WATCHDOG_S after its budget: killed);
// - the cache: <data>/editor/prove_<level hash>_<fingerprint>.json (the fingerprint of the prover's source, the engine
//   files it mirrors, the reach field's model (its cut-offs drop states: an "impossible" can rest on them), the level
//   blob's writer and the tool: a changed model never reads an old verdict), the newest 8 kept; a time limit is not
//   kept (a busy machine's 30 s say nothing of the next search), a memory limit is (for its cell cap or a smaller one);
// - message(result): the "No route (proven): ..." text from its explanation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const C = require('./common.js');

const VERSION = 2;
const SECONDS = 30;          // the editor's budget (one thread)
const MAX_CELLS = 6000000;   // ~100 bytes per cell plus the hash table: about 0.8 GB at most
const RUNUP_TOP = 6.78;      // the fastest a run-up gets (px/tick), for the explanation
const WATCHDOG_S = 20;       // a proof silent this long after its budget is killed (it checks its clock every 1024 boxes)

let SRC_FP = '';
/** the fingerprint of the model: native/prove.h (the packaged app has no sources: the tool alone then), the engine files
 *  it mirrors, reach.js (the cut-offs of --reach) and gpu.js (the level blob), and the tool (its path and build: a
 *  rebuilt tool may prove more) */
function fingerprint(cmd) {
	if (!SRC_FP) {
		const h = crypto.createHash('sha1');
		h.update(`v${VERSION}`);
		for (const f of [path.join(__dirname, '..', 'native', 'prove.h'), ...['eesim.js', 'eelvl.js', 'reach.js', 'gpu.js'].map((x) => path.join(__dirname, x))]) {
			try { h.update(fs.readFileSync(f)); } catch (e) { h.update(path.basename(f)); }
		}
		SRC_FP = h.digest('hex');
	}
	const h = crypto.createHash('sha1');
	h.update(SRC_FP);
	for (const a of cmd || []) {
		h.update(`\u0000${a}`);
		try { const s = fs.statSync(a); if (s.isFile()) h.update(`|${s.size}|${Math.round(s.mtimeMs)}`); } catch (e) { /* an argument */ }
	}
	return h.digest('hex').slice(0, 10);
}
const cacheFile = (dir, levelHash, cmd) => path.join(dir, `prove_${levelHash}_${fingerprint(cmd)}.json`);
/** a verdict worth keeping: not an error, not a time limit */
const keeps = (r) => !!r && !!r.verdict && r.verdict !== 'error' && !(r.verdict === 'limit' && r.end !== 'cells');
/** a cached verdict (null: none, another model, or a memory limit with a smaller cell cap than `maxCells`) */
function readCache(file, maxCells) {
	const r = C.readJSON(file, null);
	if (!r || r.v !== VERSION || !keeps(r)) return null;
	if (r.verdict === 'limit' && !(r.maxCells >= (maxCells || MAX_CELLS))) return null;
	return r;
}
function writeCache(dir, file, r, maxCells) {
	if (!keeps(r)) return;
	try {
		fs.mkdirSync(dir, { recursive: true });
		C.writeJSON(file, Object.assign({ v: VERSION, maxCells: maxCells || MAX_CELLS, t: new Date().toISOString() }, r));
		// the newest 8
		const fl = fs.readdirSync(dir).filter((f) => /^prove_[0-9a-f]+_[0-9a-f]+\.json$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		for (const { f } of fl.slice(8)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* gone */ } }
	} catch (e) { /* read-only data folder */ }
}

/** runs cmd (the native tool: [exe], or a stand-in [node, script]) `prove levelBin`; done(result) once it ends (a kill:
 *  {verdict: 'error', error: 'stopped'}; o.watchdogS (WATCHDOG_S) after its budget without an answer: killed, an error).
 *  Returns the child process. */
function run(cmd, levelBin, o, done) {
	const seconds = o.seconds || SECONDS;
	const args = [...cmd.slice(1), 'prove', levelBin, `--seconds=${seconds}`, `--maxCells=${o.maxCells || MAX_CELLS}`, ...(o.reach ? [`--reach=${o.reach}`] : [])];
	const ch = spawn(cmd[0], args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	let out = '', err = '', ended = false, hung = false;
	ch.stdout.on('data', (c) => { out = (out + c).slice(-20000); });
	ch.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
	const wd = o.watchdogS !== undefined ? o.watchdogS : WATCHDOG_S;
	const guard = setTimeout(() => { hung = true; try { ch.kill(); } catch (e) { /* gone */ } }, (seconds + wd) * 1000);
	if (guard.unref) guard.unref();
	const end = (r) => { clearTimeout(guard); if (!ended) { ended = true; done(r); } };
	ch.on('error', (e) => end({ verdict: 'error', error: e.message }));
	ch.on('close', (code) => {
		let r = null;
		for (const line of out.split('\n')) { try { const j = JSON.parse(line); if (j && j.ev === 'done') r = j; } catch (e) { /* not JSON */ } }
		if (r) return end(r);
		if (hung) return end({ verdict: 'error', error: `no answer ${wd} s after its ${seconds} s: stopped` });
		if (/unknown command prove/.test(err)) return end({ verdict: 'error', error: 'the search tool is older than the app (no proof): rebuild it (node tools/build-native.js)' });
		end({ verdict: 'error', error: code === null ? 'stopped' : `exit code ${code}${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : ''}` });
	});
	return ch;
}

const num = (x, d) => { const r = Math.round(x * 10 ** d) / 10 ** d; return Number.isInteger(r) ? String(r) : r.toFixed(d); };
/**
 * "No route (proven): ..." from a proof's explanation: the highest the ball's top gets, the reachable centre tile
 * nearest the trophy, the fastest speed toward it. With states the reach field cut off (pruned > 0) the facts are about
 * the ways the physics check leaves open (the rest cannot reach the trophy anyway).
 */
function message(r) {
	const ex = r && r.explain;
	let s = 'No route (proven): the trophy cannot be reached from the start. A proof that follows every input, tick by tick (the ball\'s position and speed ' +
		'kept to within a pixel, run-ups included), finds that ';
	if (!ex || !(ex.topY >= 0)) return `${s}no move gets the ball there.`;
	const facts = [];
	const row = Math.floor(ex.topY / 16), tRow = ex.trophy ? ex.trophy[1] : -1;
	facts.push(`the ball's top gets no higher than y = ${num(Math.floor(ex.topY * 10) / 10, 1)} (row ${row}${tRow >= 0 && tRow < row ? `; the trophy is in row ${tRow}` : ''})`);
	if (ex.nearest && ex.nearest[0] >= 0 && ex.nearestDist >= 0) {
		const d = num(ex.nearestDist, 1);
		facts.push(`the closest it gets is tile (${ex.nearest[0]}, ${ex.nearest[1]}), ${d} tile${d === '1' ? '' : 's'} from the trophy`);
	}
	// the speed toward the trophy from where the ball gets closest (else from the start; else both ways)
	let dx = ex.trophy && ex.nearest && ex.nearest[0] >= 0 ? ex.trophy[0] - ex.nearest[0] : 0;
	if (!dx && ex.trophy && ex.start) dx = ex.trophy[0] - ex.start[0];
	if (dx && Number.isFinite(dx > 0 ? ex.maxVxRight : ex.maxVxLeft)) {
		facts.push(`its fastest ${dx > 0 ? 'rightward' : 'leftward'} speed is ${(dx > 0 ? ex.maxVxRight : ex.maxVxLeft).toFixed(2)} px/tick (a long run-up reaches ${RUNUP_TOP})`);
	} else if (Number.isFinite(ex.maxVxRight) && Number.isFinite(ex.maxVxLeft)) {
		facts.push(`its fastest speeds are ${ex.maxVxRight.toFixed(2)} px/tick to the right and ${ex.maxVxLeft.toFixed(2)} to the left (a long run-up reaches ${RUNUP_TOP})`);
	}
	s += r.pruned > 0 ? 'on every way the physics check leaves open, ' : '';
	return `${s}${facts.join('; ')}.`;
}

module.exports = { run, message, fingerprint, cacheFile, readCache, writeCache, VERSION, SECONDS, MAX_CELLS, WATCHDOG_S };

'use strict';
// Guided search ("I think the ball can go along this line"): from a moment of a job's best run, the GPU beam search
// (native/beamhost.h, `eegpu beam`) expands every input from tens of thousands of states per tick and keeps the
// ones that make the most progress along the user's line (a guide, not a rail: distance from it only costs score).
// A state that is exactly equal to a LATER state of the best run is a proven shortcut: best[0..from) + the found
// inputs + best[j..] finishes the same way, sooner. Such runs go to the job (J.tryCandidate: the inbox of a running
// grind, which checks them again). State in <job>/guide.json (read by the page: GET /api/jobs/:id/guide).
//   J.guide... see guide(); CLI: node src/tas.js guide <job> <from> "<x,y x,y ...>" [seconds] [--tiles] [--width=K]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common.js');
const J = require('./jobs.js');
const G = require('./gpu.js');

const stateFile = (id) => path.join(J.jobDir(id), 'guide.json');
function guideState(id) {
	const s = C.readJSON(stateFile(id), null);
	if (!s) return { running: false };
	if (s.running && s.pid) { try { process.kill(s.pid, 0); } catch (e) { s.running = false; s.stage = 'stopped'; } }
	return s;
}

/**
 * Runs the guided search. points: [[x, y], ...] in pixels of the ball's centre (tiles: opts.tiles = true, then the
 * centre of each tile). from: a run time ("1:10.00") or a tick. Resolves with the final state.
 */
async function guide(id, fromSpec, points, seconds, opts) {
	const o = opts || {};
	const tool = G.nativeTool();
	if (!tool) throw new Error('the GPU engine is not built (node tools/build-native.js)');
	const dir = J.jobDir(id);
	const level = J.loadJobLevel(id);
	const why = G.unsupported(level);
	if (why) throw new Error(`the GPU engine cannot run this level: ${why}`);
	const best = C.evaluate(level, C.readEetas(path.join(dir, 'best.eetas')), false);
	if (!best) throw new Error('the best run does not finish');
	const tr = C.replay(level, best.ms, { trace: true });
	const from = C.tickOf(tr, C.parseTime(String(fromSpec)));
	if (from >= best.complete) throw new Error('the start is at or after the finish');
	const pts = points.map(([x, y]) => (o.tiles ? [x * 16 + 8, y * 16 + 8] : [+x, +y])).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
	if (pts.length < 2) throw new Error('the guide line needs at least 2 points');
	const gdir = path.join(dir, 'gpu');
	fs.mkdirSync(gdir, { recursive: true });
	const blob = path.join(gdir, 'level.bin'), ref = path.join(gdir, 'guide_ref.eetas'), gfile = path.join(gdir, 'guide.txt');
	fs.writeFileSync(blob, G.levelBlob(level));
	C.writeEetas(ref, best.ms);
	fs.writeFileSync(gfile, pts.map(([x, y]) => `${x} ${y}`).join('\n') + '\n');
	const st = C.readJSON(path.join(dir, 'status.json'), {});
	const nc = !!st.coinsOptional;
	const S = Math.max(5, Math.min(3600, +seconds || 60));
	const state = {
		running: true, pid: process.pid, started: Date.now(), from, fromTime: C.fmt(tr.RUN[from]), points: pts, seconds: S,
		stage: 'searching', layer: 0, tick: from, states: 0, ticksPerSec: 0, bestSaving: 0, results: [], log: [],
	};
	const save = () => C.writeJSON(stateFile(id), state);
	const note = (s) => { state.log.push(`${new Date().toTimeString().slice(0, 8)} ${s}`); state.log = state.log.slice(-40); save(); };
	save();
	note(`from ${state.fromTime} (tick ${from}) along a ${pts.length}-point line, ${S} s`);
	const args = ['beam', blob, `--ref=${ref}`, `--from=${from}`, `--guide=${gfile}`, `--seconds=${S}`, `--width=${+o.width || 32768}`,
		`--depth=${best.complete - from}`, `--nocoins=${nc ? 1 : 0}`, `--guideWeight=${o.weight || 0.5}`, ...G.cacheArgs()];
	const handed = [];
	await new Promise((resolve) => {
		const ch = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let buf = '';
		const pending = [];
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				if (!line.startsWith('{')) continue;
				let ev;
				try { ev = JSON.parse(line); } catch (e) { continue; }
				if (ev.ev === 'progress') {
					Object.assign(state, { layer: ev.layer, tick: ev.tick, states: ev.states, ticksPerSec: Math.round(ev.ticksPerSec), bestSaving: Math.max(state.bestSaving, ev.bestSaving) });
					save();
				}
				else if (ev.ev === 'result') pending.push(offer(ev));
				else if (ev.error) note(`error: ${ev.error}`);
			}
		});
		ch.stderr.on('data', (d) => note(String(d).trim().slice(0, 200)));
		ch.on('close', () => Promise.all(pending).then(resolve));
	});
	/** a found run: evaluate it with the JS engine and hand it to the job */
	async function offer(ev) {
		const ins = Uint8Array.from(ev.inputs, (c) => (c.charCodeAt(0) - 48) & 31);
		const tail = ev.kind === 'rejoin' ? best.ms.subarray(ev.j) : new Uint8Array(0);
		const ms = new Uint8Array(from + ins.length + tail.length);
		ms.set(best.ms.subarray(0, from), 0); ms.set(ins, from); ms.set(tail, from + ins.length);
		const cand = C.evaluate(level, ms);
		const r = { t: Date.now(), kind: ev.kind, saving: ev.saving, ticks: ins.length, j: ev.j };
		if (!cand) { r.verdict = 'does not finish (not handed in)'; state.results.push(r); note(`found a ${ev.kind} (-${ev.saving}) that does not finish in the JS engine`); return; }
		r.runTicks = cand.runTicks; r.time = C.fmt(cand.runTicks);
		if (cand.runTicks >= best.runTicks) { r.verdict = 'not faster'; state.results.push(r); save(); return; }
		const res = await J.tryCandidate(id, C.eetasBytes(cand.ms), { source: `guide line ${state.fromTime}`, wait: 0 });
		r.verdict = res.handed === 'inbox' ? 'handed to the running optimizer' : (res.accepted ? 'accepted' : `not accepted (${res.verdict && res.verdict.reason})`);
		state.results.push(r);
		handed.push(r);
		note(`${ev.kind}: ${C.fmt(best.runTicks)} -> ${r.time} (-${best.runTicks - cand.runTicks}): ${r.verdict}`);
	}
	state.running = false;
	state.stage = 'done';
	state.finished = Date.now();
	if (!handed.length) note('nothing faster found along this line (try another line, a longer search, or an earlier start)');
	save();
	return state;
}

module.exports = { guide, guideState };

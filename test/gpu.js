'use strict';
// Differential test of the native engine (native/eecore.h via native/build/eegpu.exe) against src/eesim.js: both
// replay the same runs and must give the same stateHash(false, false) and stateHash(false, true) after EVERY tick.
// The first difference is reported with a field-by-field state comparison.
//   node test/gpu.js [--quick] [--gpu] [--levels=<dir>] [--only=jobs|files|fuzz] [--seed=N]
// Runs: every job's original and best run; every .eelvl in the levels dir (default ~/Downloads, $EEAT_LEVELS) with
// random sticky inputs; generated kitchen-sink levels (every block family) with random inputs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../src/eesim.js');
const C = require('../src/common.js');
const G = require('../src/gpu.js');

const args = C.parseArgs(process.argv.slice(2));
const QUICK = !!args.quick;
const GPU = !!args.gpu;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eegpu-'));
const TOOL = G.nativeTool();
if (!TOOL) { console.log('native tool missing: build it with node tools/build-native.js'); process.exit(2); }
let pass = 0, fail = 0;

function jsTrace(level, masks) {
	const sim = new E.EESim(level);
	const h = [BigInt(sim.stateHash(false, false)), BigInt(sim.stateHash(false, true))];
	const inp = new E.EEInput();
	let complete = -1, runTicks = -1;
	sim.onEvent = (k, d) => { if (k === 'complete' && complete < 0) { complete = sim.ticks(); runTicks = d.ticks; } };
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		h.push(BigInt(sim.stateHash(false, false)), BigInt(sim.stateHash(false, true)));
	}
	return { h, complete, runTicks, deaths: sim.deaths };
}

function jsState(level, masks, T) {
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	for (let t = 0; t < T; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	return sim;
}

function compareState(level, blobFile, eetasFile, masks, T) {
	const js = jsState(level, masks, T);
	const nat = JSON.parse(execFileSync(TOOL, ['state', blobFile, eetasFile, String(T)], { encoding: 'utf8' }));
	const diffs = [];
	const map = { gdx: () => js.gravity_dir.x, gdy: () => js.gravity_dir.y, cpx: () => js.checkpoint.x, cpy: () => js.checkpoint.y };
	for (const [k, v] of Object.entries(nat)) {
		if (k === 'hash' || k === 'hashNoCoins' || k === 'tail' || k === 'broken' || k === 'nsq' || k === 'nkq' || k === 'ntq') continue;
		let jv = map[k] ? map[k]() : (k.startsWith('kt') ? js._kt[+k.slice(2)] : js[k]);
		if (typeof jv === 'boolean') jv = jv ? 1 : 0;
		if (Array.isArray(v)) {
			const b = Buffer.alloc(8); b.writeDoubleLE(jv, 0);
			const hex = b.readBigUInt64LE(0).toString(16).padStart(16, '0');
			if (hex !== v[1]) diffs.push(`${k}: js ${jv} (${hex}) native ${v[0]} (${v[1]})`);
		} else if (jv !== v) diffs.push(`${k}: js ${jv} native ${v}`);
	}
	const qs = [js._stateQueue.length / 3, js._keysQueue.length / 2, js._tileQueue.length / 2];
	if (qs[0] !== nat.nsq || qs[1] !== nat.nkq || qs[2] !== nat.ntq) diffs.push(`queues js ${qs} native ${[nat.nsq, nat.nkq, nat.ntq]}`);
	return diffs;
}

function check(name, level, masks) {
	const blob = G.levelBlob(level);
	const bf = path.join(TMP, 'level.bin'), ef = path.join(TMP, 'run.eetas'), of = path.join(TMP, 'trace.bin');
	fs.writeFileSync(bf, blob);
	C.writeEetas(ef, masks);
	const info = JSON.parse(execFileSync(TOOL, ['trace', bf, ef, of, ...(GPU ? ['--gpu'] : [])], { encoding: 'utf8' }));
	const buf = fs.readFileSync(of);
	const js = jsTrace(level, masks);
	const n = masks.length;
	let bad = -1, which = '';
	for (let i = 0; i <= n; i++) {
		const a = buf.readBigUInt64LE(24 + 16 * i), b = buf.readBigUInt64LE(24 + 16 * i + 8);
		if (a !== js.h[2 * i]) { bad = i; which = 'hash'; break; }
		if (b !== js.h[2 * i + 1]) { bad = i; which = 'hashNoCoins'; break; }
	}
	const endOk = info.complete === js.complete && info.runTicks === js.runTicks && info.deaths === js.deaths;
	if (bad < 0 && endOk && info.broken < 0) {
		pass++;
		console.log(`  ok   ${name}: ${n} ticks equal${js.complete > 0 ? `, finish tick ${js.complete} (run ${js.runTicks})` : ''}${js.deaths ? `, ${js.deaths} deaths` : ''} (native ${(n / info.seconds / 1e6).toFixed(1)} M ticks/s)`);
		return true;
	}
	fail++;
	if (bad >= 0) {
		console.log(`  FAIL ${name}: ${which} differs after ${bad} ticks (mask ${bad > 0 ? masks[bad - 1] : '-'})`);
		const d = compareState(level, bf, ef, masks, bad);
		console.log('       ' + (d.length ? d.slice(0, 12).join('\n       ') : '(all compared fields equal: tail / queues / hashed-only state)'));
		const keep = path.join(__dirname, '..', 'src', 'out', `gpu_fail_${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}`);
		fs.mkdirSync(keep, { recursive: true });
		fs.copyFileSync(bf, path.join(keep, 'level.bin')); fs.copyFileSync(ef, path.join(keep, 'run.eetas'));
		console.log(`       kept in ${keep}`);
	} else {
		console.log(`  FAIL ${name}: end differs: native ${JSON.stringify(info)} js complete ${js.complete} run ${js.runTicks} deaths ${js.deaths}`);
	}
	return false;
}

/** random sticky inputs: hold a mask for 1..40 ticks */
function randomMasks(n, seed) {
	let s = seed >>> 0 || 1;
	const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
	const out = new Uint8Array(n);
	let m = 0;
	for (let i = 0; i < n;) {
		m = (rnd() * 32) | 0;
		if (rnd() < 0.4) m &= ~(2 | 4) | (rnd() < 0.5 ? 2 : 4);   // mostly one direction
		const len = 1 + ((rnd() * 40) | 0);
		for (let k = 0; k < len && i < n; k++) out[i++] = m;
	}
	return out;
}

function main() {
	const only = args.only || '';
	const seed = +(args.seed || 12345);
	if (!only || only === 'jobs') {
		console.log('job runs:');
		const J = require('../src/jobs.js');
		for (const id of C.jobIds()) {
			let level;
			try { level = J.loadJobLevel(id); } catch (e) { continue; }
			for (const f of ['original.eetas', 'best.eetas']) {
				const p = path.join(J.jobDir(id), f);
				if (fs.existsSync(p)) check(`${id} ${f}`, level, C.readEetas(p));
			}
		}
	}
	if (!only || only === 'files') {
		const dir = args.levels || process.env.EEAT_LEVELS || path.join(os.homedir(), 'Downloads');
		let files = [];
		try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.eelvl')).sort(); } catch (e) { /* none */ }
		if (QUICK) files = files.slice(0, 6);
		console.log(`level files (${files.length}, random inputs):`);
		const EL = require('../src/eelvl.js');
		let k = 0;
		for (const f of files) {
			let level;
			try { level = EL.loadEelvlLevel(path.join(dir, f)); } catch (e) { continue; }
			for (const mode of ['reset', 'load']) {
				const lv = mode === 'reset' ? level : E.prepareLevel({ ...EL.toSimLevel(EL.readEelvl(fs.readFileSync(path.join(dir, f)))), start_mode: 'load' });
				check(`${f.slice(0, 40)} [${mode}]`, lv, randomMasks(QUICK ? 3000 : 12000, seed + (k++)));
			}
		}
	}
	if (!only || only === 'fuzz') {
		// test/review.js's kitchen-sink levels: every block family the tick loop touches, music blocks without a sound,
		// background / stale / coin-cell portal entries, random exits (with and without rng_script)
		const R = require('./review.js');
		const S0 = 20260925;
		const variants = [
			['ks1 time doors, reset', (s) => R.kitchenSink(s), {}],
			['ks2 no time doors, load', (s) => R.kitchenSink(s, { timeDoors: false }), { start: 'load' }],
			['ks3 idle 40 + reset, ticksPerFrame 2', (s) => R.kitchenSink(s), { idleTicks: 40, ticksPerFrame: 2 }],
			['ks4 rng_script', (s) => R.kitchenSink(s, { timeDoors: false, rngScript: [2, 1, 0, 1, 2, 0, 0, 1] }), {}],
			['ks5 gold border', (s) => R.kitchenSink(s), { goldBorder: true }],
			['ks6 portal maze', (s) => R.kitchenSink(s, { timeDoors: false, nZoo: 120, nRandom: 10, nCoinExits: 10, nCoins: 24 }), {}],
			['ks7 portal maze, load, rng_script', (s) => R.kitchenSink(s, { timeDoors: false, nZoo: 120, nRandom: 10, nCoinExits: 10, nCoins: 24, rngScript: [3, 0, 5, 1, 2, 4, 0, 6, 1, 3] }), { start: 'load' }],
		];
		const seeds = QUICK ? 2 : +(args.seeds || 12);
		console.log(`kitchen-sink fuzz (${variants.length} variants x ${seeds} seeds, random inputs):`);
		for (const [name, mk, opts] of variants) {
			for (let k = 0; k < seeds; k++) {
				const level = E.prepareLevel(mk(S0 + 1000 * k + name.length), opts);
				check(`${name} #${k}`, level, R.randMasks(seed + 7919 * k + name.length, QUICK ? 3000 : 8000));
			}
		}
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	fs.rmSync(TMP, { recursive: true, force: true });
	process.exit(fail ? 1 : 0);
}
main();

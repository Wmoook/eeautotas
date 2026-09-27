'use strict';
// The steer field v4 (src/steer.js; ordering only, never a prune). Sections:
//   A model    hand-made rooms of a key door, a coin door (the distinct-coin DP) and a purple switch: the features and
//              layers, the steer cost at the start counts the detour to the key / coins / switch (the reach field's
//              does not), with the key (switch, coins) taken it is the reach field's again; the RCH4 file round trip
//              (readSteerFile gives the same numbers); another level's file is refused by the native tool
//   B agree    the JS lookup and the native tool's (eegpu steertest: the host, and with --gpu the GPU) along random input
//              runs in the rooms and, with --jobs=<dir> (default src/jobs), along the big jobs' best runs: the same fifths
//              and the beam's score to the bit (skipped without a native tool that reads RCH4)
//   C prune    the native explore with a garbage steer field (random costs) still finds the key room's route: the steer
//              field only orders (only the reach field's -1 rules states out); the CPU search (goexplore.js --steer)
//              finds it too, and one worker with a tick budget is reproducible
// usage: node test/steer.js [--only=A,B,C] [--gpu] [--tool=<eegpu>] [--jobs=<dir>]
// Exit code 1 if any check fails. Run the --gpu part through the machine's GPU lock (src/out/gpulock.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const R = require('../src/reach.js');
const SF = require('../src/steer.js');
const G = require('../src/gpu.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY = arg('only', '').split(',').filter(Boolean);
const GPU = argv.includes('--gpu');
const want = (s) => !ONLY.length || ONLY.includes(s);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-steer-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

// ASCII rooms: # wall, . air, S spawn, T trophy, k red key, d red door, $ coin, c coin door (2 coins), s purple switch 1,
// g purple switch door 1
const ID = { '#': [9], S: [255], T: [121], k: [6], d: [23], $: [100], c: [43, 2], s: [113, 1], g: [184, 1] };
function ascii(rows) {
	const H = rows.length, W = rows[0].length, cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '.') return; const v = ID[ch]; if (!v) throw new Error(`legend ${ch}`); cells.push([x, y, ...v]); }));
	return { buf: ED.eelvlOf({ name: 't', width: W, height: H, cells }), W, H };
}
const levelOf = (buf) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
const wall = (w) => '#'.repeat(w);
const row = (inner) => `#${inner}#`;
// the trophy behind a door on the right, the key (coins, switch) on the far left: the start is between
function room(k) {
	const w = 40;
	const mid = '.'.repeat(w - 2);
	const floor = [...mid];
	floor[1] = k === 'key' ? 'k' : k === 'switch' ? 's' : '$';
	if (k === 'coins') floor[3] = '$';
	floor[18] = 'S';
	floor[w - 6] = k === 'key' ? 'd' : k === 'switch' ? 'g' : 'c';
	floor[w - 4] = 'T';
	// (the door is the whole column: no jump over it)
	const top = [...mid]; top[w - 6] = floor[w - 6];
	const t = top.join('');
	return ascii([wall(w), row(t), row(t), row(t), row(t), row(floor.join('')), wall(w)]);
}
const ROOMS = { key: room('key'), coins: room('coins'), switch: room('switch') };
const toolPath = arg('tool', G.nativeTool());
let toolOk = false;
if (toolPath) { try { execFileSync(toolPath, ['steertest'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { toolOk = /steertest/.test(String(e.stderr || '')); } }

function sectionA() {
	section('A the model: layers, detours, the file');
	for (const [name, r] of Object.entries(ROOMS)) {
		const L = levelOf(r.buf);
		const st = SF.buildSteer(L);
		const f = R.reachField(L);
		const sim = new E.EESim(L); sim.reset();
		const s0 = SF.steerAt(st, sim), r0 = R.costAt(f, sim);
		check(`${name}: modelled (${st.info.features.join(', ')}; ${st.info.layers} layers${st.dp ? `, coin DP ${st.dp.n}` : ''})`, st.S > 1 || !!st.dp);
		// (the key / coins / switch are 17-15 tiles left of the start, the door right: the detour there and back)
		check(`${name}: the steer cost at the start counts the detour (steer ${s0}, reach ${r0})`, s0 > r0 + 25, `${s0} vs ${r0}`);
		// taken: the reach field's cost again (the door open in the ball's layer)
		if (name === 'key') sim._keysMask |= 1;
		else if (name === 'switch') { sim._switches = new Map([[1, true]]); }
		else { sim.coins = 2; }
		const s1 = SF.steerAt(st, sim);
		check(`${name}: taken, the steer cost is the reach field's (${s1} vs ${r0})`, Math.abs(s1 - r0) <= 1, `${s1}`);
		const rd = SF.readSteerFile(SF.steerFileBytes(st, G.blobFp(G.levelBlob(L))));
		let same = true;
		const sim2 = new E.EESim(L); sim2.reset();
		const inp = new E.EEInput();
		for (let t = 0; t < 400 && same; t++) { E.applyMask(inp, [4, 4, 5, 2, 0, 3][(t / 37 | 0) % 6]); sim2.tick(inp); if (SF.steerFifths(st, sim2) !== SF.steerFifths(rd, sim2) || SF.steerScore(st, sim2) !== SF.steerScore(rd, sim2)) same = false; }
		check(`${name}: the RCH4 file round trip gives the same numbers`, same);
	}
	if (toolOk) {
		const a = levelOf(ROOMS.key.buf), b = levelOf(ROOMS.switch.buf);
		fs.writeFileSync(path.join(tmp, 'a.bin'), G.levelBlob(a));
		fs.writeFileSync(path.join(tmp, 'b.steer'), SF.steerFileBytes(SF.buildSteer(b), G.blobFp(G.levelBlob(b))));
		C.writeEetas(path.join(tmp, 'r.eetas'), [4, 4, 4]);
		let out = '';
		try { out = execFileSync(toolPath, ['steertest', path.join(tmp, 'a.bin'), path.join(tmp, 'b.steer'), path.join(tmp, 'r.eetas')], { encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
		check('another level\'s steer file is refused by the native tool', /another level/.test(out), out.trim().slice(0, 120));
	}
}

function agree(name, L, st, runs) {
	const blob = G.levelBlob(L);
	fs.writeFileSync(path.join(tmp, 'l.bin'), blob);
	fs.writeFileSync(path.join(tmp, 's.steer'), SF.steerFileBytes(st, G.blobFp(blob)));
	let n = 0, dF = 0, dS = 0, gF = 0, gS = 0, err = '';
	for (const m of runs) {
		C.writeEetas(path.join(tmp, 'r.eetas'), m);
		const out = JSON.parse(execFileSync(toolPath, ['steertest', path.join(tmp, 'l.bin'), path.join(tmp, 's.steer'), path.join(tmp, 'r.eetas'), ...(GPU ? ['--gpu=1', ...G.cacheArgs()] : [])],
			{ encoding: 'utf8', maxBuffer: 1 << 30 }).trim().split('\n').pop());
		if (out.error) { err = out.error; break; }
		const sim = new E.EESim(L); sim.reset();
		const inp = new E.EEInput();
		const fb = new Float32Array(1), ub = new Uint32Array(fb.buffer);
		for (let t = 0; t < m.length; t++) {
			E.applyMask(inp, m[t]); sim.tick(inp);
			const f = SF.steerFifths(st, sim);
			fb[0] = f >= 0 ? SF.steerScore(st, sim) : -1;
			n++;
			if (out.host[t] !== f) dF++;
			if (out.hostScore[t] !== ub[0]) dS++;
			if (out.gpu) { if (out.gpu[t] !== f) gF++; if (out.gpuScore[t] !== ub[0]) gS++; }
		}
	}
	check(`${name}: JS = native steertest (host${GPU ? ' and GPU' : ''}) on ${n} states`, !err && dF + dS + gF + gS === 0, err || `fifths ${dF} / scores ${dS}${GPU ? `, GPU ${gF} / ${gS}` : ''} differ`);
}
function randomRuns(k, n, len) {
	let seed = 12345 + k;
	const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
	const out = [];
	for (let r = 0; r < n; r++) { const m = new Uint8Array(len); let cur = 0; for (let t = 0; t < len; t++) { if (rnd() > 0.85) cur = [0, 1, 2, 4, 5, 3, 6, 4, 4, 5, 2][Math.floor(rnd() * 11)]; m[t] = cur; } out.push(m); }
	return out;
}
function sectionB() {
	section('B agree: the JS lookup = eegpu steertest');
	if (!toolOk) { console.log(`  (skipped: ${toolPath ? `${toolPath} has no steertest (older than the app: rebuild it, node tools/build-native.js)` : 'no native tool'})`); return; }
	Object.entries(ROOMS).forEach(([name, r], k) => { const L = levelOf(r.buf); agree(name, L, SF.buildSteer(L), randomRuns(k, 6, 600)); });
	const jobs = arg('jobs', path.join(__dirname, '..', 'src', 'jobs'));
	let ids = [];
	try { ids = fs.readdirSync(jobs).filter((d) => fs.existsSync(path.join(jobs, d, 'original.eelvl')) && fs.existsSync(path.join(jobs, d, 'best.eetas'))); } catch (e) { /* no jobs */ }
	const seen = new Set();
	for (const id of ids) {
		const buf = fs.readFileSync(path.join(jobs, id, 'original.eelvl'));
		const L = levelOf(buf);
		if (L.width * L.height < 20000) continue;
		const key = `${L.width}x${L.height}:${buf.length}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const st = SF.buildSteer(L);
		if (!(st.S > 1 || st.dp)) continue;
		agree(id, L, st, [C.readEetas(path.join(jobs, id, 'best.eetas')), ...randomRuns(ids.indexOf(id), 2, 2000)]);
	}
}

function sectionC() {
	section('C prune: the steer field only orders');
	const r = ROOMS.key;
	const L = levelOf(r.buf);
	const st = SF.buildSteer(L);
	const lf = path.join(tmp, 'key.eelvl');
	fs.writeFileSync(lf, r.buf);
	if (toolOk) {
		// a garbage steer field: every body's costs random
		let seed = 99;
		const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
		for (const b of st.bodies) for (const k of ['costR', 'costF', 'costL', 'costC', 'costX', 'walk']) if (b[k]) { const a = b[k] = Uint16Array.from(b[k]); for (let i = 0; i < a.length; i++) a[i] = rnd() < 0.3 ? R.CUT : (rnd() * 4000) | 0; }
		const blob = G.levelBlob(L);
		fs.writeFileSync(path.join(tmp, 'k.bin'), blob);
		fs.writeFileSync(path.join(tmp, 'k.steer'), SF.steerFileBytes(st, G.blobFp(blob)));
		R.writeReachFile(R.reachField(L), path.join(tmp, 'k.reach'), G.blobFp(blob));
		const run = (extra) => {
			let out = '';
			try { out = execFileSync(toolPath, ['explore', path.join(tmp, 'k.bin'), '-', '--finish=1', '--discrete=1', '--depth=3000', '--seconds=60', `--reach=${path.join(tmp, 'k.reach')}`, '--prune=1', ...extra, ...G.cacheArgs()], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch (e) { out = String(e.stdout || ''); }
			let fin = null, steer = false;
			for (const line of out.split('\n')) { try { const j = JSON.parse(line); if (j.ev === 'result' || j.ev === 'finish' || (j.ev === 'hit' && j.kind === 'finish')) fin = fin || j; if (j.ev === 'done' && j.finish) fin = fin || j; if (j.ev === 'steer') steer = true; } catch (e) { /* not JSON */ } }
			return { fin, steer, tail: out.trim().split('\n').pop() };
		};
		if (GPU) {
			const a = run([]), b = run([`--steer=${path.join(tmp, 'k.steer')}`]);
			check('explore finds the key room\'s route without the steer field', !!a.fin, a.tail.slice(0, 160));
			check('... and with a garbage steer field (loaded; nothing pruned by it)', !!b.fin && b.steer, b.tail.slice(0, 160));
		} else console.log('  (the native explore: with --gpu)');
	}
	const goex = (extra) => {
		const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--workers=1', '--seed=3', '--maxTicks=3000000', '--mem=200', '--seconds=120', '--first=1', ...extra], { encoding: 'utf8' });
		const res = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((j) => j && j.ev === 'result');
		const start = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).find((j) => j && j.ev === 'start');
		return { route: res.length ? res[0] : null, start };
	};
	const g1 = goex(['--steer=build']), g2 = goex(['--steer=build']);
	check('goexplore --steer: a route in the key room (replayed)', !!g1.route && !!(g1.start && g1.start.steer), g1.route ? `${g1.route.ticks} ticks after ${g1.route.simTicks} simulated` : 'none');
	check('... one worker with a tick budget is reproducible', !!g1.route && !!g2.route && g1.route.inputs === g2.route.inputs && g1.route.simTicks === g2.route.simTicks);
}

if (want('A')) sectionA();
if (want('B')) sectionB();
if (want('C')) sectionC();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

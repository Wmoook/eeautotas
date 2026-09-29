'use strict';
// The steer field v4 (src/steer.js; ordering only, never a prune). Sections:
//   A model    hand-made rooms of a key door, a coin door (the distinct-coin DP) and a purple switch: the features and
//              layers, the steer cost at the start counts the detour to the key / coins / switch (the reach field's
//              does not), with the key (switch, coins) taken it is the reach field's again; the RCH4 file round trip
//              (readSteerFile gives the same numbers); another level's file is refused by the native tool; the build's
//              byte budget: one body's bytes leave the key out (info.over); the forced portals' lastPortal chains (a
//              portal next to an exit walked: reach.js unforceChains), with --jobs Good Egg along OC's run
//   B agree    the JS lookup and the native tool's (eegpu steertest: the host, and with --gpu the GPU) along random input
//              runs in the rooms and, with --jobs=<dir> (default src/jobs), along the big jobs' best runs: the same fifths
//              and the beam's score to the bit (skipped without a native tool that reads RCH4)
//   C prune    the native explore with a garbage steer field (random costs) still finds the key room's route: the steer
//              field only orders (only the reach field's -1 rules states out); the CPU search (goexplore.js --steer)
//              finds it too, and one worker with a tick budget is reproducible
// usage: node test/steer.js [--only=A,B,C] [--gpu] [--tool=<eegpu>] [--jobs=<dir>] [--exploreSec=60]
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
// (C: the explore's time limit; more on a GPU other work keeps busy: at 60 s the plain explore too ran out of time there)
const EXPLORE_S = +arg('exploreSec', '60');
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
		if (name === 'coins') {
			// the coin plan's next gate (the wall breaker's stall target): a coin of the room from the start, none once the
			// door's coins are taken
			const s3 = new E.EESim(L); s3.reset();
			const g = SF.nextGate(rd, s3);
			const tile = g ? [...L.coinBit].indexOf(g.bit) : -1;
			check(`coins: the coin plan's next gate from the start is a coin of the room (tile ${tile % L.width},${Math.floor(tile / L.width)})`, tile >= 0 && L.fg[tile] !== 0);
			s3.coins = 2;
			check('coins: no next gate with the door\'s coins taken', SF.nextGate(rd, s3) === null);
			// the coin legs on worker threads (steer.js legPool) = the legs one after another: the same file, bit for bit;
			// also the plan past its count's layered legs (coinLegsLayered: arrival costs from the workers)
			const bytesOf = (o) => SF.steerFileBytes(SF.buildSteer(L, Object.assign({ maxMs: 600000 }, o)), null);
			const same0 = Buffer.compare(bytesOf({ legThreads: 0 }), bytesOf({ legThreads: 2 })) === 0;
			check('coins: the coin legs on 2 worker threads give the same steer file as one after another', same0);
			const T = st.dp ? st.dp.T : 2;
			const p0 = bytesOf({ legThreads: 0, coinT: T }), p2 = bytesOf({ legThreads: 2, coinT: T });
			check(`coins: the layered legs (coinT ${T}) on 2 worker threads give the same steer file`, Buffer.compare(p0, p2) === 0);
		}
	}
	// the build's budget: a byte budget of one body leaves the key out (one layer), said in info.over
	{
		const L = levelOf(ROOMS.key.buf);
		const b1 = SF.buildSteer(L, { maxBytes: L.width * L.height * 120 });
		check('the build\'s budget: one body\'s bytes leave the key out (one layer, info.over)', b1.S === 1 && /key0: over 1 layers/.test(b1.info.over || ''), `${b1.S} ${b1.info.over}`);
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
	forcedChains();
}

/** the ordering fields' forced portals and a ball that a teleport put on a portal exit (the n2-int gate study's defect,
 *  reach.js unforceChains): it keeps lastPortal over every portal tile it moves on to (eesim.js processPortals), so a
 *  portal next to an exit is walked, not a teleport. A corridor: the start, portal 1 across it (to 2), its exit 2 with a
 *  column of portal 4 (to 5, back by the start) right of it and the trophy; holding right finishes in the engine. Forced,
 *  portal 4 sent the model back to the start: the trophy out of reach, the ordering field cut and the steer without a
 *  value there. With --jobs (default src/jobs), Good Egg along its OC run (the pocket columns x = 1 / 3:
 *  the steer had no value and no next gate in 2,258 of its 4,204 states, coins 0-8) */
function forcedChains() {
	const W = 40, H = 8, y = H - 2, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let yy = 1; yy < H - 1; yy++) cells.push([0, yy, 9], [W - 1, yy, 9]);
	// portal 1 (to 2) and portal 4 (to 5) across the corridor; the exit 2 left of portal 4's column; 5 by the start
	for (let yy = 1; yy < H - 1; yy++) cells.push([6, yy, 242, 1, 1, 2], [21, yy, 242, 1, 4, 5]);
	cells.push([2, y, 255], [20, y, 242, 1, 2, 9], [3, 1, 242, 1, 5, 9], [34, y, 121]);
	const buf = ED.eelvlOf({ name: 'chain', width: W, height: H, cells });
	const L = levelOf(buf);
	const ev = C.evaluate(L, new Uint8Array(600).fill(4));
	const sim = new E.EESim(L); sim.reset();
	const st = SF.buildSteer(L), f = R.reachField(L, { oneWayEntry: true, portalForced: true });
	const s0 = SF.steerAt(st, sim), f0 = R.costAt(f, sim);
	check('a portal next to the exit a teleport put the ball on is walked (lastPortal), not forced: holding right finishes; the ordering field (portalForced) and the steer have a value at the start',
		!!ev && ev.deaths === 0 && f0 >= 0 && Number.isFinite(s0),
		`${ev ? `${ev.runTicks} run ticks, ${ev.deaths} deaths` : 'no finish'}; field ${f0}, steer ${s0}`);
	const jobs = arg('jobs', path.join(__dirname, '..', 'src', 'jobs'));
	let ids = [];
	try { ids = fs.readdirSync(jobs).filter((d) => /good-egg-galaxy-oc/.test(d) && fs.existsSync(path.join(jobs, d, 'original.eelvl')) && fs.existsSync(path.join(jobs, d, 'original.eetas'))); } catch (e) { /* no jobs */ }
	if (!ids.length) { console.log(`  (skipped: no Good Egg job with OC's run in ${jobs})`); return; }
	const G2 = levelOf(fs.readFileSync(path.join(jobs, ids[0], 'original.eelvl')));
	const ms = C.readEetas(path.join(jobs, ids[0], 'original.eetas'));
	const sg = SF.buildSteer(G2), s2 = new E.EESim(G2), in2 = new E.EEInput();
	s2.reset();
	let n = 0, nan = 0, noGate = 0, dpn = 0;
	for (let t = 0; t <= ms.length; t++) {
		if (t > 0) { E.applyMask(in2, ms[t - 1]); s2.tick(in2); }
		if (s2.has_silver_crown) break;
		if (s2.is_dead) continue;
		n++;
		if (Number.isNaN(SF.steerAt(sg, s2))) nan++;
		if (sg.dp && s2.coins < sg.dp.T) { dpn++; if (!SF.nextGate(sg, s2)) noGate++; }
	}
	check(`Good Egg along OC's run (${ids[0]}): the steer has a value and the coin plan a next gate almost everywhere (at most 1% without)`,
		!!sg.dp && n > 1000 && nan <= n / 100 && noGate <= dpn / 100, `${n} states, ${nan} without a value, ${noGate} of ${dpn} without a next gate; coin DP ${sg.dp ? sg.dp.n : 0}`);
}
function agree(name, L, st, runs) {
	const blob = G.levelBlob(L);
	fs.writeFileSync(path.join(tmp, 'l.bin'), blob);
	fs.writeFileSync(path.join(tmp, 's.steer'), SF.steerFileBytes(st, G.blobFp(blob)));
	let n = 0, dF = 0, dS = 0, gF = 0, gS = 0, err = '';
	for (const m of runs) {
		C.writeEetas(path.join(tmp, 'r.eetas'), m);
		let raw = '';
		try { raw = execFileSync(toolPath, ['steertest', path.join(tmp, 'l.bin'), path.join(tmp, 's.steer'), path.join(tmp, 'r.eetas'), ...(GPU ? ['--gpu=1', ...G.cacheArgs()] : [])], { encoding: 'utf8', maxBuffer: 1 << 30 }); } catch (e) { raw = String(e.stdout || '') || JSON.stringify({ error: e.message }); }
		let out;
		try { out = JSON.parse(raw.trim().split('\n').pop()); } catch (e) { out = { error: raw.slice(0, 200) }; }
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
			try { out = execFileSync(toolPath, ['explore', path.join(tmp, 'k.bin'), '-', '--finish=1', '--discrete=1', '--depth=1500', `--seconds=${EXPLORE_S}`, '--coarse=0', '--cqx=0.5', '--cqv=16', '--qy=1', '--qvy=16', `--reach=${path.join(tmp, 'k.reach')}`, '--prune=1', ...extra, ...G.cacheArgs()], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch (e) { out = String(e.stdout || ''); }
			let fin = null, steer = false;
			for (const line of out.split('\n')) { try { const j = JSON.parse(line); if (j.ev === 'hit') fin = fin || j; if (j.ev === 'done' && j.finish) fin = fin || j; if (j.ev === 'steer') steer = true; } catch (e) { /* not JSON */ } }
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

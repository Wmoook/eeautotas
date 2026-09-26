'use strict';
// explore.js --hunt (guided skip hunting), CPU only, on a hand-made room (no jobs needed, a few seconds):
//   the reference walks right into a block, keeps pushing against it (identical states: a known skip), jumps over it
//   and walks to the trophy.
//   - the hunt finds the skip: its output is replayed (C.evaluate) and accepted (C.judge), faster
//   - the edges file names the reference (sha1 of its bytes) and every edge is exact: S(b) + inputs = S(j) by stateHash
//   - the same seed and tick budget give the same edges and the same run (deterministic)
//   - --tails=1 (the grind's mode) still writes an accepted run on the same window
// and skips.js (the skip search) on a second room: the run falls down a shaft right past a ledge, takes a detour and
// lands on the ledge later; the search names the window, finds entrances, and a route from one saves 100+ ticks
// (judged), with exact edges and the same output twice.
// usage: node test/explore.js        Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-explore-'));
const W = 30, H = 8, cells = room(W, H);
cells.push([2, H - 2, 255], [W - 4, H - 2, 121], [10, H - 2, 9]);
const json = EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells })));
const levelFile = path.join(TMP, 'level.json');
fs.writeFileSync(levelFile, JSON.stringify(json));
const level = E.loadLevel(levelFile);
// the reference: 5 idle ticks (before the first input), right x80 (against the block from tick ~54 on: speed 0, the same
// state every tick), right + jump x3, right to the trophy
const raw = [];
for (const [m, n] of [[0, 5], [4, 80], [5, 3], [4, 300]]) for (let k = 0; k < n; k++) raw.push(m);
const evRef = C.evaluate(level, Uint8Array.from(raw));
const refFile = path.join(TMP, 'ref.eetas');
C.writeEetas(refFile, evRef.ms);
const masks = C.readEetas(refFile);
/** the state hash after each tick of the reference (index = ticks played) */
const hashes = [];
{
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	hashes.push(sim.stateHash(false, true));
	for (const m of masks) { E.applyMask(inp, m); sim.tick(inp); hashes.push(sim.stateHash(false, true)); }
}
let still = 0;
for (let t = 1; t < hashes.length; t++) if (hashes[t] === hashes[t - 1]) still++;
check('the reference finishes and pushes against the block for a while (the skip to find)', evRef !== null && still >= 20, `${evRef && evRef.runTicks} run ticks, ${still} repeated states`);

const run = (tag, extra) => {
	const out = path.join(TMP, `${tag}.eetas`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'explore.js'), `--tas=${refFile}`, `--level=${levelFile}`, '--from=5', '--join=5',
		'--until=60', '--workers=1', '--seconds=30', '--ticks=150000', '--seed=1', '--nocoins=1', `--out=${out}`, ...extra], { encoding: 'utf8' });
	const edgesFile = out + '.edges.json';
	return { status: r.status, log: (r.stdout || '') + (r.stderr || ''), out: fs.existsSync(out) ? C.readEetas(out) : null,
		edges: fs.existsSync(edgesFile) ? fs.readFileSync(edgesFile, 'utf8') : null };
};
const judged = (ms) => { if (!ms) return { accept: false, reason: 'no output' }; return C.judge(C.evaluate(level, ms), evRef, evRef.deaths); };

console.log('\n== --hunt=1');
const h1 = run('hunt1', ['--hunt=1']);
check('exits cleanly', h1.status === 0, h1.status !== 0 ? h1.log.slice(-600) : undefined);
const v1 = judged(h1.out);
check('its run is replayed and accepted, at least 20 ticks faster', v1.accept && v1.saved >= 20, v1.accept ? `-${v1.saved}` : v1.reason);
const ef = h1.edges ? JSON.parse(h1.edges) : null;
check('the edges file names the reference (sha1 of its bytes)', ef && ef.ref === crypto.createHash('sha1').update(C.eetasBytes(masks)).digest('hex') && ef.nocoins === 1 && ef.n === masks.length);
let exact = 0, bad = 0;
for (const [b, j, s] of ef ? ef.edges : []) {
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	for (let t = 0; t < b; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	for (const ch of s) { E.applyMask(inp, ch.charCodeAt(0) - 48); sim.tick(inp); }
	if (j - b - s.length > 0 && sim.stateHash(false, true) === hashes[j]) exact++; else bad++;
}
check('every edge is exact: S(b) + its inputs = S(j), and shorter', ef && ef.edges.length > 0 && bad === 0, `${exact} exact, ${bad} not`);
const h2 = run('hunt2', ['--hunt=1']);
check('deterministic: the same seed and tick budget give the same edges and run', h2.edges === h1.edges && h2.out && h1.out && Buffer.compare(Buffer.from(h2.out), Buffer.from(h1.out)) === 0);

console.log('\n== --tails=1 (the grind mode, unchanged)');
const t1 = run('tails', ['--exact=1', '--tails=1']);
const vt = judged(t1.out);
check('its run is replayed and accepted', t1.status === 0 && vt.accept && vt.saved > 0, vt.accept ? `-${vt.saved}` : vt.reason);

// ---------------------------------------------------------------- skips.js: a pass-by skip
// The run walks off a high platform and falls down a shaft right past the left end of a ledge, lands at the bottom,
// runs left for a run-up, jumps up onto the ledge and runs right into a step (pushing against it: the funnel), hops over
// it to the trophy. The skip: land on the ledge during the fall.
console.log('\n== skips.js (pass-by windows, entrances, routes)');
{
	const SW = 24, SH = 16, sc = room(SW, SH);
	for (let x = 4; x <= 7; x++) sc.push([x, 5, 9]);
	sc.push([4, 4, 255]);
	for (let x = 10; x <= 22; x++) sc.push([x, 12, 9]);
	sc.push([17, 11, 9], [21, 11, 121]);
	const sj = EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 's', width: SW, height: SH, cells: sc })));
	const sLevelFile = path.join(TMP, 'skiproom.json');
	fs.writeFileSync(sLevelFile, JSON.stringify(sj));
	const sLevel = E.loadLevel(sLevelFile);
	const sim = new E.EESim(sLevel); sim.reset(); const inp = new E.EEInput();
	const ms = [];
	const step = (m) => { ms.push(m); E.applyMask(inp, m); sim.tick(inp); };
	for (let k = 0; k < 5; k++) step(0);
	let phase = 0, wallT = 0;
	for (let k = 0; k < 3000 && !sim.has_silver_crown; k++) {
		const tx = (sim.px + 8) / 16, ty = (sim.py + 8) / 16;
		if (phase === 0) { step(4); if (tx > 7.6) phase = 1; }                                   // off the platform
		else if (phase === 1) { step(tx > 8.4 ? 2 : 0); if (sim.on_ground && ty > 13) phase = 2; }   // down the shaft, past the ledge
		else if (phase === 2) { step(2); if (tx < 3) phase = 3; }                                // left: a run-up
		else if (phase === 3) { step(4); if (tx > 7.5) phase = 4; }
		else if (phase === 4) { step(sim.on_ground ? 5 : 4); if (sim.on_ground && ty < 12) phase = 5; }   // up onto the ledge
		else if (phase === 5) { step(4); if (sim.on_ground && sim.speed_x === 0 && ++wallT >= 3) phase = 6; }   // into the step
		else step(5);
	}
	const sRef = C.evaluate(sLevel, Uint8Array.from(ms));
	check('the room\'s run finishes, with a detour past the ledge', sRef !== null && sRef.runTicks > 250, sRef && `${sRef.runTicks} run ticks`);
	const sRefFile = path.join(TMP, 'skipref.eetas');
	C.writeEetas(sRefFile, sRef.ms);
	const sMasks = C.readEetas(sRefFile);
	const sHashes = [];
	{
		const s2 = new E.EESim(sLevel); s2.reset(); const i2 = new E.EEInput();
		sHashes.push(s2.stateHash(false, true));
		for (const m of sMasks) { E.applyMask(i2, m); s2.tick(i2); sHashes.push(s2.stateHash(false, true)); }
	}
	const sk = (tag) => {
		const out = path.join(TMP, `${tag}.eetas`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'skips.js'), `--tas=${sRefFile}`, `--level=${sLevelFile}`, '--nocoins=1', '--workers=1',
			'--seconds=120', '--top=1', '--K=4', '--cap1=300000', '--cap2=300000', `--out=${out}`], { encoding: 'utf8' });
		return { status: r.status, log: (r.stdout || '') + (r.stderr || ''), out: fs.existsSync(out) ? C.readEetas(out) : null,
			edges: fs.existsSync(out + '.edges.json') ? fs.readFileSync(out + '.edges.json', 'utf8') : null };
	};
	const s1 = sk('skips1');
	check('exits cleanly', s1.status === 0, s1.status !== 0 ? s1.log.slice(-600) : undefined);
	check('it names the window and finds entrances', /window \d+ \(.*\): \d+ entrances/.test(s1.log) && /routes from \d+ of \d+ entrances/.test(s1.log));
	const sv = s1.out ? C.judge(C.evaluate(sLevel, s1.out), sRef, sRef.deaths) : { accept: false, reason: 'no output' };
	check('its run is replayed and accepted, at least 100 ticks faster (a route from an entrance)', sv.accept && sv.saved >= 100, sv.accept ? `-${sv.saved}` : sv.reason);
	const se = s1.edges ? JSON.parse(s1.edges) : null;
	let sx = 0, sb = 0;
	for (const [b, j, s] of se ? se.edges : []) {
		const s3 = new E.EESim(sLevel); s3.reset(); const i3 = new E.EEInput();
		for (let t = 0; t < b; t++) { E.applyMask(i3, sMasks[t]); s3.tick(i3); }
		for (const ch of s) { E.applyMask(i3, ch.charCodeAt(0) - 48); s3.tick(i3); }
		if (j - b - s.length > 0 && s3.stateHash(false, true) === sHashes[j]) sx++; else sb++;
	}
	check('the edges file names the run, and every edge is exact: S(b) + its inputs = S(j), and shorter',
		se && se.ref === crypto.createHash('sha1').update(C.eetasBytes(sMasks)).digest('hex') && se.edges.length > 0 && sb === 0, `${sx} exact, ${sb} not`);
	const s2r = sk('skips2');
	check('deterministic: the same options give the same edges and run', s2r.edges === s1.edges && s2r.out && s1.out && Buffer.compare(Buffer.from(s2r.out), Buffer.from(s1.out)) === 0);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

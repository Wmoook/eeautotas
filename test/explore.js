'use strict';
// explore.js --hunt (guided skip hunting), CPU only, on a hand-made room (no jobs needed, a few seconds):
//   the reference walks right into a block, keeps pushing against it (identical states: a known skip), jumps over it
//   and walks to the trophy.
//   - the hunt finds the skip: its output is replayed (C.evaluate) and accepted (C.judge), faster
//   - the edges file names the reference (sha1 of its bytes) and every edge is exact: S(b) + inputs = S(j) by stateHash
//   - the same seed and tick budget give the same edges and the same run (deterministic)
//   - --tails=1 (the grind's mode) still writes an accepted run on the same window
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

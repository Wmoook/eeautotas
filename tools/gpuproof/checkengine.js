'use strict';
// The GPU engine on a new GPU (box 8 lane 'gpuproof', 2026-10-01): `eegpu info`, `eegpu bench` (src/bench.js's arena),
// and per level a short `eegpu beam --goal=1` whose inputs (its finish, else its closest attempt) are replayed by
// eesim.js and by `eegpu trace --gpu=1`: the same state hashes (stateHash(false, false) and (false, true)) at every tick,
// and the beam's finish tick = eesim's.
//   node tools/gpuproof/checkengine.js <level.eelvl>... [--tool=<eegpu>] [--cachedir=<dir>] [--seconds=20] [--width=8192]
// Prints JSON lines; exit 1 on any difference.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const E = require('../../src/eesim.js');
const T = require('../../src/plan/types.js');
const G = require('../../src/gpu.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const tool = args.tool || G.nativeTool();
const cache = args.cachedir ? [`--cachedir=${args.cachedir}`] : [];
const say = (o) => console.log(JSON.stringify(o));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpucheck-'));
let bad = 0;

const lines = (s) => s.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
say(Object.assign({ ev: 'info' }, lines(cp.execFileSync(tool, ['info', ...cache], { encoding: 'utf8' })).pop()));
{
	const L = E.prepareLevel(require('../../src/bench.js').arenaJson());
	const f = path.join(dir, 'arena.bin');
	fs.writeFileSync(f, G.levelBlob(L));
	say(Object.assign({ ev: 'bench' }, lines(cp.execFileSync(tool, ['bench', f, '--seconds=3', ...cache], { encoding: 'utf8' })).pop()));
}
for (const file of files) {
	const L = T.loadLevelFile(path.resolve(file));
	const bf = path.join(dir, path.basename(file) + '.bin');
	fs.writeFileSync(bf, G.levelBlob(L));
	const t0 = Date.now();
	const out = lines(cp.execFileSync(tool, ['beam', bf, '--goal=1', `--seconds=${args.seconds || 20}`, `--width=${args.width || 8192}`, '--depth=20000', ...cache], { encoding: 'utf8', maxBuffer: 1 << 28 }));
	const fin = out.filter((o) => o.ev === 'result' && o.kind === 'finish').pop();
	const clo = out.filter((o) => o.ev === 'closest').pop();
	const done = out.find((o) => o.ev === 'done') || {};
	const inputs = fin ? fin.inputs : clo ? clo.inputs : '';
	const masks = Uint8Array.from(inputs, (c) => (c.charCodeAt(0) - 48) & 31);
	// eesim.js: both hashes after every tick, the finish tick
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const js = [BigInt(sim.stateHash(false, false)), BigInt(sim.stateHash(false, true))];
	let jsFinish = -1;
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		js.push(BigInt(sim.stateHash(false, false)), BigInt(sim.stateHash(false, true)));
		if (jsFinish < 0 && sim.has_silver_crown) jsFinish = t + 1;
	}
	// eegpu trace --gpu=1
	const ef = path.join(dir, path.basename(file) + '.eetas'), of = path.join(dir, path.basename(file) + '.trace');
	fs.writeFileSync(ef, Buffer.from(Array.from(masks, (m) => 48 + m)));
	const tr = lines(cp.execFileSync(tool, ['trace', bf, ef, of, '--gpu=1', ...cache], { encoding: 'utf8' })).pop();
	const b = fs.readFileSync(of);
	let diff = -1;
	for (let i = 0; i < js.length; i++) { if (b.readBigUInt64LE(24 + 8 * i) !== js[i]) { diff = i >> 1; break; } }
	const ok = diff < 0 && (!fin || jsFinish === fin.ticks) && tr.complete === jsFinish;
	if (!ok) bad++;
	say({ ev: 'level', level: path.basename(file), ok, kind: fin ? 'finish' : 'closest', ticks: masks.length, beamFinish: fin ? fin.ticks : null, jsFinish,
		gpuTraceFinish: tr.complete, firstDiffTick: diff, beamTicks: done.ticks, beamTicksPerSec: done.ticksPerSec, layers: done.layers, ms: Date.now() - t0 });
}
say({ ev: 'done', bad });
process.exit(bad ? 1 : 0);

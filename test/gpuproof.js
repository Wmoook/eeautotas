'use strict';
// The exact search on the GPU (`eegpu exact`, tools/gpuproof/exact.js, tools/perfect/gpuh.js) against the CPU prover
// (tools/perfect/wholepar.js) on toy rooms: the same optimum (replayed by eesim.js at that many run ticks), the same "no
// route <= C" one tick below it, the ladder from the start's bound to the same optimum; the GPU's h = gpuh.js's JS h at
// every tick of the found route (eegpu exacth, GPU and its CPU copy), and never above the ticks left.
//   node test/gpuproof.js [--tool=<eegpu>] [--cachedir=<dir>] [--only=plain,gated,..] [--keep=<dir>]
// Needs an NVIDIA GPU and the Linux / Windows build with the exact kernels (tools/gpuproof/build-linux.sh). Never run it
// on the user's laptop (its GPU is the user's).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const G = require('../src/gpu.js');
const GH = require('../tools/perfect/gpuh.js');
const XG = require('../tools/gpuproof/exact.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
// # wall, S spawn, G trophy, k red key, d red door, 1 purple switch 1, e purple door 1, o coin, c a 1-coin door,
// C checkpoint, x spike, P / Q a portal pair
const ID = { '#': [9], S: [255], G: [121], k: [6], d: [23], 1: [113, 1], e: [184, 1], o: [100], c: [43, 1], C: [360], x: [361, 1], P: [242, 0, 1, 2], Q: [242, 0, 2, 1] };
const ROOMS = {
	plain: ['############', '#..........#', '#..........#', '#S.....G...#', '############'],
	gated: ['##############', '#.....#......#', '#.....d......#', '#S.k..d..G...#', '##############'],
	ledge: ['############', '#......G...#', '#.....###..#', '#S.........#', '############'],
	switch: ['##############', '#.....#......#', '#.....e......#', '#S..1.e..G...#', '##############'],
	coindoor: ['#############', '#......#....#', '#......c....#', '#S...o.c.G..#', '#############'],
	spikes: ['##############', '#............#', '#S.C...xx..G.#', '##############'],
	portal: ['#############', '#....#......#', '#S..P#..Q.G.#', '#############'],
};
const only = args.only ? new Set(args.only.split(',')) : null;
const dir = args.keep ? path.resolve(args.keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'gpuproof-'));
fs.mkdirSync(dir, { recursive: true });
const tool = args.tool || G.nativeTool();
const extra = {};
if (args.cachedir) extra.cachedir = args.cachedir;
const quiet = () => {};
const WPAR = path.join(__dirname, '..', 'tools', 'perfect', 'wholepar.js');

(async () => {
	for (const [name, rows] of Object.entries(ROOMS)) {
		if (only && !only.has(name)) continue;
		const cells = [];
		rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
		const buf = ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells });
		const file = path.join(dir, name + '.eelvl');
		fs.writeFileSync(file, buf);
		const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
		// the CPU prover: its optimum (no route given: the first finish of its contours)
		const cpuOut = cp.execFileSync(process.execPath, [WPAR, file, '--threads=2', '--seconds=120', '--split=2', '--shared=1', '--ttBits=18'], { encoding: 'utf8', timeout: 300000 });
		const cpu = cpuOut.trim().split('\n').map((l) => JSON.parse(l)).find((o) => o.ev === 'result');
		const opt = cpu && cpu.verdict === 'PROVEN' ? cpu.opt : null;
		check(`${name} the CPU prover's optimum`, opt !== null && opt >= 0, `${cpu ? cpu.verdict : '-'} ${opt}`);
		if (opt === null) continue;
		const work = path.join(dir, name);
		// the GPU at C = opt: the same optimum, replayed at that many run ticks
		const outF = path.join(dir, `${name}_gpu.eetas`);
		const r1 = await XG.run(file, Object.assign({ C: String(opt), tool, work, out: outF, seconds: '120', htBits: '22' }, extra), quiet);
		check(`${name} GPU C=${opt}: the same optimum`, r1.verdict === 'FOUND' && r1.opt === opt && r1.replay && r1.replay.runTicks === opt, `${r1.verdict} ${r1.opt} replay ${r1.replay ? r1.replay.runTicks : '-'}`);
		// one tick below: no route (the CPU's closed contour C = opt: every route >= opt)
		if (opt > 0) {
			const r2 = await XG.run(file, Object.assign({ C: String(opt - 1), tool, work, seconds: '120', htBits: '22' }, extra), quiet);
			check(`${name} GPU C=${opt - 1}: no route (as the CPU's closed contour)`, r2.verdict === 'NONE' && r2.lb >= opt, `${r2.verdict} lb ${r2.lb}`);
		}
		// the depth-first stage (a small arena: the frontier stops fitting after a few layers)
		const r4 = await XG.run(file, Object.assign({ C: String(opt + 3), tool, work, seconds: '120', htBits: '22', arena: '3000' }, extra), quiet);
		check(`${name} GPU depth-first stage, C=${opt + 3}: the same optimum`, r4.verdict === 'FOUND' && r4.opt === opt && r4.replay && r4.replay.runTicks === opt,
			`${r4.verdict} ${r4.opt}, ${r4.Cs ? r4.Cs.map((c) => c.Cl + ':' + c.status + ':' + c.stage).join(' ') : '-'}`);
		if (opt > 0) {
			const r5 = await XG.run(file, Object.assign({ C: String(opt - 1), tool, work, seconds: '120', htBits: '22', arena: '400' }, extra), quiet);
			check(`${name} GPU depth-first stage, C=${opt - 1}: no route (closed by the depth-first stage)`, r5.verdict === 'NONE' && r5.lb >= opt && r5.Cs.some((c) => c.stage === 'dfs' && c.status === 'closed'), `${r5.verdict} lb ${r5.lb} ${r5.Cs ? r5.Cs.map((c) => c.Cl + ':' + c.status + ':' + c.stage).join(' ') : '-'}`);
		}
		// the ladder from the start's bound
		const r3 = await XG.run(file, Object.assign({ C: String(opt + 6), ladder: '1', tool, work, seconds: '120', htBits: '22' }, extra), quiet);
		check(`${name} GPU ladder to C=${opt + 6}: the optimum`, r3.verdict === 'FOUND' && r3.opt === opt, `${r3.verdict} ${r3.opt}, contours ${r3.Cs ? r3.Cs.map((c) => c.Cl + ':' + c.status).join(' ') : '-'}`);
		// the GPU's h = the JS h along the found route, never above the ticks left (the door states of the route known)
		if (fs.existsSync(outF)) {
			const ms = C.readEetas(outF);
			const tb = GH.createTables(L, {});
			const sigs = GH.sigsAlong(L, tb, ms);
			const hF = path.join(work, 'hroute.bin');
			tb.write(hF, Array.from(sigs));
			const LIM = 40;
			const ctx = require('../tools/perfect/wholepar.js').makeCtx(L, new Set(['kin', 'rel', 'gate']));
			const sim = new E.EESim(L), inp = new E.EEInput();
			sim.reset();
			const js = [tb.hOf(sim, { lim: LIM })], cpuH = [ctx.h(sim, LIM)];
			for (let t = 0; t < ms.length; t++) {
				E.applyMask(inp, ms[t]); sim.tick(inp);
				js.push(tb.hOf(sim, { lim: LIM })); cpuH.push(ctx.h(sim, LIM));
				if (sim.has_silver_crown) break;
			}
			const dj = js.findIndex((v, i) => v !== cpuH[i]);
			check(`${name} gpuh.js's h = the CPU prover's h (makeCtx kin,rel,gate) at every tick`, dj < 0, dj >= 0 ? `tick ${dj}: ${js[dj]} vs ${cpuH[dj]}` : `${js.length} ticks`);
			for (const mode of ['gpu', 'cpu']) {
				const a = ['exacth', path.join(work, 'level.bin'), outF, `--h=${hF}`, `--lim=${LIM}`];
				if (mode === 'cpu') a.push('--cpu=1');
				if (args.cachedir) a.push(`--cachedir=${args.cachedir}`);
				const o = JSON.parse(cp.execFileSync(tool, a, { encoding: 'utf8' }).trim().split('\n').pop());
				const jsv = js.map((v) => (v === Infinity ? -1 : v));
				const diff = o.h ? o.h.findIndex((v, i) => v !== jsv[i]) : 0;
				check(`${name} eegpu exacth (${mode}) = gpuh.js's h at every tick`, !!o.h && o.h.length === jsv.length && diff < 0, diff >= 0 ? `tick ${diff}: ${o.h[diff]} vs ${jsv[diff]}` : `${jsv.length} ticks`);
			}
			const ck = require('../tools/perfect/wholeproof.js').checkRoute(L, ms, { h: (s) => tb.hOf(s) });
			check(`${name} h <= the ticks left along the route`, ck.ok, `${ck.checked} ticks, min slack ${ck.minSlack}`);
		}
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();

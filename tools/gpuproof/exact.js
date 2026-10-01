'use strict';
// THE EXACT SEARCH ON THE GPU, driven from Node (box 8 lane 'gpuproof', 2026-10-01): `eegpu exact` (native/exact.h,
// native/exacthost.h) with the bound tables of tools/perfect/gpuh.js, its order-tier fields grown while it runs (the door
// states it meets that the tables lack: `--hpipe=1`, the {"ev":"sigs"} lines answered with an EEHA file), the routes
// given checked first (h <= the ticks left at every tick, else no claim), its route replayed by eesim.js (C.evaluate).
//   node tools/gpuproof/exact.js <level.eelvl> --C=<run ticks> [--ladder=1] [--route=<a.eetas>,..] [--U=<run ticks>]
//        [--tool=<eegpu>] [--seconds=600] [--tiers=kin,rel,gate] [--work=<dir>] [--out=<found.eetas>] [--check=1]
//        [--htBits=28] [--arena=] [--stage=] [--hostGB=] [--deaths=1] [--cachedir=] [--launch-ms=200] [--from=]
// --C: the run-tick limit (the exact minimum when <= C, else a proof that no route takes <= C); --U instead of --C: C =
// U - 1 (U = the best known route's run ticks: none below it = U is tick-perfect). Prints JSON lines (eegpu's own, then
// {"ev":"result", verdict FOUND | NONE | UNREACHABLE | OPEN | violation | unsupported, opt, lb, replay, ...}).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const T = require('../../src/plan/types.js');
const G = require('../../src/gpu.js');
const C = require('../../src/common.js');
const GH = require('../perfect/gpuh.js');
const WP = require('../perfect/wholeproof.js');

function run(file, args, say) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const L = T.loadLevelFile(file);
		const out = { ev: 'result', level: path.basename(file), verdict: 'OPEN' };
		const why = G.unsupported(L);
		if (why) { Object.assign(out, { verdict: 'unsupported', why }); return resolve(out); }
		const work = path.resolve(args.work || fs.mkdtempSync(path.join(os.tmpdir(), 'gpuproof-')));
		fs.mkdirSync(work, { recursive: true });
		const blobFile = path.join(work, 'level.bin');
		fs.writeFileSync(blobFile, G.levelBlob(L));
		const tiers = (args.tiers || 'kin,rel,gate').split(',').filter(Boolean);
		const tb = GH.createTables(L, { tiers });
		const sigs = new Set(GH.sigsAlong(L, tb, new Uint8Array(0)));
		// the routes given: their door states into the tables, their run ticks (U), h checked along each
		let U = Infinity;
		for (const f of (args.route || '').split(',').filter(Boolean)) {
			const ms = C.readEetas(f);
			const ev = C.evaluate(L, ms, false);
			if (!ev) { say({ ev: 'check', route: path.basename(f), ok: false, why: 'does not finish' }); continue; }
			if (ev.runTicks < U) U = ev.runTicks;
			for (const k of GH.sigsAlong(L, tb, ev.ms)) sigs.add(k);
			if (args.check !== '0') {
				const ck = WP.checkRoute(L, ev.ms, { h: (s) => tb.hOf(s) });
				say(Object.assign({ ev: 'check', route: path.basename(f), runTicks: ev.runTicks }, ck));
				if (!ck.ok) { Object.assign(out, { verdict: 'violation', why: 'the bound is above the ticks left on a real route: no claim' }); return resolve(out); }
			}
		}
		if (+args.U > 0 && +args.U < U) U = +args.U;
		let Crun = args.C !== undefined ? +args.C : (Number.isFinite(U) ? U - 1 : -1);
		if (!(Crun >= 0)) { Object.assign(out, { verdict: 'error', why: '--C=<run ticks> or a route / --U is needed' }); return resolve(out); }
		const hFile = path.join(work, 'h.bin');
		const nSig = tb.write(hFile, Array.from(sigs));
		say({ ev: 'tables', ms: Date.now() - t0, doorStates: nSig, info: tb.info, C: Crun, U: Number.isFinite(U) ? U : null });
		const tool = args.tool || G.nativeTool();
		if (!tool) { Object.assign(out, { verdict: 'error', why: 'no eegpu (tools/gpuproof/build-linux.sh)' }); return resolve(out); }
		const pass = ['seconds', 'htBits', 'arena', 'stage', 'hostGB', 'deaths', 'cachedir', 'launch-ms', 'from', 'ladder', 'progress', 'ptxdir', 'spill', 'dfs', 'dfsThreads', 'ttMinLim', 'table2', 'dfsAt'];
		const eargs = ['exact', blobFile, `--h=${hFile}`, `--C=${Crun}`, '--hpipe=1'];
		for (const k of pass) if (args[k] !== undefined) eargs.push(`--${k}=${args[k]}`);
		if (args['launch-ms'] === undefined) eargs.push('--launch-ms=200');
		// (deaths as moves where the level can kill: wholepar.js drops a dead child where levelproof.js says none can die)
		if (args.deaths === undefined && !tb.canDie) eargs.push('--deaths=0');
		const ch = cp.spawn(tool, eargs, { stdio: ['pipe', 'pipe', 'inherit'] });
		let buf = '', found = null, done = null, nAdd = 0, addMs = 0;
		const Cs = [];
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k); buf = buf.slice(k + 1);
				let o = null;
				try { o = JSON.parse(line); } catch (e) { say({ ev: 'raw', line }); continue; }
				if (o.ev === 'sigs') {
					const ta = Date.now();
					const f = path.join(work, `add_${++nAdd}.bin`);
					const n = tb.writeAdd(f, o.sigs);
					addMs += Date.now() - ta;
					say(Object.assign({}, o, { sigs: undefined, added: n, ms: Date.now() - ta }));
					ch.stdin.write(`add ${f}\ngo\n`);
					continue;
				}
				if (o.ev === 'found') found = o;
				if (o.ev === 'C') Cs.push(o);
				if (o.ev === 'done') done = o;
				say(o);
			}
		});
		ch.on('close', (code) => {
			Object.assign(out, { code, C: Crun, U: Number.isFinite(U) ? U : null, addFiles: nAdd, addMs, Cs: Cs.map((c) => ({ Cl: c.Cl, status: c.status, stage: c.stage, D: c.D, nodes: c.nodes, states: c.states, seconds: c.seconds, nodesPerSec: c.nodesPerSec })) });
			if (done) Object.assign(out, { verdict: done.verdict, opt: done.opt >= 0 ? done.opt : null, best: done.best >= 0 ? done.best : null, lb: done.lb, nodes: done.nodes, nodesPerSec: done.nodesPerSec, gpuSeconds: done.seconds });
			// (the best route: the done line's, the last found one's otherwise)
			const inputs = done && done.inputs ? done.inputs : found ? found.inputs : null;
			const want = done && done.best >= 0 ? done.best : found ? found.opt : null;
			if (inputs) {
				const ms = Uint8Array.from(inputs, (c) => (c.charCodeAt(0) - 48) & 31);
				const ev = C.evaluate(L, ms, false);
				out.replay = ev ? { runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance } : null;
				out.inputs = inputs;
				if (!ev || ev.runTicks !== want) out.verdict = 'replay-failed';
				else if (args.out) { C.writeEetas(path.resolve(args.out), ev.ms); out.written = args.out; }
				if (ev && Number.isFinite(U) && ev.runTicks < U) out.faster = true;
			}
			if (out.verdict === 'NONE' && Number.isFinite(U) && Crun >= U - 1) out.proven = `no route takes fewer than ${U} run ticks: the route of ${U} is tick-perfect`;
			out.seconds = (Date.now() - t0) / 1000;
			resolve(out);
		});
	});
}

if (require.main === module) {
	const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
	const file = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
	const say = (o) => console.log(JSON.stringify(o));
	run(file, args, say).then((r) => { say(r); process.exit(0); }).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
module.exports = { run };

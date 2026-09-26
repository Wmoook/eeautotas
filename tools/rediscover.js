'use strict';
// The rediscovery benchmark: finds that were made once, replayed from a run from BEFORE the find, by the tool that is
// meant to aim at them. Each case names the generator, why that spot is targeted, the saving it must reach and how long
// it took (seconds and simulated ticks). It shows that a find is made on purpose, not by luck, and catches a change that
// loses one. Cases whose job or run is missing on this machine are skipped (the jobs are the user's own files).
//
// node tools/rediscover.js [--only=loop,endgame,...] [--workers=4] [--json]
// Cases (CPU only):
//   loop     Octorage (OC): from best_6329, the run's longest loop (src/loops.js), explored on exactly that window
//            (explore.js --exact) -> the ~-350 route skip
//   endgame  213 (OC's run, 2.36): the exact endgame solver (src/endgame.js) -> 2.35
//   phase    Stupid Fox (OC's original, time doors): src/phase.js (clock-blind proposals, replayed) -> 7089 or better
//   hunt     Forgotten Veil best_11257, ticks 5760-5830: explore --hunt=1 (time-to-go field) -> -15
//   skips    Forgotten Veil best_11257, the whole run: src/skips.js (contact pass-by windows, entrances, routes from
//            them), then mutate on the rewritten stretch -> the 88-tick "mini 10" skip (11169) or better
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const C = require(path.join(SRC, 'common.js'));
const J = require(path.join(SRC, 'jobs.js'));
const LP = require(path.join(SRC, 'loops.js'));

const args = C.parseArgs(process.argv.slice(2));
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const W = Math.max(1, +(args.workers || 4));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rediscover-'));

/** runs a tool; resolves {out, seconds, ticks} (ticks: the last `[ticks] N` line) */
function run(script, argv, maxS) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const ch = spawn(process.execPath, [path.join(SRC, script), ...argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: C.heapEnv(8000) });
		let out = '', ticks = 0;
		ch.stdout.on('data', (d) => { out += d; const m = String(d).match(/\[ticks\] (\d+)/g); if (m) ticks = +m[m.length - 1].slice(8); });
		ch.stderr.on('data', (d) => { out += d; });
		const kill = setTimeout(() => { try { ch.kill(); } catch (e) { /* gone */ } }, maxS * 1000);
		ch.on('close', () => { clearTimeout(kill); resolve({ out, seconds: (Date.now() - t0) / 1000, ticks }); });
	});
}
const jobRun = (job, file) => { const f = path.join(J.jobDir(job), file); return fs.existsSync(f) ? f : null; };

const CASES = [
	{
		key: 'loop', name: 'Octorage (OC): the maze-loop route skip', generator: 'loop windows (loops.js + explore --exact)', want: 5979,
		async go() {
			const job = 'octorage-oc-08e189', ref = jobRun(job, 'best_6329.eetas');
			if (!ref) return null;
			const level = J.loadJobLevel(job), ms = C.readEetas(ref);
			const st = C.readJSON(path.join(J.jobDir(job), 'status.json'), {});
			const l = LP.revisits(level, ms, { coins: !st.coinsOptional, max: 1500 })[0];
			const why = `loop #1: the run comes back to (${l.x}, ${l.y}) ${l.len} ticks later (ticks ${l.a}-${l.b})`;
			const out = path.join(TMP, 'loop.eetas');
			const r = await run('explore.js', [`--tas=${ref}`, `--level=${job}`, `--from=${Math.max(0, l.a - 40)}`, `--join=${Math.max(0, l.a - 40)}`, `--until=${l.b + 40}`,
				'--seconds=150', `--workers=${W}`, '--exact=1', '--roll=100', '--seed=301', `--nocoins=${st.coinsOptional ? 1 : 0}`, '--maxEntries=1500000', `--out=${out}`], 240);
			const ev = fs.existsSync(out) ? C.evaluate(level, C.readEetas(out)) : null;
			return { why, from: 6329, got: ev ? ev.runTicks : null, r };
		},
	},
	{
		key: 'endgame', name: '213 (OC): a knife-edge finish', generator: 'exact endgame solver (endgame.js)', want: 235,
		async go() {
			const job = '213-remake-oc-5d5679', ref = jobRun(job, 'original.eetas');
			if (!ref) return null;
			const tas = path.join(TMP, 'eg_ref.eetas');
			fs.copyFileSync(ref, tas);
			const out = path.join(TMP, 'endgame.eetas');
			const r = await run('endgame.js', [`--tas=${tas}`, `--level=${job}`, '--others=0', '--seconds=120', `--out=${out}`], 200);
			const ev = fs.existsSync(out) ? C.evaluate(J.loadJobLevel(job), C.readEetas(out)) : null;
			return { why: 'every input sequence over the last K ticks (K = 8, 16, ...), a sound lower bound prunes', from: 236, got: ev ? ev.runTicks : null, r };
		},
	},
	{
		key: 'phase', name: 'Stupid Fox (OC): shortcuts behind time doors', generator: 'time-door pass (phase.js)', want: 7089,
		async go() {
			const job = 'stupid-fox-oc-a93a88', ref = jobRun(job, 'original.eetas');
			if (!ref) return null;
			const tas = path.join(TMP, 'ph_ref.eetas');
			fs.copyFileSync(ref, tas);
			const out = path.join(TMP, 'phase.eetas');
			const r = await run('phase.js', [`--tas=${tas}`, `--level=${job}`, '--seconds=60', `--out=${out}`], 180);
			const ev = fs.existsSync(out) ? C.evaluate(J.loadJobLevel(job), C.readEetas(out)) : null;
			return { why: 'time doors put the clock in every state: exact rejoins are blind there; clock-blind proposals, replayed', from: 7098, got: ev ? ev.runTicks : null, r };
		},
	},
	{
		key: 'hunt', name: 'Forgotten Veil: a skip the plain explorer misses', generator: 'guided skip hunting (explore --hunt)', want: 11242,
		async go() {
			const job = 'forgotten-veil-1-52-57-18f3bd', ref = jobRun(job, 'best_11257.eetas');
			if (!ref) return null;
			const st = C.readJSON(path.join(J.jobDir(job), 'status.json'), {});
			const out = path.join(TMP, 'hunt.eetas');
			const r = await run('explore.js', [`--tas=${ref}`, `--level=${job}`, '--from=5760', '--join=5760', '--until=5830', '--hunt=1', '--workers=1', '--seed=1',
				'--ticks=6000000', '--seconds=120', `--nocoins=${st.coinsOptional ? 1 : 0}`, `--out=${out}`], 200);
			const ev = fs.existsSync(out) ? C.evaluate(J.loadJobLevel(job), C.readEetas(out)) : null;
			return { why: 'states ahead of the run by a time-to-go field (the run\'s positions as goals), then its own inputs from there', from: 11257, got: ev ? ev.runTicks : null, r };
		},
	},
	{
		key: 'skips', name: 'Forgotten Veil: the 88-tick "mini 10" skip', generator: 'skip search through entrances (skips.js) + mutate on the new stretch', want: 11169,
		async go() {
			const job = 'forgotten-veil-1-52-57-18f3bd', ref = jobRun(job, 'best_11257.eetas');
			if (!ref) return null;
			const st = C.readJSON(path.join(J.jobDir(job), 'status.json'), {});
			const out = path.join(TMP, 'skips.eetas'), pol = path.join(TMP, 'skips_mut.eetas');
			const r = await run('skips.js', [`--tas=${ref}`, `--level=${job}`, `--workers=${W}`, '--seconds=240', `--nocoins=${st.coinsOptional ? 1 : 0}`, `--out=${out}`], 300);
			const level = J.loadJobLevel(job);
			const ev1 = fs.existsSync(out) ? C.evaluate(level, C.readEetas(out)) : null;
			let ev = ev1;
			if (ev1) {
				// the stretch the skip rewrote, polished like the grind's next mutate stage does
				const used = (C.readJSON(out + '.edges.json', { edges: [] }).edges || []).map((e) => e[0]);
				const f = Math.max(0, Math.min(...used) - 60), t = f + 500;
				const r2 = await run('mutate.js', [`--tas=${out}`, `--level=${job}`, `--from=${f}`, `--to=${t}`, `--workers=${W}`, `--nocoins=${st.coinsOptional ? 1 : 0}`,
					'--dprune=1', '--anchor=1', '--fixpoint=1', '--pairs=1', `--out=${pol}`, `--deadline=${Date.now() + 120e3}`], 200);
				r.seconds += r2.seconds; r.ticks += r2.ticks;
				const ev2 = fs.existsSync(pol) ? C.evaluate(level, C.readEetas(pol)) : null;
				if (ev2 && ev2.runTicks < ev1.runTicks) ev = ev2;
			}
			return { why: `the run passes a ledge it lands on 136 ticks later (contact pass-by); ${ev1 ? `skips.js alone ${ev1.runTicks}` : 'skips.js found nothing'}`, from: 11257, got: ev ? ev.runTicks : null, r };
		},
	},
];

(async () => {
	const rows = [];
	for (const c of CASES) {
		if (ONLY && !ONLY.has(c.key)) continue;
		process.stderr.write(`[rediscover] ${c.key}: ${c.name}...\n`);
		let res = null;
		try { res = await c.go(); } catch (e) { res = { error: String(e && e.message || e) }; }
		if (!res) { rows.push({ key: c.key, name: c.name, skipped: 'its job or run is not on this machine' }); continue; }
		const ok = res.got !== null && res.got !== undefined && res.got <= c.want;
		rows.push({ key: c.key, name: c.name, generator: c.generator, why: res.why, from: res.from, want: c.want, got: res.got, ok, error: res.error,
			seconds: res.r ? +res.r.seconds.toFixed(1) : null, ticks: res.r ? res.r.ticks : null });
	}
	fs.rmSync(TMP, { recursive: true, force: true });
	if (args.json) { console.log(JSON.stringify(rows, null, 1)); return; }
	for (const r of rows) {
		if (r.skipped) { console.log(`skip ${r.key}: ${r.skipped}`); continue; }
		console.log(`${r.ok ? 'ok  ' : 'MISS'} ${r.key}: ${r.name}: ${r.from} -> ${r.got === null ? 'nothing' : r.got} (want <= ${r.want}) in ${r.seconds} s, ` +
			`${r.ticks ? (r.ticks / 1e6).toFixed(1) + ' M ticks' : '?'}; ${r.generator}; targeted: ${r.why}${r.error ? `; error ${r.error}` : ''}`);
	}
	process.exitCode = rows.some((r) => r.ok === false) ? 1 : 0;
})();

'use strict';
// The gate benchmark: Find a route's operators scored in minutes instead of 25-minute runs from scratch. For every big
// level's known route (the job's best run) it lists every room change made BY A TRIGGER (src/goexplore.js roomOf: a key,
// switch, effect, coin where a door reads it, ...; the clock's changes, a time door flipping or a key running out, are no
// gate) with the route's exact state where it entered the room before; each gate runs the one search (goexplore.js
// --prefix: the CPU random runs, with --bursts=1 the GPU bursts too) from that state with a small fixed budget and passes
// when a room of the route's next room is found (the same room without its keys and time doors, with at least the route's
// keys: goexplore.js --rooms=1 prints every room found); the last gate of a level is its trophy (a route found). Scores:
// gates passed / total, the time and simulated ticks per pass, per level, and the hard gates' pass rate (hard: a gate the
// baseline failed or passed after half the budget or more; --baseline=<an earlier --json>). Deterministic: the CPU arm with
// a tick budget (--ticks, per gate and seed; one worker, fixed seeds) gives the same verdicts on every machine and load.
//
// node tools/gatebench.js build [--jobs=<the jobs folder>] [--data=<folder>]        the gates from the jobs' best runs
// node tools/gatebench.js run [--code=<checkout>] [--data=<folder>] [--levels=fv,oct,ge,sf,ip] [--ticks=20000000 | --seconds=S]
//        [--seeds=1] [--par=8] [--bursts=0] [--tool=<eegpu>] [--steer=1] [--gates=a..b] [--json=<file>] [--baseline=<file>]
//        [--label=<name>] [--mem=400] [--only=fv#3,ip#44] [--hardOnly=1 (with --baseline: its hard gates alone)] [--gx="<more goexplore options>"]
// --code: the checkout whose src/goexplore.js runs (a variant's worktree); it must have --prefix and --rooms (this commit).
// --remote="root@host -p N -i key" [--dir=/dev/shm/gb_<label>] [--clean=1]: the checkout's src/ (without out, jobs, data,
// bin), this tool and the gates go up to --dir (a gzipped tar over the Windows OpenSSH client), the run happens there
// (its node: ~/.local/node/bin/node when there), its JSON comes back to --json (default <data>/results/<label>.json);
// --clean=1 removes --dir after. With --bursts=1 there, --tool / --cachedir are the remote's paths. The steer fields' temp files
// go to --dir there (TMPDIR: Forgotten Veil's is 565 MB; the default /tmp filled the A100's 16 GB disk), --baseline goes up too.
// --data (default src/out/gatebench under the checkout this file is in, git-ignored: the levels and routes are the
// user's own files, never in git): levels/<alias>.json, prefix/<alias>_<k>.eetas, gates.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

// the big levels: alias -> the job whose best run is the known route (the first job of the list that exists)
const LEVELS = {
	fv: ['forgotten-veil-d30867', 'forgotten-veil-1-52-57-18f3bd'],
	oct: ['octorage-oc-08e189'],
	ge: ['good-egg-galaxy-oc-0efb40'],
	sf: ['stupid-fox-oc-a93a88', 'stupid-fox-lictor-da5517'],
	ip: ['infinity-pain-kiraninja-pwe7zf-v-b42e94', 'infinity-pain-kiraninja-pwe7zf-v-38843e'],
	ice: ['ice-level-oc-850ef2'],
};

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'run';
const opt = {};
for (const s of argv) { const m = /^--([^=]+)=(.*)$/.exec(s); if (m) opt[m[1]] = m[2]; else if (s.startsWith('--')) opt[s.slice(2)] = '1'; }
const DATA = path.resolve(opt.data || path.join(ROOT, 'src', 'out', 'gatebench'));

function build() {
	const C = require(path.join(ROOT, 'src', 'common.js'));
	const J = require(path.join(ROOT, 'src', 'jobs.js'));
	const GX = require(path.join(ROOT, 'src', 'goexplore.js'));
	const E = C.E;
	const jobsDir = opt.jobs ? path.resolve(opt.jobs) : J.JOBS;
	fs.mkdirSync(path.join(DATA, 'levels'), { recursive: true });
	fs.mkdirSync(path.join(DATA, 'prefix'), { recursive: true });
	const out = { built: new Date().toISOString(), levels: {} };
	for (const [alias, ids] of Object.entries(LEVELS)) {
		const id = ids.find((x) => fs.existsSync(path.join(jobsDir, x, 'best.eetas')));
		if (!id) { console.log(`${alias}: no job on this machine (${ids.join(', ')})`); continue; }
		const lj = J.levelJsonOf(id);
		const levelFile = path.join(DATA, 'levels', `${alias}.json`);
		fs.copyFileSync(lj, levelFile);
		const L = E.loadLevel(levelFile);
		const best = C.readEetas(path.join(jobsDir, id, 'best.eetas'));
		const RM = GX.roomOf(L);
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let key = RM.key(sim), cz = RM.cause(sim), from = 0, fromDesc = RM.desc(sim);
		const gates = [];
		const tileOf = () => [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4];
		let fromTile = tileOf(), finish = -1;
		for (let t = 0; t < best.length; t++) {
			E.applyMask(inp, best[t]);
			sim.tick(inp);
			if (sim.has_silver_crown) { finish = t + 1; break; }
			const k2 = RM.key(sim);
			if (k2 === key) continue;
			const cz2 = RM.cause(sim), trig = RM.byTrigger(cz, cz2);
			key = k2; cz = cz2;
			if (!trig) continue;
			gates.push({ k: gates.length, from, fromDesc, fromTile, to: t + 1, toDesc: RM.desc(sim), toTile: tileOf(), sub: cz2.sub, keys: cz2.keys, gap: t + 1 - from });
			from = t + 1; fromDesc = RM.desc(sim); fromTile = tileOf();
		}
		if (finish < 0) { const ev = C.evaluate(L, best); finish = ev && ev.complete >= 0 ? ev.complete + 1 : best.length; }
		gates.push({ k: gates.length, from, fromDesc, fromTile, to: finish, toDesc: 'the trophy', toTile: null, finish: true, gap: finish - from });
		for (const g of gates) C.writeEetas(path.join(DATA, 'prefix', `${alias}_${g.k}.eetas`), best.subarray(0, g.from));
		out.levels[alias] = { job: id, ticks: best.length, finish, level: `levels/${alias}.json`, gates };
		console.log(`${alias}: ${id}, route ${best.length} ticks, ${gates.length} gates (${gates.length - 1} trigger room changes + the trophy); the longest: ` +
			gates.slice().sort((x, y) => y.gap - x.gap).slice(0, 3).map((g) => `#${g.k} ${g.gap} ticks (${g.fromDesc} -> ${g.toDesc})`).join(', '));
	}
	fs.writeFileSync(path.join(DATA, 'gates.json'), JSON.stringify(out, null, 1));
	console.log(`-> ${path.join(DATA, 'gates.json')}`);
}

/** one gate x seed: {pass, sec, simTicks, rooms, end} */
function runGate(code, lv, g, seed, alias) {
	return new Promise((res) => {
		const gx = path.join(code, 'src', 'goexplore.js');
		const args = [gx, path.join(DATA, lv.level), `--prefix=${path.join(DATA, 'prefix', `${alias}_${g.k}.eetas`)}`, '--workers=1', `--seed=${seed}`, '--rooms=1', '--stdin=1',
			'--cells=coarse', `--mem=${opt.mem || 400}`];
		if (opt.seconds) args.push(`--seconds=${+opt.seconds}`);
		else args.push(`--maxTicks=${+(opt.ticks || 20e6)}`, '--seconds=3600');
		if (lv.steerFile) args.push(`--steer=${lv.steerFile}`);
		let work = null;
		if (opt.bursts === '1') {
			work = fs.mkdtempSync(path.join(os.tmpdir(), 'gatebench-'));
			args.push('--bursts=1', `--tool=${opt.tool}`, `--work=${work}`, ...(opt.cachedir ? [`--cachedir=${opt.cachedir}`] : []), ...(opt.burstArgs ? opt.burstArgs.split(' ') : []));
		}
		if (opt.gx) args.push(...opt.gx.split(' ').filter(Boolean));
		const p = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		const t0 = Date.now();
		let buf = '', done = false, rooms = 0, simTicks = 0, lastTicks = 0;
		const r = { pass: false, sec: null, simTicks: null, rooms: 0, end: null, by: null };
		const finish = (why) => {
			if (done) return;
			done = true;
			r.end = why;
			try { p.stdin.write('stop\n'); } catch (e) { /* gone */ }
		};
		p.stdout.on('data', (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (line[0] !== '{') continue;
				let e;
				try { e = JSON.parse(line); } catch (x) { continue; }
				if (e.ev === 'progress') lastTicks = e.ticks;
				else if (e.ev === 'room') {
					rooms++;
					if (!done && !g.finish && e.sub === g.sub && ((g.keys & ~(e.keys | 0)) === 0)) { r.pass = true; r.sec = e.sec; r.simTicks = e.wt !== undefined ? e.wt : lastTicks; r.by = e.by; finish('pass'); }
				} else if (e.ev === 'result' && g.finish && !done) { r.pass = true; r.sec = e.sec; r.simTicks = e.simTicks || lastTicks; r.by = e.by || 'cpu'; finish('pass'); }
				else if (e.ev === 'done') { simTicks = e.ticks; if (!done) finish(e.end); }
				else if (e.error) { r.error = e.error; }
			}
		});
		p.stderr.on('data', () => {});
		p.on('exit', () => {
			if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* gone */ } }
			r.rooms = rooms; r.wall = (Date.now() - t0) / 1000; r.ticks = simTicks || lastTicks; res(r); });
	});
}

async function run() {
	const code = path.resolve(opt.code || ROOT);
	const G = JSON.parse(fs.readFileSync(path.join(DATA, 'gates.json'), 'utf8'));
	const want = (opt.levels || 'fv,oct,ge,sf,ip').split(',').filter((x) => G.levels[x]);
	const seeds = Array.from({ length: +(opt.seeds || 1) }, (_, i) => 1 + i);
	const par = Math.max(1, +(opt.par || Math.min(8, os.cpus().length)));
	const [ga, gb] = opt.gates ? opt.gates.split('..').map(Number) : [0, Infinity];
	if (opt.steer !== '0') {
		// (the steer field, built once per level with the variant's code: src/steer.js)
		const C = require(path.join(code, 'src', 'common.js')), SF = require(path.join(code, 'src', 'steer.js'));
		for (const al of want) {
			const f = path.join(os.tmpdir(), `gatebench-steer-${al}-${process.pid}.rch4`);
			fs.writeFileSync(f, SF.steerFileBytes(SF.buildSteer(C.E.loadLevel(path.join(DATA, G.levels[al].level)))));
			G.levels[al].steerFile = f;
		}
	}
	// (--only=fv#3,ip#44,...: those gates; --hardOnly=1 with --baseline: the baseline's hard gates alone)
	let only = opt.only ? new Set(opt.only.split(',')) : null;
	if (opt.hardOnly === '1' && opt.baseline) {
		const b0 = JSON.parse(fs.readFileSync(opt.baseline, 'utf8'));
		only = new Set(b0.gates.filter((b) => !b.pass || (b0.budget.endsWith(' s') ? b.sec : b.simTicks) >= (b0.budget.endsWith(' s') ? parseFloat(b0.budget) : parseFloat(b0.budget) * 1e6) / 2).map((b) => `${b.level}#${b.gate}`));
	}
	const tasks = [];
	for (const al of want) for (const g of G.levels[al].gates) if (g.k >= ga && g.k <= gb && (!only || only.has(`${al}#${g.k}`))) for (const s of seeds) tasks.push({ al, g, s });
	// (the longest route gaps first: the slowest gates start early and the pool ends together)
	tasks.sort((x, y) => y.g.gap - x.g.gap);
	const budget = opt.seconds ? `${opt.seconds} s` : `${(+(opt.ticks || 20e6) / 1e6).toFixed(0)} M ticks`;
	console.log(`gatebench: ${code}, ${want.join(',')}, ${tasks.length} gate runs (${seeds.length} seed${seeds.length > 1 ? 's' : ''}), ${budget} each, ${par} at once${opt.bursts === '1' ? ', GPU bursts on' : ''}`);
	const t0 = Date.now();
	const results = [];
	let next = 0, nDone = 0;
	await Promise.all(Array.from({ length: par }, async () => {
		while (next < tasks.length) {
			const tk = tasks[next++];
			const r = await runGate(code, G.levels[tk.al], tk.g, tk.s, tk.al);
			results.push(Object.assign({ level: tk.al, gate: tk.g.k, seed: tk.s, gap: tk.g.gap }, r));
			nDone++;
			if (opt.verbose || nDone % 10 === 0) process.stderr.write(`  ${nDone}/${tasks.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
		}
	}));
	const base = opt.baseline ? JSON.parse(fs.readFileSync(opt.baseline, 'utf8')) : null;
	const cap = opt.seconds ? +opt.seconds : +(opt.ticks || 20e6);
	const hardSet = new Set();
	if (base) for (const b of base.gates) if (!b.pass || (opt.seconds ? b.sec : b.simTicks) >= cap / 2) hardSet.add(`${b.level}:${b.gate}:${b.seed}`);
	const sumOf = (rs) => {
		const p = rs.filter((x) => x.pass);
		const mean = (f) => (p.length ? p.reduce((s, x) => s + f(x), 0) / p.length : null);
		// (par2: the mean cost per gate run with a fail at twice the budget: lower is better)
		const par2 = rs.length ? rs.reduce((s, x) => s + (x.pass ? (opt.seconds ? x.sec : x.simTicks) : 2 * cap), 0) / rs.length : null;
		return { runs: rs.length, passed: p.length, rate: rs.length ? Math.round(p.length / rs.length * 1000) / 1000 : null, meanSec: mean((x) => x.sec), meanMTicks: mean((x) => x.simTicks / 1e6),
			par2: par2 === null ? null : opt.seconds ? Math.round(par2 * 10) / 10 : Math.round(par2 / 1e5) / 10 };
	};
	const perLevel = {};
	for (const al of want) perLevel[al] = sumOf(results.filter((x) => x.level === al));
	const all = sumOf(results);
	const hard = hardSet.size ? sumOf(results.filter((x) => hardSet.has(`${x.level}:${x.gate}:${x.seed}`))) : null;
	results.sort((x, y) => (x.level < y.level ? -1 : x.level > y.level ? 1 : x.gate - y.gate || x.seed - y.seed));
	const out = { label: opt.label || path.basename(code), code, budget, seeds: seeds.length, par, bursts: opt.bursts === '1', wallSec: Math.round((Date.now() - t0) / 1000), all, perLevel, hard,
		gates: results.map((r) => ({ level: r.level, gate: r.gate, seed: r.seed, gap: r.gap, pass: r.pass, sec: r.sec, simTicks: r.simTicks, rooms: r.rooms, by: r.by, end: r.end, error: r.error })) };
	const f1 = (v, d = 1) => (v === null || v === undefined ? '-' : v.toFixed(d));
	console.log(`\n| level | gates passed | rate | mean s / pass | mean M ticks / pass | par2 (${opt.seconds ? 's' : 'M ticks'}, lower better) |${base ? ' baseline passed | baseline par2 |' : ''}`);
	console.log(`|---|---|---|---|---|---|${base ? '---|---|' : ''}`);
	for (const al of [...want.filter((x) => perLevel[x].runs), 'ALL']) {
		const s = al === 'ALL' ? all : perLevel[al], b = base ? (al === 'ALL' ? base.all : base.perLevel[al]) : null;
		console.log(`| ${al} | ${s.passed}/${s.runs} | ${f1(s.rate, 3)} | ${f1(s.meanSec)} | ${f1(s.meanMTicks)} | ${f1(s.par2)} |${base ? ` ${b ? `${b.passed}/${b.runs}` : '-'} | ${b ? f1(b.par2) : '-'} |` : ''}`);
	}
	if (hard) console.log(`hard gates (the baseline failed them or needed half the budget or more): ${hard.passed}/${hard.runs} passed (baseline 0..half)`);
	if (base) {
		const bm = new Map(base.gates.map((b) => [`${b.level}:${b.gate}:${b.seed}`, b]));
		const diff = out.gates.filter((r) => { const b = bm.get(`${r.level}:${r.gate}:${r.seed}`); return b && b.pass !== r.pass; });
		if (diff.length) console.log(`changed verdicts: ${diff.map((r) => `${r.level}#${r.gate}${r.pass ? '+' : '-'}`).join(' ')}`);
	}
	console.log(`wall ${out.wallSec} s`);
	if (opt.json) { fs.writeFileSync(opt.json, JSON.stringify(out, null, 1)); console.log(`-> ${opt.json}`); }
	for (const al of want) if (G.levels[al].steerFile) { try { fs.unlinkSync(G.levels[al].steerFile); } catch (e) { /* gone */ } }
}

/** --remote: the same run on a rented machine (see the header) */
function remote() {
	const { spawnSync } = require('child_process');
	const code = path.resolve(opt.code || ROOT);
	const label = opt.label || path.basename(code);
	const ssh = process.platform === 'win32' ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh';
	const sshArgs = opt.remote.replace(/^ssh\s+/, '').split(/\s+/).filter(Boolean);
	const dir = opt.dir || `/dev/shm/gb_${label.replace(/[^\w.-]/g, '_')}`;
	const jsonOut = path.resolve(opt.json || path.join(DATA, 'results', `${label}.json`));
	fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
	const tar = (cwd, list, excl) => {
		const r = spawnSync('tar', ['czf', '-', ...excl.map((x) => `--exclude=${x}`), ...list], { cwd, maxBuffer: 1 << 30 });
		if (r.status !== 0) throw new Error(`tar failed in ${cwd}: ${r.stderr}`);
		return r.stdout;
	};
	const up = (buf, sub) => {
		const r = spawnSync(ssh, [...sshArgs, `mkdir -p ${dir}/${sub} && tar xzf - -C ${dir}/${sub}`], { input: buf, maxBuffer: 1 << 26 });
		if (r.status !== 0) throw new Error(`upload failed: ${r.error ? r.error.message : r.stderr}`);
	};
	up(tar(code, ['src', 'package.json'], ['src/out', 'src/jobs', 'src/data', 'src/bin']), 'code');
	up(tar(__dirname, [path.basename(__filename)], []), 'code/tools');
	up(tar(DATA, ['gates.json', 'levels', 'prefix'], []), 'data');
	// (--baseline: a local file, up as data/baseline.json)
	if (opt.baseline) up(tar(path.dirname(path.resolve(opt.baseline)), [path.basename(opt.baseline)], []), 'data/base');
	const keep = argv.filter((x) => !/^--(remote|dir|clean|json|code|data|baseline)=/.test(x));
	if (opt.baseline) keep.push(`--baseline=${dir}/data/base/${path.basename(opt.baseline)}`);
	if (!opt.label) keep.push(`--label=${label}`);
	const node = '$( [ -x ~/.local/node/bin/node ] && echo ~/.local/node/bin/node || echo node )';
	const cmdline = `cd ${dir} && TMPDIR=${dir} ${node} code/tools/${path.basename(__filename)} run --code=${dir}/code --data=${dir}/data --json=${dir}/out.json ${keep.map((x) => `'${x.replace(/'/g, '')}'`).join(' ')}`;
	const p = spawn(ssh, [...sshArgs, cmdline], { stdio: ['ignore', 'inherit', 'inherit'] });
	p.on('exit', (c) => {
		const r = spawnSync(ssh, [...sshArgs, `cat ${dir}/out.json`], { maxBuffer: 1 << 28 });
		if (r.status === 0 && r.stdout.length) { fs.writeFileSync(jsonOut, r.stdout); console.log(`-> ${jsonOut}`); }
		if (opt.clean === '1') spawnSync(ssh, [...sshArgs, `rm -rf ${dir}`]);
		process.exitCode = c;
	});
}

if (cmd === 'build') build();
else if (cmd === 'run' && opt.remote) remote();
else if (cmd === 'run') run().catch((e) => { console.error(e); process.exitCode = 1; });
else { console.log('usage: node tools/gatebench.js build | run [options] (see the header)'); process.exitCode = 2; }

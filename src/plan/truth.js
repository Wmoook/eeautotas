'use strict';
// THE TRUTH CHECKER (n4plan, part 'strategy'): every part's offline checks against the ground truth (src/plan/truthset.js:
// the benchmark levels, the known routes) in one command, and the end-to-end check of the compiler itself.
//   node src/plan/truth.js [--part=model|bounds|prims|exec|compile|all] [--limit=N] [--workers=N] [--seconds=60]
//       [--out=<dir>] [--sets=campaign,hard,d4] [--resume=1] [--parts=<module of mock parts: tests>] [--root=<truth root>]
//       [--shards=K (each part's test in K processes, --shard=i/K, the counts summed)] [--par=K (to the parts' tests)]
//       [--partMinutes=60]
//   parts (each a child process with --truth; a test file that is not there is 'absent'):
//     model   test/planmodel.js --truth, test/planplanner.js --truth   (T-MODEL-SOUND, T-PLAN-FEASIBLE, T-PLAN-ORDER, T-CEGAR-PROGRESS)
//     bounds  test/planbounds.js --truth                               (T-LB-ADMISSIBLE)
//     prims   test/planprims.js --truth                                (T-PRIM-EXACT, T-PRIM-COVER, T-PRIM-OPT)
//     exec    test/planexec.js --truth                                 (T-EXEC-LEGS, T-EXEC-EXACT, T-EXEC-FAIL, T-POLISH)
//     their 'ok' / 'FAIL' lines, 'N passed, M failed' (or 'N/M') and the lines naming a T- check are collected
//   compile (T-E2E): src/compile.js on every level of the sets, --workers processes at once (1 worker each), --seconds
//     each: per level routed, the compile's wall seconds, run ticks, lb, gap, the output VERIFIED here (C.evaluate of the
//     written .eetas: an output that does not finish is a FAIL), the best known TAS (truthset.knownRoutes by the level
//     file's md5, replayed) and the ratio, the proven legs, the stall reason when not routed
//   writes <out>/truth.jsonl (a line per level, a line per part) and <out>/truth.md (the tables and the totals: routed %,
//   median / p90 compile s, the median ratio to the known, % proven legs, the median gap); default out
//   src/out/n4plan/truth/<stamp>. --root: the truth root (else EEAT_TRUTH_ROOT, else this repo); --resume=1: the levels
//   already in <out>/truth.jsonl are kept, not compiled again. Exit 0 when nothing failed (unverified outputs, part
//   failures), else 1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PARTS = {
	model: ['test/planmodel.js', 'test/planplanner.js'],
	bounds: ['test/planbounds.js'],
	prims: ['test/planprims.js'],
	exec: ['test/planexec.js'],
};

function parse(argv) {
	const a = { _: [] };
	for (const s of argv) {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(s);
		if (m) a[m[1]] = m[2] === undefined ? '1' : m[2];
		else a._.push(s);
	}
	return a;
}
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((p, q) => p - q); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const pctl = (xs, p) => { const v = xs.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null; };
const r2 = (x, k = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** k) / 10 ** k : null);

/** a child process: its stdout / stderr, exit code, wall ms; killed after timeoutMs */
function runChild(cmd, args, o = {}) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const ch = spawn(cmd, args, { cwd: o.cwd || ROOT, env: Object.assign({}, process.env, o.env || {}), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '', err = '', killed = false;
		ch.stdout.on('data', (c) => { out += c; if (out.length > 64 << 20) out = out.slice(-(32 << 20)); });
		ch.stderr.on('data', (c) => { err = (err + c).slice(-20000); });
		const t = o.timeoutMs ? setTimeout(() => { killed = true; try { ch.kill(); } catch (e) { /* gone */ } }, o.timeoutMs) : null;
		ch.on('error', (e) => { err += e.message; });
		ch.on('close', (code) => { if (t) clearTimeout(t); resolve({ code, out, err, ms: Date.now() - t0, killed }); });
	});
}

// ---------------------------------------------------------------- the parts' own --truth checks
async function partChecks(part, a) {
	const rows = [];
	const shards = Math.max(1, Math.round(+a.shards || 1));
	for (const f of PARTS[part]) {
		const file = path.join(ROOT, f);
		if (!fs.existsSync(file)) { rows.push({ part, test: f, status: 'absent', passed: null, failed: null, lines: [] }); continue; }
		// (--shards=K: K processes, each --shard=i/K, their counts summed; the parts' tests take --shard, --limit, --par)
		const argsOf = (i) => [file, '--truth', ...(a.limit ? [`--limit=${a.limit}`] : []), ...(a.sets ? [`--sets=${a.sets}`] : []), ...(a.par ? [`--par=${a.par}`] : []),
			...(shards > 1 ? [`--shard=${i}/${shards}`] : [])];
		const t0 = Date.now();
		const rs = await Promise.all(Array.from({ length: shards }, (_, i) => runChild(process.execPath, argsOf(i), { timeoutMs: (+a.partMinutes || 60) * 60000 })));
		let passed = null, failed = null, keep = [], killed = false, code = 0, tail = '';
		for (const r of rs) {
			const lines = r.out.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
			let p = null, q = null;
			for (const l of lines) {
				let m = /(\d+)\s+passed,\s*(\d+)\s+failed/.exec(l);
				if (m) { p = +m[1]; q = +m[2]; continue; }
				m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(l);
				if (m) { p = +m[1]; q = +m[2]; }
			}
			if (p !== null) { passed = (passed || 0) + p; failed = (failed || 0) + q; }
			keep = keep.concat(lines.filter((l) => /^\s*(ok|FAIL)\b/.test(l) || /\bT-[A-Z-]+/.test(l)));
			if (r.killed) killed = true;
			if (r.code !== 0) { code = r.code; tail += (r.err || r.out).slice(-800); }
		}
		const status = killed ? 'timeout' : code === 0 && (failed === null || failed === 0) ? 'pass' : 'fail';
		rows.push({ part, test: f, status, code, passed, failed, shards, sec: r2((Date.now() - t0) / 1000), lines: keep.slice(-120), tail: status === 'pass' ? '' : tail.slice(-1500) });
	}
	return rows;
}

// ---------------------------------------------------------------- T-E2E: the compiler on every level
async function compileAll(a, out, append) {
	const TS = require('./truthset.js');
	const S = require('./strategy.js');
	const C = require('../common.js');
	const T = require('./types.js');
	const root = a.root ? path.resolve(a.root) : undefined;
	const sets = a.sets ? String(a.sets).split(',').filter(Boolean) : ['campaign', 'hard', 'd4'];
	let levels = TS.levelFiles({ root, sets });
	if (+a.limit > 0) levels = levels.slice(0, +a.limit);
	const seconds = +a.seconds > 0 ? +a.seconds : 60;
	const par = Math.max(1, +a.workers || Math.max(1, Math.min(40, os.cpus().length - 2)));
	const done = new Map();
	const jf = path.join(out, 'truth.jsonl');
	if (a.resume === '1' && fs.existsSync(jf)) for (const l of fs.readFileSync(jf, 'utf8').split('\n')) { try { const o = JSON.parse(l); if (o.kind === 'level') done.set(`${o.set}/${o.name}`, o); } catch (e) { /* a partial line */ } }
	fs.mkdirSync(path.join(out, 'eetas'), { recursive: true });
	fs.mkdirSync(path.join(out, 'reports'), { recursive: true });
	const rows = [];
	const todo = [];
	for (const lv of levels) { const k = `${lv.set}/${lv.name}`; if (done.has(k)) rows.push(done.get(k)); else todo.push(lv); }
	console.log(`[truth] compile: ${levels.length} levels (${todo.length} to run, ${rows.length} kept), ${par} at once, ${seconds} s each -> ${out}`);
	let next = 0, n = 0;
	const t0 = Date.now();
	const one = async (lv) => {
		const base = `${lv.set}_${lv.name}`.replace(/[^\w.-]+/g, '_').slice(0, 120);
		const eetas = path.join(out, 'eetas', `${base}.eetas`), rep = path.join(out, 'reports', `${base}.json`);
		for (const f of [eetas, rep]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
		const args = [path.join(ROOT, 'src', 'compile.js'), lv.file, `--seconds=${seconds}`, '--workers=1', '--quiet', '--known=0', `--out=${eetas}`, `--report=${rep}`, ...(a.parts ? [`--parts=${path.resolve(a.parts)}`] : [])];
		const r = await runChild(process.execPath, args, { timeoutMs: (seconds + 90) * 1000, env: { EEAT_TRUTH_ROOT: root || process.env.EEAT_TRUTH_ROOT || '' } });
		let report = null;
		try { report = JSON.parse(fs.readFileSync(rep, 'utf8')); } catch (e) { report = null; }
		// (the output verified here, whatever the compiler said: an output that does not finish is a FAIL)
		let verified = null, vfail = '';
		if (fs.existsSync(eetas)) {
			try { const L = T.loadLevelFile(lv.file); const ev = C.evaluate(L, C.readEetas(eetas)); verified = ev ? { runTicks: ev.runTicks, ticks: ev.complete, deaths: ev.deaths } : null; if (!ev) vfail = 'the written .eetas does not finish'; } catch (e) { vfail = `the replay failed: ${e.message}`; }
		}
		let known = null;
		try { known = S.knownOf(lv.file, { root: root || process.env.EEAT_TRUTH_ROOT || undefined }); } catch (e) { known = null; }
		const routed = !!(report && report.ok && verified);
		const runTicks = verified ? verified.runTicks : null;
		const row = { kind: 'level', set: lv.set, name: lv.name, file: lv.file, routed, exit: r.code, killed: r.killed, sec: r2(r.ms / 1000), runTicks, time: runTicks !== null ? C.fmt(runTicks) : null,
			lb: report ? report.lb : null, gap: routed && report ? runTicks - report.lb : null, gapPct: routed && report && runTicks > 0 ? r2((100 * (runTicks - report.lb)) / runTicks) : null,
			optimal: !!(routed && report && report.lbProof), lbProof: report && report.lbProof ? report.lbProof : undefined, legs: report ? (report.legs || []).length : null, provenLegs: report ? report.provenLegs || 0 : null, verified: fs.existsSync(eetas) ? !!verified : null, verifyFail: vfail || undefined,
			reportRunTicks: report ? report.runTicks : null, known: known ? known.runTicks : null, knownSource: known ? known.source : null, ratio: routed && known && known.runTicks > 0 ? r2(runTicks / known.runTicks, 3) : null,
			stages: report ? report.stages : null, end: report ? report.end : null, steps: report ? report.steps : null, anchors: report ? report.anchors : null, bugs: report ? report.bugs : null,
			why: routed ? '' : (report && report.why) || (r.killed ? `timeout after ${seconds + 90} s` : `exit ${r.code}: ${(r.err || r.out).trim().split('\n').pop() || ''}`.slice(0, 400)) };
		rows.push(row);
		append(row);
		n++;
		console.log(`[truth] ${n}/${todo.length} ${lv.set}/${lv.name}: ${routed ? `${row.time} (${runTicks} run ticks, lb ${row.lb}, gap ${row.gapPct}%${row.optimal ? ', PROVEN OPTIMAL' : ''}${row.ratio !== null ? `, x${row.ratio} the known` : ''})` : `no route: ${String(row.why).slice(0, 120)}`}${vfail ? ` UNVERIFIED: ${vfail}` : ''} [${row.sec} s, ${Math.round((Date.now() - t0) / 1000)} s in]`);
	};
	await Promise.all(Array.from({ length: Math.min(par, todo.length) }, async () => { while (next < todo.length) { const lv = todo[next++]; await one(lv); } }));
	return rows;
}

function totalsOf(rows) {
	const all = rows.length, routed = rows.filter((x) => x.routed);
	const unverified = rows.filter((x) => x.verified === false || x.verifyFail).length;
	const legs = rows.reduce((s, x) => s + (x.routed ? x.legs || 0 : 0), 0), proven = rows.reduce((s, x) => s + (x.routed ? x.provenLegs || 0 : 0), 0);
	return { levels: all, routed: routed.length, routedPct: all ? r2((100 * routed.length) / all) : 0, unverified, medianSec: r2(median(rows.map((x) => x.sec))), p90Sec: r2(pctl(rows.map((x) => x.sec), 0.9)),
		medianSecRouted: r2(median(routed.map((x) => x.sec))), medianRatio: r2(median(routed.map((x) => x.ratio)), 3), withKnown: routed.filter((x) => x.ratio !== null).length,
		provenPct: legs ? r2((100 * proven) / legs) : 0, legs, proven, medianGapPct: r2(median(routed.map((x) => x.gapPct))), under60: routed.filter((x) => x.sec <= 60).length, optimal: routed.filter((x) => x.optimal).length };
}
/** a number for the tables: '-' for none */
const v = (x, pre = '', post = '') => (x === null || x === undefined || !Number.isFinite(+x) ? '-' : `${pre}${x}${post}`);
function markdown(parts, rows, a) {
	const L = [];
	L.push(`# n4plan truth (${new Date().toISOString()})`, '', `part: ${a.part || 'all'}; sets: ${a.sets || 'campaign,hard,d4'}; seconds: ${a.seconds || 60}; limit: ${a.limit || '-'}`, '');
	if (parts.length) {
		L.push('## the parts\' checks', '', '| part | test | status | passed | failed | s |', '|---|---|---|---|---|---|');
		for (const p of parts) L.push(`| ${p.part} | ${p.test} | ${p.status} | ${p.passed === null ? '-' : p.passed} | ${p.failed === null ? '-' : p.failed} | ${p.sec === undefined ? '-' : p.sec} |`);
		for (const p of parts) if (p.lines && p.lines.length) { L.push('', `### ${p.test}`, '', '```'); for (const l of p.lines) L.push(l); if (p.tail) L.push('...', p.tail); L.push('```'); }
		L.push('');
	}
	if (rows.length) {
		const t = totalsOf(rows);
		L.push('## T-E2E: the compiler on every level', '');
		L.push(`- routed ${t.routed} of ${t.levels} (${t.routedPct}%), ${t.under60} of them within 60 s`);
		L.push(`- UNVERIFIED outputs: ${t.unverified} (must be 0)`);
		L.push(`- compile seconds: median ${v(t.medianSec)}, p90 ${v(t.p90Sec)} (routed: median ${v(t.medianSecRouted)})`);
		L.push(`- ratio to the best known TAS: median ${v(t.medianRatio, 'x')} over ${t.withKnown} routed levels with one`);
		L.push(`- proven legs ${t.proven} of ${t.legs} (${t.provenPct}%); the gap to the lower bound: median ${v(t.medianGapPct, '', '%')}`);
		for (const set of [...new Set(rows.map((x) => x.set))]) {
			const s = totalsOf(rows.filter((x) => x.set === set));
			L.push(`- ${set}: routed ${s.routed} of ${s.levels} (${s.routedPct}%), median ratio ${v(s.medianRatio, 'x')}, median ${v(s.medianSec)} s`);
		}
		L.push('', '| set | level | routed | s | run ticks | time | lb | gap % | known | ratio | proven legs | verified | why / end |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
		for (const x of rows.slice().sort((p, q) => p.set.localeCompare(q.set) || p.name.localeCompare(q.name))) {
			L.push(`| ${x.set} | ${String(x.name).replace(/\|/g, '/')} | ${x.routed ? 'yes' : 'no'} | ${x.sec} | ${x.runTicks === null ? '-' : x.runTicks} | ${x.time || '-'} | ${x.lb === null ? '-' : x.lb} | ${x.gapPct === null ? '-' : x.gapPct} | ` +
				`${x.known === null ? '-' : x.known} | ${x.ratio === null ? '-' : x.ratio} | ${x.provenLegs === null ? '-' : `${x.provenLegs}/${x.legs}`} | ${x.verified === null ? '-' : x.verified ? 'yes' : '**NO**'} | ${String(x.routed ? `end ${x.end}` : x.why || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 160)} |`);
		}
	}
	return L.join('\n') + '\n';
}

async function main() {
	const a = parse(process.argv.slice(2));
	const part = a.part || 'all';
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
	const out = a.out ? path.resolve(a.out) : path.join(ROOT, 'src', 'out', 'n4plan', 'truth', stamp);
	fs.mkdirSync(out, { recursive: true });
	const jf = path.join(out, 'truth.jsonl');
	const append = (o) => { try { fs.appendFileSync(jf, JSON.stringify(o) + '\n'); } catch (e) { /* read-only */ } };
	const partsRows = [];
	const which = part === 'all' ? ['model', 'bounds', 'prims', 'exec', 'compile'] : part.split(',');
	for (const p of which) {
		if (p === 'compile') continue;
		if (!PARTS[p]) throw new Error(`unknown part ${p} (model, bounds, prims, exec, compile, all)`);
		const rs = await partChecks(p, a);
		for (const r of rs) { partsRows.push(r); append(Object.assign({ kind: 'part' }, r)); console.log(`[truth] ${r.part} ${r.test}: ${r.status}${r.passed !== null ? ` ${r.passed}/${r.passed + r.failed}` : ''}`); }
	}
	let rows = [];
	if (which.includes('compile')) rows = await compileAll(a, out, append);
	const md = markdown(partsRows, rows, a);
	fs.writeFileSync(path.join(out, 'truth.md'), md);
	const t = rows.length ? totalsOf(rows) : null;
	if (t) {
		append(Object.assign({ kind: 'totals' }, t));
		console.log(`[truth] T-E2E: routed ${t.routed}/${t.levels} (${t.routedPct}%), unverified ${t.unverified}, median ${v(t.medianSec)} s (p90 ${v(t.p90Sec)}), median ratio ${v(t.medianRatio, 'x')} (${t.withKnown} with a known), proven optimal ${t.optimal || 0}, proven legs ${t.provenPct}%, median gap ${v(t.medianGapPct, '', '%')}`);
	}
	console.log(`[truth] wrote ${path.join(out, 'truth.md')} and truth.jsonl`);
	const bad = partsRows.some((r) => r.status === 'fail' || r.status === 'timeout') || (t && t.unverified > 0);
	return bad ? 1 : 0;
}
if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.log(`[truth] error: ${e.stack}`); process.exitCode = 1; });
module.exports = { totalsOf, markdown, partChecks, compileAll };

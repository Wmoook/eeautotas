'use strict';
// THE TIME TO THE FIRST ROUTE, side by side (B8 speed): src/compile.js on a level list under two or more arms (each arm
// its own environment), the arms' compiles interleaved so they share the box's load; with --full=0 (the default) each
// compile is killed (its whole process group: the stretch / chain / one-shot children too) at its FIRST verified route
// (the first 'result' event of kind finish: the engine evaluated it), which is exact for the time to the first route (a
// compile is causal: nothing before its first route depends on what comes after it) and costs a fraction of a full run.
//   node tools/cmp/firstab.js <code dir> <levels dir> <out dir> --list=<file of rel paths> [--arms=base:,rate:EEAT_RATE=1]
//        [--par=3 (compiles at once an arm)] [--workers=3] [--seconds=300] [--full=0] [--minfree=GB] [--cap=<s>]
// An arm is name:K=V;K=V (an empty env = the defaults). Output: <out>/<arm>/<id>.log (the JSON events), <out>/index.jsonl
// one line a compile {arm, rel, first (s), firstTicks, how, code, sec}; at the end the summary (median / p90 of the first
// route over the levels both arms routed, the count by 60 s) on stdout. Linux only for the group kill (detached spawn).
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [, , code, lvDir, out, ...rest] = process.argv;
const opt = (k, d) => { const a = rest.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const par = +opt('par', 3), workers = +opt('workers', 3), seconds = +opt('seconds', 300), full = opt('full', '0') === '1';
const minfree = +opt('minfree', 0), list = opt('list', '');
// (--cap=<s>: a compile with no route by <s> s of wall time is killed and counted unrouted (its budget stays --seconds, so
// the compile is the same up to the cap); default seconds + 10)
const capS = +opt('cap', 0);
const arms = opt('arms', 'base:').split(',').map((s) => {
	const i = s.indexOf(':'); const name = i < 0 ? s : s.slice(0, i); const env = {};
	for (const kv of (i < 0 ? '' : s.slice(i + 1)).split(';').filter(Boolean)) { const j = kv.indexOf('='); env[kv.slice(0, j)] = kv.slice(j + 1); }
	return { name, env, running: 0, next: 0 };
});
const rels = fs.readFileSync(list, 'utf8').split('\n').map((s) => s.replace(/#.*/, '').trim()).filter(Boolean);
fs.mkdirSync(out, { recursive: true });
for (const a of arms) fs.mkdirSync(path.join(out, a.name), { recursive: true });
const memAvailGB = () => { try { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/); return m ? +m[1] / 1048576 : Infinity; } catch (e) { return Infinity; } };
const t0 = Date.now();
let done = 0; const total = rels.length * arms.length;
const recs = [];
function launch(a) {
	const rel = rels[a.next++], id = rel.replace(/[\\/]/g, '__').replace(/\.eelvl$/, '');
	const f = path.join(lvDir, rel);
	a.running++;
	const ts = Date.now();
	const args = [path.join(code, 'src', 'compile.js'), f, `--out=${path.join(out, a.name, id + '.eetas')}`, `--report=${path.join(out, a.name, id + '.json')}`, `--workers=${workers}`, `--seconds=${seconds}`, '--known=0', '--json'];
	const env = Object.assign({}, process.env, a.env);
	const p = cp.spawn(process.execPath, args, { cwd: code, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
	const log = fs.createWriteStream(path.join(out, a.name, id + '.log'));
	const rec = { arm: a.name, rel, id, first: null, firstTicks: null, how: null, code: null, sec: null };
	let buf = '', killed = false;
	const killAll = () => { if (killed) return; killed = true; try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { try { p.kill('SIGKILL'); } catch (e2) { /* gone */ } } };
	p.stdout.on('data', (d) => {
		log.write(d);
		if (rec.first !== null) return;
		buf += d.toString();
		let k;
		while ((k = buf.indexOf('\n')) >= 0) {
			const s = buf.slice(0, k); buf = buf.slice(k + 1);
			if (!s.startsWith('{"ev":"result"')) continue;
			try {
				const e = JSON.parse(s);
				if (e.kind === 'finish' && e.runTicks > 0) { rec.first = e.t; rec.firstTicks = e.runTicks; rec.how = e.how || null; rec.wall = (Date.now() - ts) / 1000; if (!full) killAll(); break; }
			} catch (e) { /* a cut line */ }
		}
	});
	p.stderr.on('data', (d) => log.write(d));
	// (no route by the budget: killed at seconds + 10 unless --full=1, then the fullc.js hard limit)
	const cap = setTimeout(killAll, ((full ? seconds * 3 + 60 : (capS > 0 ? capS : seconds + 10))) * 1000);
	p.on('close', (c) => {
		clearTimeout(cap);
		log.end();
		rec.code = c; rec.sec = (Date.now() - ts) / 1000;
		if (full) { try { const r = JSON.parse(fs.readFileSync(path.join(out, a.name, id + '.json'), 'utf8')); rec.ok = !!r.ok; rec.runTicks = r.ok ? r.runTicks : null; } catch (e) { rec.ok = false; } }
		fs.appendFileSync(path.join(out, 'index.jsonl'), JSON.stringify(rec) + '\n');
		recs.push(rec);
		a.running--; done++;
		if (done % 10 === 0 || done === total) console.log(`${done}/${total} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
		if (done === total) summary();
		pump();
	});
}
let waitT = null;
function pump() {
	// (round robin over the arms: each arm's next compile starts as one of its own ends; the RAM guard holds a start)
	let any = true;
	while (any) {
		any = false;
		for (const a of arms) {
			if (a.running >= par || a.next >= rels.length) continue;
			if (minfree > 0 && memAvailGB() < minfree) { if (!waitT) waitT = setTimeout(() => { waitT = null; pump(); }, 3000); return; }
			launch(a); any = true;
		}
	}
}
function summary() {
	const by = {};
	for (const r of recs) (by[r.rel] = by[r.rel] || {})[r.arm] = r;
	const q = (xs, f) => { const s = xs.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; };
	for (const a of arms) {
		const xs = recs.filter((r) => r.arm === a.name && r.first !== null).map((r) => r.first);
		console.log(`${a.name.padEnd(12)} routed ${xs.length} / ${rels.length}  first median ${q(xs, 0.5)} s  p90 ${q(xs, 0.9)} s  by 60 s ${xs.filter((x) => x <= 60).length}  sum ${xs.reduce((s, x) => s + x, 0).toFixed(0)} s`);
	}
	if (arms.length >= 2) {
		const A = arms[0].name;
		for (const b of arms.slice(1)) {
			const both = Object.values(by).filter((o) => o[A] && o[b.name] && o[A].first !== null && o[b.name].first !== null);
			const ratio = both.map((o) => o[b.name].first / o[A].first);
			const geo = Math.exp(ratio.reduce((s, x) => s + Math.log(x), 0) / Math.max(1, ratio.length));
			console.log(`${b.name} vs ${A}: both routed ${both.length}, first faster ${both.filter((o) => o[b.name].first < o[A].first).length} / slower ${both.filter((o) => o[b.name].first > o[A].first).length}, geo-mean ratio ${geo.toFixed(3)}; first-route ticks ${both.reduce((s, o) => s + o[b.name].firstTicks, 0)} vs ${both.reduce((s, o) => s + o[A].firstTicks, 0)}`);
		}
	}
}
pump();

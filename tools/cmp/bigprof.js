'use strict';
// tools/cmp/bigprof.js: per compile log (fullc.js --json=1 <id>.log) where the moves' time goes on a big level: the
// executor's reaches (exec.reach) that never simulated (sims 0: the budget spent in the reach's setup), their time, the
// steps, the triggers reached, the stages, and the peak RSS from index.jsonl when present.
//   node tools/cmp/bigprof.js <fullc out dir> [--json=1]
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const asJson = process.argv.includes('--json=1');
const idx = new Map();
try { for (const s of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(s); idx.set(r.id, r); } } catch (e) { /* none yet */ }
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()) {
	const ev = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
	const re = ev.filter((e) => e.ev === 'exec.reach');
	const z = re.filter((e) => !e.sims);
	const steps = ev.filter((e) => e.ev === 'step');
	const ok = steps.filter((e) => e.ok).length;
	const last = ev[ev.length - 1] || {};
	const prog = ev.filter((e) => e.ev === 'progress');
	const lastP = prog[prog.length - 1] || {};
	const firstTrig = (prog.find((e) => e.triggers > 0) || {}).t;
	const sum = (a, k) => a.reduce((s, e) => s + (+e[k] || 0), 0);
	const stages = {};
	for (const e of ev.filter((e) => e.ev === 'stage')) stages[e.name] = Math.round(e.ms / 100) / 10;
	const rep = ev.find((e) => e.ev === 'report') || {};
	const whys = {};
	for (const e of z) whys[e.why] = (whys[e.why] || 0) + 1;
	const id = f.replace(/\.log$/, '');
	const ix = idx.get(id) || {};
	// (EEAT_EXEC_PROF=1 runs: the workers' goal-field builds (reach.js reachField: ms, count), bounds fields, late answers)
	const pr = ev.filter((e) => e.ev === 'exec.prof');
	const prof = pr.length ? { calls: pr.length, run: Math.round(sum(pr, 'run') / 100) / 10, rf: Math.round(sum(pr, 'rf') / 100) / 10, rfN: sum(pr, 'rfN'), bf: Math.round(sum(pr, 'bf') / 100) / 10,
		bfN: sum(pr, 'bfN'), late: pr.filter((e) => e.late).length } : null;
	const r = { id, t: last.t, ok: rep.ok, runTicks: rep.runTicks, reach: re.length, sims0: z.length, ms0: Math.round(sum(z, 'ms') / 100) / 10, msAll: Math.round(sum(re, 'ms') / 100) / 10,
		steps: steps.length, okSteps: ok, triggers: lastP.triggers, anchors: lastP.anchors, firstTrigT: firstTrig, whys0: whys, stages, peakRssMB: ix.peakRssMB, prof };
	if (asJson) console.log(JSON.stringify(r));
	else console.log(`${id} t ${r.t} ok ${r.ok} reach ${r.reach} sims0 ${r.sims0} (${r.ms0} s of ${r.msAll} s) steps ${r.steps} ok ${r.okSteps} triggers ${r.triggers} (first at ${r.firstTrigT}) anchors ${r.anchors} rss ${r.peakRssMB} ${JSON.stringify(whys)} | ${Object.entries(stages).map(([k, v]) => `${k} ${v}`).join(', ')}${prof ? ` | fields ${prof.rf} s / ${prof.rfN} builds of ${prof.run} worker-s, bounds ${prof.bf} s / ${prof.bfN}, late ${prof.late} of ${prof.calls}` : ''}`);
}

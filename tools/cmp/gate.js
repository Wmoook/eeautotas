'use strict';
// THE SHARED GATE of the compiler lanes: a full-compile dir (tools/cmp/fullc.js) against the baseline's per-level JSON
// (tools/cmp/summ.js --json), on the levels of the gate list (src/out/n4plan/gate20.txt: one levels-dir relative path a
// line, '#' comments).
//   node tools/cmp/gate.js <baseline.json> <new dir> [--list=<gate20.txt>]
// A level is WORSE when it compiled in the baseline and does not now, or (both not compiled) its progress (the most
// triggers an anchor reached, 'gain') dropped by 2 or more; BETTER the reverse. Exit 1 when any level is worse and
// no level is better by as much (the gate: never push a change that breaks another lane's levels); the run-to-run
// spread of a 60-s compile is a trigger or two: rerun a single worse level before calling it a loss.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [, , baseFile, dir] = process.argv;
const listArg = (process.argv.find((a) => a.startsWith('--list=')) || '').slice(7);
const base = new Map(JSON.parse(fs.readFileSync(baseFile, 'utf8')).map((r) => [r.rel, r]));
const tmp = path.join(dir, 'gate_now.json');
cp.execFileSync(process.execPath, [path.join(__dirname, 'summ.js'), dir, `--json=${tmp}`], { stdio: 'ignore' });
const now = new Map(JSON.parse(fs.readFileSync(tmp, 'utf8')).map((r) => [r.rel, r]));
let want = null;
if (listArg) want = new Set(fs.readFileSync(listArg, 'utf8').split('\n').map((s) => s.replace(/#.*/, '').trim()).filter(Boolean));
const rows = [];
let worse = 0, better = 0, okB = 0, okN = 0;
for (const [rel, n] of now) {
	if (want && !want.has(rel)) continue;
	const b = base.get(rel);
	if (!b) continue;
	okB += b.ok ? 1 : 0; okN += n.ok ? 1 : 0;
	let v = 'same';
	if (b.ok && !n.ok) v = 'WORSE (lost the compile)';
	else if (!b.ok && n.ok) v = 'BETTER (compiles now)';
	else if (b.ok && n.ok) v = n.runTicks < b.runTicks ? 'better (faster)' : n.runTicks > b.runTicks ? 'slower' : 'same';
	else if ((n.gain | 0) <= (b.gain | 0) - 2) v = 'WORSE (progress)';
	else if ((n.gain | 0) >= (b.gain | 0) + 2) v = 'better (progress)';
	if (v.startsWith('WORSE')) worse++;
	if (v.startsWith('BETTER') || v.startsWith('better')) better++;
	rows.push(`${rel.padEnd(62)} ${v.padEnd(26)} base ${b.ok ? b.runTicks + ' ticks' : 'gain ' + (b.gain | 0)}  now ${n.ok ? n.runTicks + ' ticks' : 'gain ' + (n.gain | 0)}`);
}
console.log(rows.join('\n'));
console.log(`gate: compiled ${okN} vs baseline ${okB} of ${rows.length}; worse ${worse}, better ${better}`);
process.exit(worse > 0 && okN <= okB ? 1 : 0);

'use strict';
// THE MEASUREMENT's collection (n5-hy-best, on the box): every routed level's best.eetas of a tools/hybrid_batch.js out
// dir copied as <res>/eetas/<id>.eetas with <id>.json {runTicks} (tools/cmp/verify.js's layout: <rel with / as __>), then
// tools/cmp/verify.js replays each one from the level file at its run ticks; <res>/verify.txt, <res>/H_results.jsonl (the
// last line a level).
//   node docs/hybrid/collect.js <batch out dir> <levels dir> <res dir>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [outDir, lvDir, resDir] = process.argv.slice(2).map((p) => path.resolve(p));
const V = path.join(resDir, 'eetas');
fs.mkdirSync(V, { recursive: true });
const rows = new Map();
for (const l of fs.readFileSync(path.join(outDir, 'results.jsonl'), 'utf8').split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); rows.set(r.rel, r); } catch (e) { /* torn */ } }
let n = 0;
for (const r of rows.values()) {
	if (!r.routed || !r.final) continue;
	const src = path.join(outDir, 'runs', r.id, 'best.eetas');
	if (!fs.existsSync(src)) continue;
	fs.copyFileSync(src, path.join(V, `${r.id}.eetas`));
	fs.writeFileSync(path.join(V, `${r.id}.json`), JSON.stringify({ runTicks: r.final.runTicks }));
	n++;
}
fs.writeFileSync(path.join(resDir, 'H_results.jsonl'), [...rows.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
let out = '';
try { out = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'cmp', 'verify.js'), V, lvDir], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
fs.writeFileSync(path.join(resDir, 'verify.txt'), out);
console.log(`${rows.size} levels, ${n} routes copied; ${out.trim().split('\n').pop()}`);

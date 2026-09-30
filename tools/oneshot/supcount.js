'use strict';
// THE SUPPORTS' COUNTS AND MEMORY per level (n5-oneshot part 1): src/plan/oneshot/supports.js buildSupports on each level
// file, each in a FRESH child process (a clean RSS): the stats (supports by kind, flags, spans and their end kinds, fields,
// portal exits, triggers, respawns, the class space), the build time (the level model's own time apart), the enumeration's
// typed-array bytes, the V8 heap it added and the process's peak RSS.
// Usage: node tools/oneshot/supcount.js <level.eelvl> ... [--out=<file.jsonl>] [--list=<file of paths>]
//        node tools/oneshot/supcount.js --table=<file.jsonl>        (a markdown table)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] === undefined ? '1' : m[2]]; }));

if (opt.child) {
	// one level, this process: model first (its own time), then the supports
	const T = require('../../src/plan/types.js');
	const MD = require('../../src/plan/model.js');
	const SP = require('../../src/plan/oneshot/supports.js');
	const f = opt.child;
	const L = T.loadLevelFile(f);
	const t0 = Date.now();
	const model = MD.compileModel(L, {});
	const modelMs = Date.now() - t0;
	if (global.gc) global.gc();
	const h0 = process.memoryUsage().heapUsed;
	const S = SP.buildSupports(L, { model });
	if (global.gc) global.gc();
	const h1 = process.memoryUsage().heapUsed;
	const st = S.stats;
	const ru = process.resourceUsage();
	process.stdout.write(JSON.stringify({ level: path.basename(f).replace(/\.eelvl$/i, ''), file: f, W: L.width, H: L.height, modelMs, ms: st.ms, heapMB: +((h1 - h0) / 1e6).toFixed(1), bytesMB: +(st.bytes / 1e6).toFixed(2), maxRssMB: Math.round(ru.maxRSS / 1024), stats: st }) + '\n');
	process.exit(0);
}

if (opt.table) {
	const rows = fs.readFileSync(opt.table, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const out = [];
	out.push('| level | W x H | flips | surface supports (down/up/left/right) | spans (drop ends) | EXACT (edge/near/binade) | xpull | fields (entries, rest cells) | portal exits | triggers (tiles) | respawns | class space | build ms | enum MB | heap MB | peak RSS MB |');
	out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
	const n = (x) => Number(x).toLocaleString('en-US');
	for (const r of rows) {
		const s = r.stats;
		out.push(`| ${r.level} | ${r.W} x ${r.H} | ${s.flips.join(',')} | ${n(s.surf)} (${s.surfByDir.down}/${s.surfByDir.up}/${s.surfByDir.left}/${s.surfByDir.right}) | ${n(s.spans)} (${s.spanEnds.drop}) | ${n(s.flags.exact)} (${s.flags.edge}/${s.flags.near}/${s.flags.binade}) | ${n(s.flags.xpull)} | ${s.fields} (${n(s.fieldEntries)}, ${n(s.fieldRestCells)}) | ${s.portalExits} | ${s.triggers} (${s.triggerTiles}) | ${s.respawns} | ${n(s.classes)} | ${n(Math.round(s.ms))} | ${r.bytesMB} | ${r.heapMB} | ${r.maxRssMB} |`);
	}
	const tot = (k) => rows.reduce((a, r) => a + k(r), 0);
	out.push(`| **all ${rows.length}** | | | ${n(tot((r) => r.stats.surf))} | ${n(tot((r) => r.stats.spans))} | ${n(tot((r) => r.stats.flags.exact))} | ${n(tot((r) => r.stats.flags.xpull))} | ${n(tot((r) => r.stats.fields))} | ${n(tot((r) => r.stats.portalExits))} | ${n(tot((r) => r.stats.triggers))} | ${n(tot((r) => r.stats.respawns))} | ${n(tot((r) => r.stats.classes))} | ${n(Math.round(tot((r) => r.stats.ms)))} | ${tot((r) => r.bytesMB).toFixed(1)} | ${tot((r) => r.heapMB).toFixed(1)} | max ${Math.max(...rows.map((r) => r.maxRssMB))} |`);
	console.log(out.join('\n'));
	process.exit(0);
}

let files = argv.filter((a) => !a.startsWith('--'));
if (opt.list) files = files.concat(fs.readFileSync(opt.list, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
const outF = opt.out ? fs.openSync(opt.out, 'w') : null;
for (const f of files) {
	let line;
	try {
		line = execFileSync(process.execPath, ['--expose-gc', __filename, `--child=${f}`], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
	} catch (e) { line = JSON.stringify({ level: path.basename(f), file: f, error: String(e.message).slice(0, 300) }); }
	if (outF) fs.writeSync(outF, line + '\n');
	const r = JSON.parse(line);
	if (r.error) { console.log(`${r.level}: ERROR ${r.error}`); continue; }
	const s = r.stats;
	console.log(`${r.level.slice(0, 36).padEnd(36)} ${r.W}x${r.H} surf ${s.surf} spans ${s.spans} exact ${s.flags.exact} fields ${s.fields} portals ${s.portalExits} trig ${s.triggers} resp ${s.respawns} classes ${s.classes} ${Math.round(s.ms)} ms (model ${r.modelMs} ms) enum ${r.bytesMB} MB heap ${r.heapMB} MB rss ${r.maxRssMB} MB`);
}
if (outF) fs.closeSync(outF);

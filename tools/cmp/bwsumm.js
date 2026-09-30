'use strict';
// summary of tools/cmp/bwkrt.js runs: node tools/cmp/bwsumm.js <dir of <level>.json> [--krt=<krt_b4.jsonl>] [--json]
// Per level and start: the route's leg, found / ticks / ms; against the executor's known-route test (krt.js's rows: the
// same starts, rungs 1-2) where --krt is given. Totals: found per start kind, the ticks over the route's, the time.
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const dir = argv.find((s) => !s.startsWith('--'));
const krt = new Map();
if (opt('krt', '')) for (const l of fs.readFileSync(opt('krt'), 'utf8').trim().split('\n')) { const r = JSON.parse(l); krt.set(path.basename(r.rel, '.eelvl'), r); }
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
	let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
	rows.push([path.basename(f, '.json'), r]);
}
const tot = {};
const add = (k, ok, T, leg, ms, kok) => {
	const t = tot[k] || (tot[k] = { n: 0, ok: 0, le: 0, lt: 0, ratio: [], ms: [], kok: 0, both: 0, onlyBw: 0, onlyEx: 0 });
	t.n++; t.ms.push(ms);
	if (ok) { t.ok++; t.ratio.push(T / leg); if (T <= leg) t.le++; if (T < leg) t.lt++; }
	if (kok !== null) { if (kok) t.kok++; if (ok && kok) t.both++; else if (ok) t.onlyBw++; else if (kok) t.onlyEx++; }
};
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
const lines = [];
for (const [name, r] of rows) {
	const k = krt.get(name);
	const cls = k ? k.kind : '';
	for (const x of r.res || []) {
		const kind = x.start.startsWith('prev') || x.start === 'spawn' ? 'prev' : x.start;
		let kok = null;
		if (k && Array.isArray(k.starts)) {
			const pre = kind === 'prev' ? (x.start === 'spawn' ? 'spawn' : 'prevEvent') : x.start;
			const mine = k.starts.filter((s) => s.startsWith(pre + ' ') || s.startsWith(pre));
			kok = mine.some((s) => / ok /.test(s));
		}
		add(kind, x.ok && x.verified, x.T, x.routeLeg, x.ms, kok);
		lines.push(`${name.padEnd(40)} ${cls.padEnd(8)} ${x.start.padEnd(18)} leg ${String(x.routeLeg).padStart(5)}  ${x.ok ? (x.verified ? 'OK' : 'UNVERIFIED') : 'no'} ${x.ok ? String(x.T).padStart(5) : '    -'}  ${(x.ms / 1000).toFixed(1).padStart(5)} s  ex:${kok === null ? '?' : kok ? 'ok' : 'no'}  ${x.ok ? '' : x.why || ''} cells ${x.st ? x.st.cells : '-'} fin ${x.st ? x.st.finite : '-'} dS ${x.st ? x.st.dStart : '-'} corr ${x.st ? x.st.corrTiles : '-'} closed ${x.st ? x.st.closed : '-'}`);
	}
}
if (argv.includes('--json')) { console.log(JSON.stringify(tot)); process.exit(0); }
for (const l of lines) console.log(l);
console.log('');
for (const [k, t] of Object.entries(tot)) {
	console.log(`${k.padEnd(8)} legs ${t.n}  found ${t.ok} (${(100 * t.ok / t.n).toFixed(0)}%)  <= route ${t.le}  < route ${t.lt}  ticks / route median ${med(t.ratio) ? med(t.ratio).toFixed(3) : '-'}  ms median ${med(t.ms)}  | executor (krt rungs 1-2) found ${t.kok}; both ${t.both}, only backward ${t.onlyBw}, only executor ${t.onlyEx}`);
}

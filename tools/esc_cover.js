#!/usr/bin/env node
'use strict';
// The stall rotation's order (editor.js ESC_ROTATION) from measured runs: a greedy set cover of the levels each
// configuration routed. Data-driven: it reads result rows (JSON lines with level file, config, routed, firstRouteS: the
// portfolio sweep src/out/pf/pfsweep.js and the filler src/out/fill/filler.js write them) and names no level.
//   node tools/esc_cover.js <results.jsonl> [more.jsonl ...] [--configs=longruns,lr2,lr3,plain,reach,base] [--head=a,b]
//     [--given=base] [--json=1]
// --head: configurations that go first in this order (an order measured before, e.g. an A/B's); the cover orders the
// rest after them, their levels counted as routed. --given: configurations whose levels count as routed before the cover
// starts (base: the search's own, which runs on beside every escape); they still end up in the order, after the others.
// Greedy: the next configuration routes the most levels not routed by the ones before it (ties: more levels routed in
// all, then the lower median first route); the configurations that add no level follow, most routed first, then those
// that routed none. Every configuration listed ends up in the order (a rotation keeps them all: no configuration is
// dropped for having routed nothing in these runs).
const fs = require('fs');

function parse(argv) {
	const files = [], o = { configs: '', head: '', given: '', json: false };
	for (const a of argv) {
		const m = /^--(\w+)=(.*)$/.exec(a);
		if (m) { if (m[1] === 'json') o.json = m[2] === '1'; else if (m[1] in o) o[m[1]] = m[2]; continue; }
		files.push(a);
	}
	return { files, o };
}
/** rows of every file (bad lines skipped) */
function readRows(files) {
	const rows = [];
	for (const f of files) {
		let text = '';
		try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
		for (const l of text.split('\n')) {
			if (!l.trim()) continue;
			try { rows.push(JSON.parse(l)); } catch (e) { /* a torn line */ }
		}
	}
	return rows;
}
const median = (a) => { if (!a.length) return Infinity; const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
/** the greedy cover: rows [{file|level, config, routed, firstRouteS}], configs (the candidates; empty: every config in
 *  the rows), head (first, in this order), given (their levels routed before; last) -> {order: [{config, adds, routed,
 *  runs, medianS}], covered} */
function cover(rows, configs, head, given) {
	head = head || []; given = given || [];
	const by = new Map();
	for (const r of rows) {
		const c = String(r.config || '');
		if (!c || (configs.length && !configs.includes(c))) continue;
		const lv = String(r.file || r.level || '');
		if (!lv) continue;
		if (!by.has(c)) by.set(c, { levels: new Set(), runs: 0, times: [] });
		const b = by.get(c);
		b.runs++;
		if (r.routed) { b.levels.add(lv); if (Number.isFinite(r.firstRouteS)) b.times.push(r.firstRouteS); }
	}
	for (const c of configs) if (!by.has(c)) by.set(c, { levels: new Set(), runs: 0, times: [] });
	const left = new Set(by.keys()), done = new Set(), order = [];
	const take = (c) => {
		const b = by.get(c);
		let add = 0;
		for (const lv of b.levels) if (!done.has(lv)) { add++; done.add(lv); }
		order.push({ config: c, adds: add, routed: b.levels.size, runs: b.runs, medianS: Number.isFinite(median(b.times)) ? median(b.times) : null });
		left.delete(c);
	};
	for (const c of given) if (by.has(c)) for (const lv of by.get(c).levels) done.add(lv);
	for (const c of head) if (left.has(c)) take(c);
	for (const c of given) left.delete(c);
	while (left.size) {
		let best = null, bestAdd = -1;
		for (const c of left) {
			const b = by.get(c);
			let add = 0;
			for (const lv of b.levels) if (!done.has(lv)) add++;
			const better = !best || add > bestAdd || (add === bestAdd && (b.levels.size > by.get(best).levels.size ||
				(b.levels.size === by.get(best).levels.size && median(b.times) < median(by.get(best).times))));
			if (better) { best = c; bestAdd = add; }
		}
		take(best);
	}
	// (the given ones last: their levels were counted as routed from the start)
	for (const c of given) if (by.has(c) && !order.some((x) => x.config === c)) {
		const b = by.get(c);
		order.push({ config: c, adds: 0, routed: b.levels.size, runs: b.runs, medianS: Number.isFinite(median(b.times)) ? median(b.times) : null });
	}
	return { order, covered: done.size };
}

module.exports = { cover, readRows };

if (require.main === module) {
	const { files, o } = parse(process.argv.slice(2));
	if (!files.length) { console.error('usage: node tools/esc_cover.js <results.jsonl> [...] [--configs=a,b,c] [--json=1]'); process.exit(2); }
	const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
	const res = cover(readRows(files), list(o.configs), list(o.head), list(o.given));
	if (o.json) { console.log(JSON.stringify(res)); return; }
	for (const x of res.order) console.log(`${x.config}\tadds ${x.adds}\trouted ${x.routed} of ${x.runs} runs\tmedian first route ${x.medianS === null ? '-' : x.medianS + ' s'}`);
	console.log(`levels covered: ${res.covered}; the rotation: ${res.order.map((x) => x.config).join(',')}`);
}

'use strict';
// THE FIRST ROUTE'S LINEAGE (B8 speed, cycle 3): from a firstab.js / fullc.js --json log dir, each level's first route
// traced back anchor by anchor (an anchor's parent: the anchor of the longest inputs that are a prefix of its own, born
// before it; the step that made it: the ok step of its label from that parent ending at its birth), and each link's time
// from its parent's birth split into: esc = the same edge's failed attempts from the parent before it (the rung
// escalation), win = the successful step's own window, wait = the rest (other steps first / no worker free / a child's
// clock). The route's own link (the trophy step's event comes after the route: a killed compile has none) is all wait
// but its escalation. An anchor with no step is an import (a child's).
//   node tools/cmp/lineage.js <dir with <id>.log> [--json]
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const asJson = process.argv.includes('--json');
const out = [];
const agg = { n: 0, first: 0, traced: 0, esc: 0, win: 0, wait: 0, links: 0, imp: 0, rungs: [0, 0, 0, 0, 0], escR: [0, 0, 0, 0, 0], tools: {} };
for (const f of fs.readdirSync(dir).filter((s) => s.endsWith('.log'))) {
	const ev = [];
	for (const s of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
		if (!s.startsWith('{"ev":"step"') && !s.startsWith('{"ev":"source"') && !s.startsWith('{"ev":"result"')) continue;
		try { ev.push(JSON.parse(s)); } catch (e) { /* cut */ }
	}
	const res = ev.find((e) => e.ev === 'result' && e.kind === 'finish' && e.runTicks > 0);
	const row = { f: f.replace(/\.log$/, ''), first: res ? res.t : null, how: res ? (res.how || '') : '', legs: [] };
	if (!res) { out.push(row); continue; }
	agg.n++; agg.first += res.t;
	const steps = ev.filter((e) => e.ev === 'step');
	const anc = [{ id: 1, t: 0, inputs: '', label: 'start' }];
	for (const e of ev) if (e.ev === 'source' && e.anchor != null) anc.push({ id: e.anchor, t: e.t, inputs: e.inputs || '', label: e.label });
	const parentOf = (inputs, t) => {
		let b = anc[0];
		for (const a of anc) if (a.t <= t && a.inputs.length > b.inputs.length && a.inputs.length <= inputs.length && inputs.startsWith(a.inputs)) b = a;
		return b;
	};
	const chain = [];
	let node = { id: 'route', t: res.t, inputs: res.inputs || '', label: 'route' };
	for (let guard = 0; node && guard < 500; guard++) {
		let p = parentOf(node.inputs, node.t - 1e-6);
		let st = null;
		if (node.id !== 'route') for (const s of steps) if (s.ok && s.label === node.label && s.anchor === p.id && Math.abs(s.t - node.t) <= 0.3) st = s;
		// (an anchor keeps up to 4 arrivals: the step may have gone on from another arrival of its anchor than the prefix's)
		if (!st && node.id !== 'route') {
			for (const s of steps) if (s.ok && s.label === node.label && Math.abs(s.t - node.t) <= 0.3 && (!st || Math.abs(s.t - node.t) < Math.abs(st.t - node.t))) st = s;
			if (st) p = anc.find((a) => a.id === st.anchor) || p;
		}
		chain.unshift({ node, p, st });
		if (p.id === 1) break;
		node = p;
	}
	agg.traced++;
	for (const { node, p, st } of chain) {
		const span = node.t - p.t;
		const edge = st ? st.edge : (node.id === 'route' ? 'trophy' : null);
		const ts = st ? st.t - st.ms / 1000 : node.t;
		let esc = 0;
		for (const s of steps) if (s !== st && s.anchor === p.id && edge && s.edge === edge && !s.ok && s.t <= ts + 0.2) { esc += s.ms / 1000; agg.escR[s.rung | 0] += s.ms / 1000; }
		const win = st ? st.ms / 1000 : 0, wait = Math.max(0, span - esc - win);
		const tool = st ? (st.tool || '-') : (node.id === 'route' ? 'route' : 'import');
		row.legs.push({ label: node.label, from: p.id, rung: st ? st.rung : null, tool, win: +win.toFixed(1), esc: +esc.toFixed(1), wait: +wait.toFixed(1), span: +span.toFixed(1) });
		agg.esc += esc; agg.win += win; agg.wait += wait; agg.links++;
		if (st) agg.rungs[st.rung | 0]++;
		if (tool === 'import') agg.imp++;
		agg.tools[tool] = (agg.tools[tool] || 0) + 1;
	}
	out.push(row);
}
out.sort((a, b) => (a.first == null ? 1e9 : a.first) - (b.first == null ? 1e9 : b.first));
if (asJson) { console.log(JSON.stringify({ rows: out, agg })); process.exit(0); }
for (const r of out) {
	if (r.first == null) { console.log('     -', r.f); continue; }
	const s = r.legs.map((l) => `${l.label.slice(0, 16)}${l.rung != null ? ' r' + l.rung : ''}:${l.tool.slice(0, 6)} ${l.span}=e${l.esc}+w${l.win}+q${l.wait}`).join(' | ');
	console.log(String(r.first).padStart(6), r.f.slice(0, 34).padEnd(34), r.how.slice(0, 28).padEnd(28), s);
}
for (const k of ['esc', 'win', 'wait', 'first']) agg[k] = +agg[k].toFixed(1);
agg.escR = agg.escR.map((x) => +x.toFixed(1));
console.log(JSON.stringify(agg));

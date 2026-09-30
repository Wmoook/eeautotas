'use strict';
// N4U semantics: which door semantics do the known routes actually USE? Per route, every tick, the tiles the ball's
// 16x16 box overlaps: per door kind the ticks spent overlapping one (the ball inside / passing the door), and the
// timing facts the compiler must model: a coin / blue coin gate overlapped while the count already reaches it (the
// gate held open by its snapshot), the count-gate snapshot lag (ticks with shown != count, the longest streak), a key
// door / gate passed and the key's ticks left then, a time door passed and its phase, death doors / gates passed.
// node tools/n4u/doorstats.js [--root=] [--out=]
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const E = require(path.join(REPO, 'src', 'eesim.js'));
const TS = require(path.join(REPO, 'src', 'plan', 'truthset.js'));
const B = require(path.join(REPO, 'src', 'blocks.js'));
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const root = arg('root', process.env.EEAT_TRUTH_ROOT || 'C:\\Users\\super\\eeautotas');
const outDir = arg('out', path.join(REPO, 'src', 'out', 'n4plan', 'understand', 'semantics'));
const KEYDOOR = new Map([[23, 0], [24, 1], [25, 2], [26, 0], [27, 1], [28, 2], [1005, 3], [1006, 4], [1007, 5], [1008, 3], [1009, 4], [1010, 5]]);
const agg = new Map();   // door id -> {routes:Set, levels:Set, ticks, passes}
const facts = { routes: 0, gateHeldOpen: 0, gateHeldRoutes: new Set(), lagTicks: 0, lagMax: 0, lagRoutes: new Set(), keyPass: [], keyGatePassWhileOn: 0, timePass: 0, timeRoutes: new Set(), deathPass: 0, ticks: 0 };
for (const e of TS.knownRoutes({ root })) {
	const tr = TS.loadTruth(e);
	if (!tr) continue;
	facts.routes++;
	const L = tr.L, W = L.width, H = L.height, fg = L.fg, masks = tr.masks;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let lag = 0, prevIn = new Set();
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		facts.ticks++;
		if ((L.hasCoinGate && sim._show_coin_gate !== sim.coins) || (L.hasBlueCoinGate && sim._show_blue_coin_gate !== sim.blue_coins)) { lag++; facts.lagTicks++; facts.lagRoutes.add(e.route); if (lag > facts.lagMax) facts.lagMax = lag; } else lag = 0;
		if (sim.is_dead) { prevIn = new Set(); continue; }
		const x0 = Math.floor(sim.px) >> 4, y0 = Math.floor(sim.py) >> 4;
		const x1 = Math.floor(sim.px + 15.999) >> 4, y1 = Math.floor(sim.py + 15.999) >> 4;
		const inNow = new Set();
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const i = y * W + x, id = fg[i];
			if (!id || (L.flags[id] & 16) === 0) continue;   // doors only
			inNow.add(i);
			let a = agg.get(id);
			if (!a) { a = { routes: new Set(), levels: new Set(), ticks: 0, passes: 0 }; agg.set(id, a); }
			a.routes.add(e.route); a.levels.add(e.name); a.ticks++;
			if (!prevIn.has(i)) {
				a.passes++;
				const p = L.lookup0[i];
				if ((id === 165 && sim.coins >= p) || (id === 214 && sim.blue_coins >= p)) { facts.gateHeldOpen++; facts.gateHeldRoutes.add(e.route); }
				if (KEYDOOR.has(id)) {
					const c = KEYDOOR.get(id), on = (sim._keysMask >> c) & 1;
					if (on && ((id >= 26 && id <= 28) || id >= 1008)) facts.keyGatePassWhileOn++;
					if (on) facts.keyPass.push(Math.max(0, sim._kt[c] + 500 - sim._ticks));
				}
				if (id === 156 || id === 157) { facts.timePass++; facts.timeRoutes.add(e.route); }
				if (id === 1011 || id === 1012) facts.deathPass++;
			}
		}
		prevIn = inNow;
	}
}
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const Lines = [`# Doors the known routes pass (${facts.routes} routes, ${facts.ticks} ticks; the ball's box overlapping a door tile)`, '',
	'| door id | name | routes | levels | passes (box enters the tile) | box-ticks on it |', '|---|---|---|---|---|---|'];
for (const [id, a] of [...agg.entries()].sort((x, y) => y[1].routes.size - x[1].routes.size)) {
	const k = B.kindOf(id);
	Lines.push(`| ${id} | ${k.sub || k.kind} | ${a.routes.size} | ${a.levels.size} | ${a.passes} | ${a.ticks} |`);
}
Lines.push('', `- coin / blue coin GATE entered while the count already reaches it (held open by the lagging snapshot or passed at the 1-tick lag): ${facts.gateHeldOpen} entries on ${facts.gateHeldRoutes.size} routes`,
	`- count-gate snapshot != count: ${facts.lagTicks} ticks on ${facts.lagRoutes.size} routes, longest streak ${facts.lagMax} ticks`,
	`- key doors / gates entered while their key is on: ${facts.keyPass.length}; ticks left on the key then: min ${q(facts.keyPass, 0)}, p10 ${q(facts.keyPass, 0.1)}, median ${q(facts.keyPass, 0.5)}; key GATES entered while the key is on (overlap-held, the engine keeps the key alive while the box is in its doors): ${facts.keyGatePassWhileOn}`,
	`- time doors / gates entered: ${facts.timePass} on ${facts.timeRoutes.size} routes; death doors / gates entered: ${facts.deathPass}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'doorstats.md'), Lines.join('\n') + '\n');
console.log(Lines.join('\n'));

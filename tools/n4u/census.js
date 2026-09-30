'use strict';
// N4U semantics: the block census of the benchmark levels (every block id + its args on layer 0, per level and total).
// node tools/n4u/census.js [--root=<checkout with src/out/god/levels>] [--out=<dir>] -> census.json + census.md. Read only.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const TS = require(path.join(REPO, 'src', 'plan', 'truthset.js'));
const T = require(path.join(REPO, 'src', 'plan', 'types.js'));
const B = require(path.join(REPO, 'src', 'blocks.js'));
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const root = arg('root', process.env.EEAT_TRUTH_ROOT || path.join(REPO));
const outDir = arg('out', path.join(REPO, 'src', 'out', 'n4plan', 'understand', 'semantics'));
fs.mkdirSync(outDir, { recursive: true });
const levels = TS.levelFiles({ root });
// ids whose lookup int (the block's arg) matters to the engine
const ARG_IDS = new Set([43, 165, 213, 214, 1011, 1012, 113, 184, 185, 467, 1079, 1080, 1619, 1620, 423, 1027, 1028, 417, 418, 419, 420, 421, 422, 453, 461, 1517, 1584, 1618,
	1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1155, 1041, 1042, 1043, 1075, 1076, 1077, 1078, 1101, 1102, 1103, 1104, 1105, 1116, 1117, 1118, 1119, 1120, 1121, 1122, 1123, 1124, 1125, 1140, 1141,
	361, 1580, 1625, 1626, 1627, 1628, 1629, 1630, 1631, 1632, 1633, 1634, 1635, 1636, 1582, 242, 381, 374, 1518, 1519, 411, 412, 413, 414, 1, 2, 3, 4, 1064]);
const tot = new Map();   // id -> {levels, tiles, args: Map(arg -> tiles)}
const per = [];
const failed = [];
for (const lv of levels) {
	let L;
	try { L = T.loadLevelFile(lv.file); } catch (e) { failed.push(lv.name + ': ' + e.message); continue; }
	const N = L.width * L.height, seen = new Map();
	for (let i = 0; i < N; i++) {
		const id = L.fg[i];
		if (!id) continue;
		let s = seen.get(id);
		if (!s) { s = { tiles: 0, args: new Map() }; seen.set(id, s); }
		s.tiles++;
		if (ARG_IDS.has(id)) { const a = L.lookup0[i]; s.args.set(a, (s.args.get(a) || 0) + 1); }
	}
	let portals = 0, portalRand = 0;
	for (let i = 0; i < N; i++) if (L.fg[i] === 242 || L.fg[i] === 381) { portals++; const s = L.portalSlot[i]; if (s >= 0) { const l = L.portalsById.get(L.pTarget[s]); if (l && l.n > 1 && L.pTarget[s] !== L.pId[s]) portalRand++; } }
	const rec = { name: lv.name, set: lv.set, W: L.width, H: L.height, gravity: L.gravityMult, start: L.startMode, spawns: L.spawnsX.length, ids: {}, portals, portalRand, multiTarget: L.multiTargetPortals,
		hasTimeDoors: L.hasTimeDoors, hasDeathDoor: L.hasDeathDoor, coinTiles: L.coinTiles.length, bgPortalEntries: L.pId.length - portals };
	for (const [id, s] of seen) {
		rec.ids[id] = { tiles: s.tiles, args: s.args.size ? Object.fromEntries(s.args) : undefined };
		let t = tot.get(id);
		if (!t) { t = { levels: 0, tiles: 0, args: new Map(), names: [] }; tot.set(id, t); }
		t.levels++; t.tiles += s.tiles; if (t.names.length < 6) t.names.push(lv.name);
		for (const [a, c] of s.args) t.args.set(a, (t.args.get(a) || 0) + c);
	}
	per.push(rec);
}
const rows = [...tot.entries()].sort((a, b) => a[0] - b[0]).map(([id, t]) => {
	const k = B.kindOf(id);
	return { id, name: B.blockName(id), kind: k.kind + (k.dir ? ' ' + k.dir : '') + (k.sub ? ' ' + k.sub : ''), levels: t.levels, tiles: t.tiles,
		args: t.args.size ? [...t.args.entries()].sort((a, b) => a[0] - b[0]) : null, examples: t.names };
});
const out = { root, levels: levels.length, loaded: per.length, failed, rows, per };
fs.writeFileSync(path.join(outDir, 'census.json'), JSON.stringify(out));
const byKind = new Map();
for (const r of rows) { const k = r.kind; if (!byKind.has(k)) byKind.set(k, []); byKind.get(k).push(r); }
const lines = [`# Block census: ${per.length} of ${levels.length} benchmark levels (layer 0)`, '', '| kind | id | name | levels | tiles | args (value:tiles) |', '|---|---|---|---|---|---|'];
for (const [k, rs] of [...byKind.entries()].sort()) for (const r of rs) {
	const a = r.args ? r.args.slice(0, 20).map(([v, c]) => `${v}:${c}`).join(' ') + (r.args.length > 20 ? ` ... (${r.args.length} values)` : '') : '';
	lines.push(`| ${k} | ${r.id} | ${r.name} | ${r.levels} | ${r.tiles} | ${a} |`);
}
lines.push('', `levels with: time doors ${per.filter((p) => p.hasTimeDoors).length}, death doors ${per.filter((p) => p.hasDeathDoor).length}, random portals ${per.filter((p) => p.multiTarget).length}, background portal entries ${per.filter((p) => p.bgPortalEntries > 0).length}`,
	`gravity != 1: ${per.filter((p) => p.gravity !== 1).map((p) => p.name + '=' + p.gravity).join(', ') || 'none'}`, `start modes: ${[...new Set(per.map((p) => p.start))].join(',')}`, `failed: ${failed.join('; ') || 'none'}`);
fs.writeFileSync(path.join(outDir, 'census.md'), lines.join('\n') + '\n');
console.log(`levels ${levels.length} loaded ${per.length} failed ${failed.length}; ids ${rows.length}`);

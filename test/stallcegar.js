'use strict';
// The stall's refutation (editor.js stallCegarCheck, steer.js buildSteer opts.refute / walls / features, stallBlocker):
// ordering only. node test/stallcegar.js
//  - a gate the field does not model, named by the stall: forced (a coin door: the coin plan at least its count)
//  - any other blocker: an ordering wall; the start and the trophy are never walled; the field's cost along a walled
//    way rises (another way ranks first)
//  - stallBlocker: the descent's first tile no attempt entered; none when the descent stays on entered tiles
//  - no refutation: the same field, byte for byte
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const SF = require('../src/steer.js');
const G = require('../src/gpu.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const ID = { '#': [9], S: [255], T: [121], $: [100], c: [43, 2] };
function ascii(rows) {
	const H = rows.length, W = rows[0].length, cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '.') return; const v = ID[ch]; if (!v) throw new Error(`legend ${ch}`); cells.push([x, y, ...v]); }));
	return { buf: ED.eelvlOf({ name: 't', width: W, height: H, cells }), W, H };
}
const levelOf = (buf) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
const fp = (L) => { try { return G.blobFp(G.levelBlob(L)); } catch (e) { return null; } };

// (1) a coin door (2 coins) before the trophy, the coins on the far left
{
	const w = 40, mid = '.'.repeat(w - 2);
	const floor = [...mid]; floor[1] = '$'; floor[3] = '$'; floor[18] = 'S'; floor[w - 6] = 'c'; floor[w - 4] = 'T';
	const top = [...mid]; top[w - 6] = 'c';
	const t = `#${top.join('')}#`;
	const r = ascii(['#'.repeat(w), t, t, t, t, `#${floor.join('')}#`, '#'.repeat(w)]);
	const L = levelOf(r.buf);
	const door = 5 * w + (w - 5);
	const st = SF.buildSteer(L, { refute: { tiles: [door], modeled: [] } });
	check('a gate the field does not model: named by the stall (coins)', st.info.refuted && st.info.refuted.kind === 'gate' && st.info.refuted.feat === 'coins', JSON.stringify(st.info.refuted));
	check('the coin door\'s count: the coin plan at least 2', !!st.dp && st.dp.T >= 2, st.dp ? st.dp.T : 'no DP');
	const st2 = SF.buildSteer(L, { refute: { tiles: [door], modeled: ['coins'] } });
	check('a gate the field models already: no gate refutation (an ordering wall)', st2.info.refuted && st2.info.refuted.kind === 'wall', JSON.stringify(st2.info.refuted));
}
// (2) a plain room: the trophy on the right; an ordering wall across the floor rows forces the way over it
{
	const w = 40, mid = '.'.repeat(w - 2);
	const floor = [...mid]; floor[3] = 'S'; floor[w - 4] = 'T';
	const t = `#${mid}#`;
	const r = ascii(['#'.repeat(w), t, t, t, t, `#${floor.join('')}#`, '#'.repeat(w)]);
	const L = levelOf(r.buf);
	const st0 = SF.buildSteer(L);
	const stE = SF.buildSteer(L, {});
	check('no refutation: the same field, byte for byte', Buffer.compare(SF.steerFileBytes(st0, fp(L)), SF.steerFileBytes(stE, fp(L))) === 0 && st0.info.refuted === null);
	const sim = new E.EESim(L); sim.reset();
	const c0 = SF.steerFifths(st0, sim);
	const col = [];
	for (let y = 3; y <= 5; y++) col.push(y * w + 20);
	const trophy = 5 * w + (w - 3), start = 5 * w + 4;
	const stW = SF.buildSteer(L, { walls: [...col, trophy, start] });
	const c1 = SF.steerFifths(stW, sim);
	check('an ordering wall on the way: the cost at the start rises (the way over it)', c1 > c0, `${c0} -> ${c1}`);
	check('the trophy and the start are never walled', !stW.info.walls.includes(trophy) && !stW.info.walls.includes(start) && stW.info.walls.length === 3, JSON.stringify(stW.info.walls));
	const stR = SF.buildSteer(L, { refute: { tiles: [5 * w + 10, 5 * w + 11], modeled: [] } });
	check('a blocker that is no gate: an ordering wall at its first tile', stR.info.refuted && stR.info.refuted.kind === 'wall' && stR.info.refuted.x === 10 && stR.info.refuted.y === 5, JSON.stringify(stR.info.refuted));
	// stallBlocker: from the start, nothing entered but the start: the descent's first tile toward the trophy
	const N = w * 7;
	const ent = new Uint8Array(N); ent[start] = 1;
	const b = SF.stallBlocker(st0, sim, ent, 8);
	check('stallBlocker: the first tile of the descent no attempt entered', !!b && b.tiles.length > 0 && b.tiles[0] % w > 4, b ? JSON.stringify(b.tiles.map((q) => [q % w, Math.floor(q / w)])) : 'null');
	// every tile of the descent entered and the descent goes on: nothing to refute
	const all = new Uint8Array(N).fill(1);
	const b2 = SF.stallBlocker(st0, sim, all, 8);
	check('stallBlocker: the descent on entered tiles, still descending: nothing', b2 === null, JSON.stringify(b2));
	// a refuted field is still a field: a value at the start, the trophy 0
	check('the refuted field has a value at the start', SF.steerFifths(stR, sim) >= 0, SF.steerFifths(stR, sim));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

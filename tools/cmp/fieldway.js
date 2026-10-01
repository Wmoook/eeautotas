'use strict';
// THE GOAL FIELD'S WAY: the cheapest way an RCH3 goal field (src/reach.js reachField) prices from a real engine state to a
// goal, by the field's own model (its edgesOf / costOf: a greedy descent over the abstract states (tile, type, level),
// each step the successor of least cost + edge price, never a state twice). It names the relaxation a false near or a
// plan's cheap target rests on: the states where a rise is carried (R / C / XR levels kept sideways or up a field) and
// the portal hops (non-adjacent tiles). The state is the route prefix's own (the engine replays it); the level copy is
// the executor's (types.js levelNow: every door a touch alone changes as it stands; the protection layer's unprotected
// half is left out: the way is the protected field's).
//   node tools/cmp/fieldway.js <level.eelvl> <prefix.txt | -> [trophy | x,y] [--opts='{"exitApex":true}'] [--defaults=1]
// <prefix.txt>: the route prefix as '0'+mask characters (an anchor dump's inputs), '-' = the level start. --opts: extra
// reachField options (e.g. exitApex: the field transit tables, sideCap). --defaults=1 (the default): the compiler's
// default knobs (src/plan/defaults.js) as a compile applies them. Prints the start, the executor's goalField cost, this
// field's cost, then the way as tile type level : cost-to-go (tiles), ' ==HOP==> ' at a teleport.
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (const a of argv) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) flags[m[1]] = m[2]; else pos.push(a); }
if (flags.defaults !== '0') require(path.join(root, 'src/plan/defaults.js')).apply();
const RF = require(path.join(root, 'src/reach.js'));
const T = require(path.join(root, 'src/plan/types.js'));
if (pos.length < 1) { console.error('usage: fieldway.js <level.eelvl> <prefix.txt | -> [trophy | x,y] [--opts=<json>]'); process.exit(2); }
const L = T.loadLevelFile(pos[0]);
const W = L.width;
let masks = new Uint8Array(0);
if (pos[1] && pos[1] !== '-') masks = Uint8Array.from(fs.readFileSync(pos[1], 'utf8').trim(), (ch) => (ch.charCodeAt(0) - 48) & 31);
const sim = T.playTo(L, masks, { allowDeath: true }).sim;
const Lc0 = T.levelNow(L, sim);
const Lc = Object.assign({}, Lc0); delete Lc._unprot;
const g = pos[2] || 'trophy';
let goals = [];
if (g === 'trophy') { for (let i = 0; i < Lc.fg.length; i++) if (Lc.fg[i] === 121) goals.push(i); }
else { const [x, y] = g.split(',').map(Number); goals = [y * W + x]; }
const xo = flags.opts ? JSON.parse(flags.opts) : {};
const xy = (t) => `(${t % W},${(t / W) | 0})`;
console.log('start', xy(T.tileOf(sim, W, L.height)), 'tick', masks.length, 'v', sim.speed_x.toFixed(2), sim.speed_y.toFixed(2), 'goals', goals.slice(0, 4).map(xy).join(''), goals.length > 4 ? `(+${goals.length - 4})` : '');
console.log('goalField (the executor\'s) cost', RF.costAt(T.goalField(Lc0, goals, {}), sim));
const f = RF.reachField(Lc, Object.assign({ goals: goals.map((t) => ({ tile: t, cost: 0 })), deaths: false, debug: true }, xo));
if (!f._m) { console.log('no physics model (walk mode): the way is the walk'); process.exit(0); }
const m = f._m;
const st = RF.stateOf(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
const starts = st ? [...(st.base ? [st.base] : []), ...(st.rise || [])] : [];
console.log('field cost', RF.costAt(f, sim), 'opts', JSON.stringify(xo));
let cur = null, c = Infinity;
for (const [ty, l] of starts) { const v = m.costOf(st.t, ty, l); if (v < c) { c = v; cur = [st.t, ty, l]; } }
if (!cur || c >= 0xfffe) { console.log('no way: the start is cut off (or far)'); process.exit(0); }
const goalSet = new Set(goals), seen = new Set(), out = [];
const key = (t, ty, l) => `${t}.${ty}.${l}`;
for (let n = 0; cur && n < 50000; n++) {
	const [t, ty, l] = cur;
	seen.add(key(t, ty, l));
	out.push([t, `${xy(t)}${'RFXCL'[ty] || ty}${l}:${(c / 5).toFixed(1)}`]);
	if (goalSet.has(t) || c === 0) break;
	let nx = null, nc = Infinity;
	m.edgesOf(t, ty, l, (t2, ty2, l2, add) => {
		if (seen.has(key(t2, ty2, l2))) return;
		const c2 = m.costOf(t2, ty2, l2);
		if (c2 >= 0xfffe) return;
		if (c2 + add < nc || (c2 + add === nc && t2 !== t)) { nc = c2 + add; nx = [t2, ty2, l2]; }
	});
	if (!nx || nc > c + 0.5) { out.push([-1, `STOP (next ${nc}, here ${c})`]); break; }
	cur = nx; c = m.costOf(nx[0], nx[1], nx[2]);
}
const line = [];
let prev = -1;
for (const [t, s] of out) {
	if (t >= 0 && prev >= 0 && (Math.abs((t % W) - (prev % W)) > 1 || Math.abs(((t / W) | 0) - ((prev / W) | 0)) > 1)) line.push(' ==HOP==> ');
	line.push(s);
	if (t >= 0) prev = t;
}
console.log(out.length, 'states');
console.log(line.join(' '));

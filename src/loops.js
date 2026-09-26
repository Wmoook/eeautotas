'use strict';
// Loops of a run: stretches (a -> b) where the ball comes back to within --radius px of where it was, with nothing
// collected or toggled in between (no key, switch, checkpoint, team, effect, death; no coin when the coins count).
// Such a stretch is a detour: whatever the run did in between may be skippable, and the explorer searched on exactly
// that window (from a little before a to a little after b, exact rejoins) finds the skip directly instead of by luck
// (OC's Octorage: loop #1 is the -350 route skip, found in 47 s on one thread with this window).
//
// revisits(level, masks, {coins, radius, min, max, keep}) -> [{a, b, len, x, y}] (tiles), longest first, disjoint.
// CLI: node src/loops.js <job> [run.eetas] [--radius=48] [--min=100] [--max=900] [--keep=12]
const C = require('./common.js');

const MOVE = new Set(['land', 'jump', 'gravity_changed', 'portal', 'complete', 'door_state']);

function revisits(level, masks, opts) {
	const o = Object.assign({ coins: true, radius: 48, min: 100, max: 900, keep: 12, step: 2 }, opts || {});
	const tr = C.replay(level, masks, { trace: true });
	const n = tr.complete >= 0 ? tr.complete : masks.length;
	const prog = new Int32Array(n + 2);
	for (const e of tr.events) {
		if (e.t > n || MOVE.has(e.kind)) continue;
		if (!o.coins && (e.kind === 'coin' || e.kind === 'blue_coin')) continue;
		prog[e.t]++;
	}
	const cum = new Int32Array(n + 2);   // cum[t] = progress events at ticks < t
	for (let t = 1; t <= n + 1; t++) cum[t] = cum[t - 1] + prog[t - 1];
	const X = tr.X, Y = tr.Y;
	const found = [];
	for (let a = 0; a < n; a += o.step) {
		for (let b = Math.min(n, a + o.max); b > a + o.min; b--) {
			if (Math.abs(X[b] - X[a]) + Math.abs(Y[b] - Y[a]) >= o.radius) continue;
			if (cum[b] - cum[a + 1] !== 0) continue;
			// (a wait is not a loop: the ball must go somewhere in between)
			let far = 0;
			for (let t = a; t <= b; t += 4) far = Math.max(far, Math.abs(X[t] - X[a]) + Math.abs(Y[t] - Y[a]));
			if (far >= 3 * 16) found.push({ a, b, len: b - a, x: +(X[a] / 16).toFixed(1), y: +(Y[a] / 16).toFixed(1) });
			break;
		}
	}
	found.sort((p, q) => q.len - p.len || p.a - q.a);
	const kept = [];
	for (const f of found) {
		if (kept.some((k) => !(f.b <= k.a || f.a >= k.b))) continue;
		kept.push(f);
		if (kept.length >= o.keep) break;
	}
	return kept;
}

module.exports = { revisits };

if (require.main === module) {
	const J = require('./jobs.js');
	const args = process.argv.slice(2).filter((s) => !s.startsWith('--'));
	const opt = {};
	for (const s of process.argv.slice(2)) { const m = s.match(/^--(\w+)=(.*)$/); if (m) opt[m[1]] = +m[2]; }
	const id = J.resolve(args[0]);
	const level = J.loadJobLevel(id);
	const ms = C.readEetas(args[1] || `${J.jobDir(id)}/best.eetas`);
	const st = C.readJSON(`${J.jobDir(id)}/status.json`, {});
	const loops = revisits(level, ms, Object.assign({ coins: !st.coinsOptional }, opt));
	for (const [i, l] of loops.entries()) console.log(`${i + 1}. ticks ${l.a}-${l.b} (${l.len}): comes back to (${l.x}, ${l.y})`);
}

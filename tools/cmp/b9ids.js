// node tools/cmp/b9ids.js <compile events.jsonl> ...: the switch-chain progress of a compile (a diagnosis aid): the
// largest purple-switch id set one source (room) held, its tick, and (V=1) the time / tick each id first entered the
// best-so-far set
const fs = require('fs');
for (const f of process.argv.slice(2)) {
	let L;
	try { L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { console.log(f, 'missing'); continue; }
	let best = new Set(), bestTick = 0, bestT = 0, tEnd = 0, done = null;
	const first = new Map();
	for (const e of L) {
		if (e.t) tEnd = e.t;
		if (e.ev === 'done') done = e;
		if (e.ev !== 'source') continue;
		const m = /purple=\[([^\]]*)\]/.exec(e.desc || ''); const ids = m && m[1] ? m[1].split(',').map(Number) : [];
		if (ids.length > best.size) {
			best = new Set(ids); bestTick = e.tick; bestT = e.t || 0;
			for (const i of ids) if (!first.has(i)) first.set(i, [Math.round(e.t || 0), e.tick]);
		}
	}
	const ids = [...best].sort((a, b) => a - b);
	console.log(`${f.split(/[\\/]/).pop()} t=${Math.round(tEnd)}s ${done ? 'done ' + done.end : 'running'}: ${ids.length} ids (chain 1-54: ${ids.filter((i) => i <= 54).length}) at ${Math.round(bestT)} s, tick ${bestTick}: [${ids.join(',')}]`);
	if (process.env.V) console.log('  first: ' + [...first].sort((a, b) => a[1][0] - b[1][0]).map(([i, [t, k]]) => `${i}@${t}s/${k}`).join(' '));
}

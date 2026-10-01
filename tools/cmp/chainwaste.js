// node tools/cmp/chainwaste.js <compile events.jsonl> ...: worker time on steps (and stretch legs) whose target purple switch the leader already held
// (the best chain-id set seen in source events so far), vs steps on switches the leader lacked; per run
const fs = require('fs');
for (const f of process.argv.slice(2)) {
	let L;
	try { L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { console.log(f, 'missing'); continue; }
	let best = new Set();
	let wasteMs = 0, wasteN = 0, wasteOk = 0, frontMs = 0, frontN = 0, frontOk = 0, otherMs = 0, stW = 0, stF = 0, stO = 0;
	const stReq = new Map();
	let tEnd = 0;
	// (the leader's set at a time: the best set of the source events before it; a step is judged at its START)
	const hist = [[0, new Set()]];
	for (const e of L) if (e.ev === 'source') {
		const m = /purple=\[([^\]]*)\]/.exec(e.desc || ''); const ids = m && m[1] ? m[1].split(',').map(Number) : [];
		if (ids.length > hist[hist.length - 1][1].size) hist.push([e.t || 0, new Set(ids)]);
	}
	const heldAt = (t) => { let s = hist[0][1]; for (const [tt, ss] of hist) { if (tt <= t) s = ss; else break; } return s; };
	for (const e of L) {
		if (e.t) tEnd = e.t;
		if (e.ev === 'source') {
			const m = /purple=\[([^\]]*)\]/.exec(e.desc || ''); const ids = m && m[1] ? m[1].split(',').map(Number) : [];
			if (ids.length > best.size) best = new Set(ids);
		}
		if (e.ev === 'step') {
			const m = /^purple switch (\d+) /.exec(e.label || '');
			if (!m) { otherMs += e.ms || 0; continue; }
			const id = +m[1];
			if (heldAt((e.t || 0) - (e.ms || 0) / 1000).has(id)) { wasteMs += e.ms || 0; wasteN++; if (e.ok) wasteOk++; } else { frontMs += e.ms || 0; frontN++; if (e.ok) frontOk++; }
		}
		if (e.ev === 'stretch' && e.what === 'request') stReq.set(e.id, { legs: e.legs || [], held: heldAt(e.t || 0) });
		if (e.ev === 'stretch' && e.what === 'done') {
			const q = stReq.get(e.id); if (!q) continue;
			const m = /^purple switch (\d+) /.exec(String(q.legs[0] || ''));
			if (!m) stO += e.ms || 0; else if (q.held.has(+m[1])) stW += e.ms || 0; else stF += e.ms || 0;
		}
	}
	console.log(`${f.padEnd(14)} t ${Math.round(tEnd)} ids ${best.size} | switch steps on held ids: ${wasteN} (${wasteOk} ok) ${Math.round(wasteMs / 1000)} s | on new ids: ${frontN} (${frontOk} ok) ${Math.round(frontMs / 1000)} s | other ${Math.round(otherMs / 1000)} s | stretch held ${Math.round(stW / 1000)} s new ${Math.round(stF / 1000)} s other ${Math.round(stO / 1000)} s`);
}

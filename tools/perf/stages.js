'use strict';
// the compile reports' stage times (n5-perfect): per routed level the run ticks, lb, the proof, and the moves / perfect /
// polish / prove ms.  node tools/perf/stages.js <reports dir> ...
const fs = require('fs');
const path = require('path');
for (const dir of process.argv.slice(2)) {
	for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
		let r;
		try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
		if (!r || !r.ok) continue;
		const s = r.stages || {};
		console.log(`${f.replace('.json', '').padEnd(46)} ${String(r.runTicks).padStart(6)} lb ${String(r.lb).padStart(5)} moves ${s.moves} perfect ${s.perfect || 0} polish ${s.polish} prove ${s.prove} ${r.lbProof ? 'PROOF ' + String(r.lbProof).slice(0, 50) : ''}`);
	}
}

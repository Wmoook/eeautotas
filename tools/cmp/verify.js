'use strict';
// An independent check of the compiler's outputs: every .eetas of a full-compile dir (tools/cmp/fullc.js) read back
// as raw bytes (common.js readEetas) and replayed by the engine from the level file alone (common.js evaluate, the
// level as src/compile.js loads it: plan/types.js loadLevelFile): it must finish, at the run ticks its report says.
//   node tools/cmp/verify.js <dir> <levels dir>
const fs = require('fs'), path = require('path');
const C = require('../../src/common.js');
const T = require('../../src/plan/types.js');
const [, , dir, lvDir] = process.argv;
let ok = 0, bad = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.eetas'))) {
	const id = f.replace(/\.eetas$/, '');
	let rep = null;
	try { rep = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch (e) { rep = null; }
	const rel = id.replace(/__/g, '/') + '.eelvl';
	const L = T.loadLevelFile(path.join(lvDir, rel));
	const masks = C.readEetas(path.join(dir, f));
	const ev = C.evaluate(L, masks);
	const want = rep ? rep.runTicks : null;
	const good = !!ev && (want === null || ev.runTicks === want);
	if (good) ok++; else bad++;
	console.log(`${good ? 'ok  ' : 'FAIL'} ${rel}: ${masks.length} bytes, ${ev ? `finishes, ${ev.runTicks} run ticks, ${ev.deaths} deaths, chance ${ev.chance}` : 'does NOT finish'}${want !== null ? ` (report ${want})` : ''}`);
}
console.log(`verified ${ok}, failed ${bad}`);
process.exit(bad ? 1 : 0);

'use strict';
// THE TRUTH PACK LIST (n5-tricks): the files the known routes need (truthset.js knownRoutes + loadTruth + levelFiles),
// relative to the truth root, one a line: `tar -C <root> -czf truth.tgz -T <list>` copies the truth set to a box.
// READ ONLY (it never writes into the root).
// Usage: EEAT_TRUTH_ROOT=<main checkout> node tools/tricks/truthpack.js <list.txt>
const path = require('path'), fs = require('fs');
const TS = require('../../src/plan/truthset.js');
const root = path.resolve(process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..', '..'));
const ks = TS.knownRoutes({ root });
const files = new Set();
for (const k of ks) {
	files.add(k.route); files.add(k.levelFile);
	if (k.jobId) {
		const jd = path.dirname(k.route);
		files.add(path.join(jd, 'meta.json'));
		try {
			const m = JSON.parse(fs.readFileSync(path.join(jd, 'meta.json'), 'utf8'));
			const lj = path.join(jd, '..', '..', 'data', m.levelId + '.json');
			if (fs.existsSync(lj)) files.add(lj);
		} catch (e) { /* none */ }
	}
}
for (const l of TS.levelFiles({ root })) files.add(l.file);
let sz = 0; const rel = [];
for (const f of files) { sz += fs.statSync(f).size; rel.push(path.relative(root, f).replace(/\\/g, '/')); }
console.error(`${ks.length} routes, ${files.size} files, ${(sz / 1e6).toFixed(1)} MB`);
fs.writeFileSync(process.argv[2], rel.join('\n') + '\n');

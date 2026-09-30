'use strict';
// n4u-moves helper: the files the truthset needs on a box (the routes, their levels, the jobs' meta + level JSON), as
// paths relative to the root: node src/plan/understand/listfiles.js <root> <out.txt>. Third-party files: never into git.
const path = require('path'), fs = require('fs');
const TS = require('../truthset.js');
const root = path.resolve(process.argv[2]);
const all = TS.knownRoutes({ root });
const files = new Set();
for (const e of all) {
	files.add(e.route); files.add(e.levelFile);
	if (e.jobId) {
		const jd = path.dirname(e.route); const mf = path.join(jd, 'meta.json');
		if (fs.existsSync(mf)) { files.add(mf); try { const m = JSON.parse(fs.readFileSync(mf, 'utf8')); const lj = path.join(root, 'src', 'data', m.levelId + '.json'); if (m.levelId && fs.existsSync(lj)) files.add(lj); } catch (x) { /* none */ } }
	}
}
for (const l of TS.levelFiles({ root })) files.add(l.file);
const rel = [...files].map((f) => path.relative(root, f).split(path.sep).join('/'));
fs.writeFileSync(process.argv[3], rel.join('\n') + '\n');
console.log(all.length, 'routes', rel.length, 'files');

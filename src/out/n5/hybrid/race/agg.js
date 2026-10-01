'use strict';
// agg.js <race_levels.txt> <hybrid out dir> <baseline out dir>: one JSON line per level (the hybrid's report, the search-alone baseline's)
const fs = require('fs'), path = require('path');
const [, , list, hyDir, baseDir] = process.argv;
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
for (const rel of fs.readFileSync(list, 'utf8').split('\n').filter(Boolean)) {
	const id = path.basename(rel, '.eelvl');
	const h = rd(path.join(hyDir, id, 'hybrid.json')), b = rd(path.join(baseDir, id, 'result.json'));
	const o = { rel, id };
	if (h) {
		o.hy = { ended: !!h.ended, first: h.first, final: h.final ? { runTicks: h.final.runTicks, by: h.final.by, t: h.final.t, verified: h.final.verified, deaths: h.final.deaths } : null,
			polish: h.polish, cFirst: h.compiler.firstRoute, sFirst: h.search.firstRoute, cExit: h.compiler.exit, cEnd: h.compiler.report ? { ok: h.compiler.report.ok, runTicks: h.compiler.report.runTicks, end: h.compiler.report.end, why: (h.compiler.report.why || '').slice(0, 160) } : null,
			cMaxGain: h.compiler.maxGain, cAnchors: h.compiler.anchors, cImports: h.compiler.imports, hints: h.hints.map((x) => [x.t, x.gain, x.ticks, x.escape]), feeds: h.feeds.length,
			prefix: h.prefix.map((p) => ({ t: p.t, why: p.why, gain: p.gain, routed: p.routed, nearest: p.nearest })), joins: h.joins, nearest: h.search.nearest, handoff: h.search.handoff, jobFrom: h.search.jobFrom,
			byRoutes: h.routes.filter((r) => r.verified).reduce((m, r) => { m[r.by] = Math.min(m[r.by] || Infinity, r.runTicks); return m; }, {}), errors: h.errors };
	}
	if (b) o.base = { first: b.firstRouteAfter, firstTicks: b.firstRouteTicks, final: b.final ? b.final.runTicks : null, nearest: b.find && b.find.closest ? b.find.closest.tiles : null, error: b.error };
	console.log(JSON.stringify(o));
}

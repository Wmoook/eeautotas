'use strict';
// Append-only JSON lines: the optimizer's structured stage log (docs/ui/DESIGN.md 11.1). grind.js writes
// src/jobs/<id>/grind_events.jsonl, gpusearch.js src/jobs/<id>/gpu/events.jsonl; src/phases.js reads them into the
// Optimizer view's timeline (GET /api/jobs/:id/phases). Nothing that exists changes: status.json, grind.log, history,
// live.json and gpu_status.json stay as they are; these files are extra, and a writer that fails is silent (a full disk,
// a locked file): the optimizer never notices them.
//
// open(file, {maxBytes = 8 MB, off, head}) -> { file, ev(obj), last }: ev adds `t: Date.now()` when obj has no t and appends
// JSON.stringify(obj) + '\n' (fs.appendFileSync: a line is whole when the reader sees it); a write that would take the file
// past maxBytes first renames it to <name>.1.jsonl (one old file kept) and starts the new one with o.head() (the session
// line again, marked cont: true). off (or EEAT_EVENTS=0): nothing is written. `last` = the time of the last line written.
const fs = require('fs');
const path = require('path');

const rotatedName = (file) => {
	const ext = path.extname(file);
	return ext ? file.slice(0, -ext.length) + '.1' + ext : file + '.1';
};

function open(file, o) {
	o = o || {};
	const maxBytes = Math.max(1024, +o.maxBytes || (8 << 20));
	const off = !!o.off || process.env.EEAT_EVENTS === '0';
	let size = -1, retryAt = 0;   // (a rename that failed is tried again once the file has grown 64 KB more (a 16th of the limit at most), not at every line)
	const w = {
		file,
		last: 0,
		off,
		ev(obj) {
			if (off || !obj || typeof obj !== 'object') return false;
			try {
				const rec = obj.t === undefined ? Object.assign({ t: Date.now() }, obj) : obj;
				let line = JSON.stringify(rec) + '\n';
				if (size < 0) { try { size = fs.statSync(file).size; } catch (e) { size = 0; } }
				if (size > 0 && size + Buffer.byteLength(line) > maxBytes && size >= retryAt) {
					let moved = true;
					try { fs.renameSync(file, rotatedName(file)); } catch (e) { moved = false; }
					// (in use, e.g. a reader on Windows: the file grows on and the rename is tried again later; the size stays the
					// file's, so the limit holds again once a rename works)
					if (!moved) retryAt = size + Math.min(64 << 10, maxBytes >> 4);
					else {
						size = 0; retryAt = 0;
						if (typeof o.head === 'function') {
							let h = null;
							try { h = o.head(); } catch (e) { h = null; }
							if (h && typeof h === 'object') line = JSON.stringify(Object.assign({ t: rec.t }, h, { cont: true })) + '\n' + line;
						}
					}
				}
				fs.appendFileSync(file, line);
				size += Buffer.byteLength(line);
				w.last = rec.t;
				return true;
			} catch (e) { return false; }
		},
	};
	return w;
}

/** The lines of an events file and its rotated older part, oldest first: [{...}, ...] (a broken or partial line is left
 *  out). For tests and tools; src/phases.js reads incrementally. */
function readAll(file) {
	const out = [];
	for (const f of [rotatedName(file), file]) {
		let s = '';
		try { s = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
		for (const l of s.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch (e) { /* partial */ } }
	}
	return out;
}

module.exports = { open, readAll, rotatedName };

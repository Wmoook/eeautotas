'use strict';
// The search's anatomy log (a measuring aid, OFF unless EEAT_ANAT=<dir> is set): Find a route's operators append JSON lines
// of what they did (the one search's rooms with their inputs, its events, the workers' picks per room and head, the kept
// deaths, the wall breaker's starts and ends) to files in <dir>, one per process (and per worker thread), so a run from
// the level alone can be taken apart afterwards: which rooms it spent its picks, bursts and breaker rounds on, where its
// deaths led, where it stalled. Logging only: nothing here changes what a search does (no random draws, no state).
const fs = require('fs');
const path = require('path');

const DIR = process.env.EEAT_ANAT || '';
const on = DIR !== '';
const T0 = Date.now();
if (on) { try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* the append says */ } }

/** append object o (plus the wall clock: ms since the epoch) as one line to <dir>/<name>.jsonl */
function log(name, o) {
	if (!on) return;
	try { fs.appendFileSync(path.join(DIR, `${name}.jsonl`), JSON.stringify(Object.assign({ ms: Date.now() }, o)) + '\n'); } catch (e) { /* a full disk: nothing */ }
}

module.exports = { on, log, DIR, T0 };

'use strict';
// THE TRICKS' KNOB (n5-tricks: the routes' tricks mined from the 219 known routes as general derivations of the compiler).
// One reader for every part that has a trick: EEAT_TRICKS unset = DEFAULT (the tricks measured to gain and lose nothing),
// '0' / 'none' / '' = none (the compiler before them, byte for byte), '1' / 'all' = every trick, else a comma list of names;
// a list whose first name starts with '+' adds to DEFAULT ('+warp,exh'), one with '-' names takes away from it ('-idle').
// The names (the part that reads them):
//   airjump  msolve.js: the air-jump members, a third pass of the plain tier (max_jumps > 1)
//   frame    msolve.js: the frame tier (a start inside one arrow field = the plain tier rotated) and its fan-out in chains
//   fentry   msolve.js: the field-entry composition (every verified arrival at a field's entry + the field tier from it)
//   fseed    fieldsolve.js: the seeded schedules (the 18 held masks' engine schedules) after the solver failed
//   fpull    fieldsolve.js: the pull's side (a grounded start with no floor under the new pull flies)
//   idle     polish.js: the idle shift (a rest of the route cut, the clock kept by idle ticks before the first input)
//   warp     planner.js: the death warp (an edge planned as a death when the respawn is clearly nearer)
//   exh      planner.js: exhausted -> death (an edge the exact search exhausted is offered as its death variant)
//   chain    model.js + planner.js: forced chains (a boost lane of trigger tiles as one planner trigger)
//   chaintricks  msolve.js chain(): its direct legs with the tricks above and the frame tier's fan-out (else the chain
//            tier is the one before the tricks)
// o.tricks (true / false / a list / a comma string) overrides the environment per call where a part takes options.
const NAMES = ['airjump', 'frame', 'fentry', 'fseed', 'fpull', 'idle', 'warp', 'exh', 'chain', 'chaintricks'];
const DEFAULT = '';

function parseList(v) {
	if (v === undefined || v === null || v === false) return null;
	if (v === true) return 'all';
	const list = (Array.isArray(v) ? v : String(v).split(',')).map((q) => String(q).trim()).filter(Boolean);
	if (!list.length || (list.length === 1 && (list[0] === '0' || list[0] === 'none'))) return null;
	if (list.includes('1') || list.includes('all')) return 'all';
	if (/^[+-]/.test(list[0])) {
		const base = new Set(String(DEFAULT).split(',').map((q) => q.trim()).filter(Boolean));
		for (const q of list) { const n = q.replace(/^[+-]/, ''); if (q[0] === '-') base.delete(n); else base.add(n); }
		return base.size ? base : null;
	}
	return new Set(list);
}
/** the tricks on: null (none), 'all', or a Set of names; v undefined = the environment (EEAT_TRICKS, else DEFAULT) */
function parse(v) {
	if (v === undefined) return ENV;
	return parseList(v);
}
const ENV = parseList(process.env.EEAT_TRICKS === undefined ? DEFAULT : process.env.EEAT_TRICKS);
/** is trick `name` on (o: an override, e.g. a call's o.tricks; undefined = the environment) */
function has(name, o) {
	const t = parse(o);
	return t === 'all' || (t !== null && t.has(name));
}
module.exports = { NAMES, DEFAULT, parse, has, env: ENV };

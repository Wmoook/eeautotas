'use strict';
// The N4 AUDIT steer knobs (src/steer.js, OPT-IN, default off = main byte for byte): the CEGAR past the budget
// (EEAT_CEGARPAST / opts.cegarPast), the coin tour where the coin DP has no start value (EEAT_DPTOUR / opts.dpTour), the
// build without the half-block quadrants where they leave the start without a value (EEAT_QUADFALL / opts.quadFall).
// On the campaign's own levels (local only, never in git): node test/n4steer.js [--levels=<campaign dir>]
// (default src/out/god/levels/campaign; the checks are skipped when the folder is missing). Exit code 1 on a failure.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = require('../src/eesim.js'), EL = require('../src/eelvl.js'), SF = require('../src/steer.js');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DIR = path.resolve(arg('levels', path.join(__dirname, '../src/out/god/levels/campaign')));
let pass = 0, fail = 0;
const check = (what, ok, info) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${info !== undefined ? ': ' + info : ''}`); };
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex').slice(0, 12);
const levelOf = (f) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(path.join(DIR, f))), { id: 'editor', file: 'editor.eelvl' }));
const files = (st) => [md5(SF.steerFileBytes(st, null)), md5(SF.steerFileBytes(st, null, !!(st.tour || (st.dp && st.dp.free))))].join('/');
const OFF = { cegarPast: false, dpTour: false, quadFall: false };
if (!fs.existsSync(DIR)) { console.log(`skipped: no campaign levels at ${DIR}`); process.exit(0); }
// (every knob on where none acts: the same files)
{
	const L = levelOf('01_1_Ruins.eelvl');
	const a = SF.buildSteer(L, OFF), b = SF.buildSteer(L, { cegarPast: true, dpTour: true, quadFall: true });
	check('Ruins: every knob on = off (no cut, a start value, a DP with a value)', files(a) === files(b) && !b.info.relaxed && !b.info.dpFell && !b.info.quadFell, `${files(a)} vs ${files(b)}`);
}
// (the coin tour where the DP has no start value: Bridge Builder's legs reach 3 of its 5 coins)
{
	const L = levelOf('24_1_Bridge_Builder.eelvl');
	const a = SF.buildSteer(L, OFF), b = SF.buildSteer(L, { dpTour: true });
	check('Bridge Builder: off no start value (the DP 5 / 5 with no tour from the start)', !Number.isFinite(a.info.start) && !!a.info.dp, a.info.start);
	check('Bridge Builder: dpTour a start value from the coin tour, the DP dropped, the plain file the layer bodies', Number.isFinite(b.info.start) && b.info.dpFell && !b.dp && !!b.tour && b.nPlain === b.bodies.length,
		`${Math.round(b.info.start)} tiles, tour ${b.info.tour && b.info.tour.n}/${b.info.tour && b.info.tour.T}`);
	check('Bridge Builder: the plain (GPU) file has no DP (flags 0) and the CPU file the tour (flags 2)', SF.readSteerFile(SF.steerFileBytes(b, null)).dp === null && !!SF.readSteerFile(SF.steerFileBytes(b, null, true)).tour);
}
// (the half-block quadrants: SIG?S's walk model has no way from the start with them)
{
	const L = levelOf('35_8_SIG_S.eelvl');
	const a = SF.buildSteer(L, OFF), b = SF.buildSteer(L, { quadFall: true });
	check('SIG?S: off no start value (the walk plan: start has no way)', !Number.isFinite(a.info.start));
	check('SIG?S: quadFall the build without the quadrants, a start value, info.quadFell; the env restored', Number.isFinite(b.info.start) && b.info.quadFell && process.env.EEAT_HALFQUAD === undefined,
		`${Math.round(b.info.start)} tiles, ${b.info.layers} layers ${b.info.features.join('+')}`);
}
// (the CEGAR past the budget: Evolution Revolution's coins cut first, then the purple doors by its pins' portal column)
{
	const L = levelOf('03_2_Evolution_Revolution.eelvl');
	const a = SF.buildSteer(L, OFF), b = SF.buildSteer(L, { cegarPast: true });
	check('Evolution Revolution: off only fx modelled, the coins cut', a.info.features.join('+') === 'fx' && /^coins:/.test(a.info.over || ''), `${a.info.features} / ${a.info.over}`);
	check('Evolution Revolution: cegarPast the coins relaxed, the purple switches next (psw:42, psw:55), over still the first cut', (b.info.relaxed || []).includes('coins') && b.info.features.includes('psw:42') && b.info.features.includes('psw:55') && /^coins:/.test(b.info.over || ''),
		`${b.info.features.join('+')}, relaxed ${b.info.relaxed}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

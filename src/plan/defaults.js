'use strict';
// THE COMPILER'S DEFAULT KNOBS (the doctors' synthesis, C6 push 3, 2026-09-30; src/out/n5/doctor/SYNTHESIS.md): the
// compiler's own process (src/compile.js, src/plan.js) turns these OPT-IN fixes on unless the environment names them
// (=0: off, the fix's code as before). The modules keep their own opt-in defaults (their tests and the truth checkers
// read the modules as they stand); set before any worker thread or child process starts (they copy the environment) and
// before src/plan/types.js is loaded (its FX_FIELD / FX_STATE are read when it loads).
// The 300-s A/B on n5-plan's head (box 5, ~/c6_syn/ab1-ab3; one arm of knobs vs the same tree with none):
//  - EEAT_COVER=3 (doctor 7: the coverage finder as the best-first search's fallback + the stuck skeleton's slot),
//    EEAT_CRUMBS=1 (doctor 9: coins no gate reads as breadcrumb relays of a long leg), EEAT_FIELD_MEMO=1 (doctor 9: no
//    leg call without its goal field): 7 levels compiled that the base did not (K Underground, On And On And On,
//    Crypts Of Anubis 3,194 (best known 3,374), Vignettes, Presto Penguins, Perilous Endeavor, Stone Ruin Speedrun;
//    Tutorial 3 2 of 2 vs the base 1 of 2), 4 more with more progress (The Tunnels 8 -> 34, Fall of Zeal 0 -> 26, CDB Inc,
//    Helix Reborn), no compile or progress lost; COST: the routes of Tutorial 1 (+11 / +15%) and Bygone Tutorial
//    (+48 / +14%) slower in 2 of 2 samples (the cover's random-rollout legs before the first route): WATCH.
//  - EEAT_PLAN_ANY=1 (doctor 3: the members of a set-kind trigger group are one edge) + EEAT_PLAN_UNTOGGLE=1 (doctor
//    b9: no toggle-back pair): more progress on CDB Inc 4 -> 12, hakashouseoffun 4 -> 7, Pinball Bloom 5 -> 7, Arris Dome
//    11 -> 17; NC Naos 34_1's 4 -> 0 in the first sample not repeated (3 = 3); the controls within their spread.
//  - EEAT_FX_FIELD=1 (doctor 6: the plain-ball field) + EEAT_FX_STATE=1 (doctor 10: the effect-state field) +
//    EEAT_ICE_LOCAL=1 + EEAT_PROT_LAYER=1 (doctor cold: the ice rise and the protection only where a ball can have
//    them, sound): The Witch's House compiled 2 of 2 (base 0 of 2), Tutorial 3 2 of 2 (4,252 / 4,761 vs the base's
//    6,002 / none), Eurus 2 -> 4, Ice Cream Expedition 7 -> 9; Super Mario Bros 3 and Sand Castles within the spread.
//  - EEAT_CRUMB_RANK=3 (C6 lane 5 block 2, strategy.js THE CRUMB RANK's F GATE: a crumb's gain counts in the anchor pick
//    only while the anchor's f (arrival tick + plan cost) is within 10% + 60 ticks of the least f of its real gain; box 6,
//    300 s, side by side): Tutorial 2 3,112 / 3,673 run ticks vs the base's 7,018 (every base sample 4,479-7,018; main
//    3,070-3,401; the best known 2,947), On And On 2,516 / 3,226 (base 2,823 / 3,628), Perilous Endeavor - / 5,683 (base -);
//    COST: EE mountain world 0 of 2 (the base's one run routed it at 293 s through 5 coins and blue coins, 15,233 run
//    ticks): WATCH. =2 (always out): Tutorial 2 3,133 / 3,334 / 3,960 but On And On 1 of 2; =1 (after the first route)
//    Tutorial 2 5,924.
// NOT defaults (measured, opt-in): the stones (EEAT_PLAN_STONES) and the prices (EEAT_WALL_PRICE, EEAT_PHYS_PRICE: Late
// christmas compiled, Treasure Trove Cove 7 -> 5 in 2 of 2), the cover from rung 2 (EEAT_COVER_RUNG=2: lost Stone Ruin and
// Perilous Endeavor, no control faster).
// THE CHAINS-LAB JUDGE (2026-09-30, src/out/n5/lab/JUDGE.md): EEAT_BW_LEVEL=last (the lab's backward solver on the whole
// level in a child process next to the moves stage, its route a LAST RESORT: taken only when the moves stage ends with no
// route; the moves' first route ends the child): box 5, 300 s, W3: the child's route where the base's moves found none:
// The Blank Page 2,025 (=last) / 2,011 (=1 with the corridor) vs the base 0 of 1, INVASION 4,091 (=1 with the corridor) vs
// 0 of 1, Gravity's Rainbow 2,059 (=last) / 2,019 / 2,020 (=1) vs the base's none / 3,402; none of the 28 levels the
// compile routes lost (the moves' route is the compile's wherever they have one: the base's code path); =1 (the child's
// route at once, the lab's) made the refinement start from the child's route instead of the executor's: Rosa dei Venti
// +56 / +148 in two pairs, celeste +5: opt-in.
const DEFAULTS = [
	['EEAT_COVER', '3'], ['EEAT_CRUMBS', '1'], ['EEAT_FIELD_MEMO', '1'],
	['EEAT_PLAN_ANY', '1'], ['EEAT_PLAN_UNTOGGLE', '1'],
	['EEAT_FX_FIELD', '1'], ['EEAT_FX_STATE', '1'], ['EEAT_ICE_LOCAL', '1'], ['EEAT_PROT_LAYER', '1'],
	['EEAT_CRUMB_RANK', '3'],
	['EEAT_BW_LEVEL', 'last'],
];
/** set the defaults the environment does not name (EEAT_COMPILER_DEFAULTS=0: none of them) */
function apply() {
	if (process.env.EEAT_COMPILER_DEFAULTS === '0') return [];
	const set = [];
	for (const [k, v] of DEFAULTS) if (process.env[k] === undefined) { process.env[k] = v; set.push(k); }
	return set;
}
module.exports = { DEFAULTS, apply };

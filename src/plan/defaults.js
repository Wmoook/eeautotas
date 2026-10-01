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
//  - (OUT of the defaults since the C6 chief's block 2, 2026-09-30 22:50: OPT-IN again, see the end of this bullet)
//    EEAT_CRUMB_RANK=3 (C6 lane 5 block 2, strategy.js THE CRUMB RANK's F GATE: a crumb's gain counts in the anchor pick
//    only while the anchor's f (arrival tick + plan cost) is within 10% + 60 ticks of the least f of its real gain; box 6,
//    300 s, side by side): Tutorial 2 3,112 / 3,673 run ticks vs the base's 7,018 (every base sample 4,479-7,018; main
//    3,070-3,401; the best known 2,947), On And On 2,516 / 3,226 (base 2,823 / 3,628), Perilous Endeavor - / 5,683 (base -);
//    COST: EE mountain world 0 of 2 (the base's one run routed it at 293 s through 5 coins and blue coins, 15,233 run
//    ticks): WATCH. =2 (always out): Tutorial 2 3,133 / 3,334 / 3,960 but On And On 1 of 2; =1 (after the first route)
//    Tutorial 2 5,924. ON TOP OF THE S99 STRETCH DEFAULTS it lost: the chief's A/B 3 (n5-plan fc07366 = S99 + =3 vs main
//    23f1f3a = S99 alone, side by side, 300 s, W3, 56 levels, one run an arm) compiled 44 vs 50 (main only Tutorial 2 4,097,
//    Buuwuu, A Dreary Day, Lab of Insanity, TPs, Pinball Bloom, Ice Cream Expedition; =3 only YMCK), both-routed 43 +2.3% run
//    ticks (faster 10 / slower 17); the full 230 at 300 s 46 (=3) vs 50 (S99's run of main's compiler); Tutorial 2 with =3:
//    8,014 / 6,054 / 2,963 / none in 4 runs. Re-measure on the S99 stack (2 runs an arm) before it is a default again.
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
	['EEAT_BW_LEVEL', 'last'],
	// (B8 speed, cycle 2: the exact landing's routes as the child prints them, not at its end: the precision pair's first
	// route 10-20 s vs 33-141 s on box 8 at load 180-230, the final routes the same 153 ticks; strategy.js PREC_STREAM)
	['EEAT_PREC_STREAM', '1'],
];
// THE STRETCH DEFAULTS (S99, 2026-09-30: "a level compiles only if EVERY stretch works"; CLAUDE.md section 11; each =0 off,
// EEAT_S99_DEFAULTS=0 none of them, EEAT_COMPILER_DEFAULTS=0 none at all):
//  - EEAT_PORTFOLIO=1 (n5-s99-portfolio: one call per stretch runs the backward meet, the speed profile, the leg finder, the
//    corridor and msolve.chain in ONE continuous budget): the 1,123 real 4-move chains 88.4% in 5 s / 95.4% in 40 s where
//    msolve.chain alone did 47.2%; the 55 known-route legs 13 -> 36-38; the executor's krt legs 91 -> 97; the 48-level
//    compile 20 = 20 at 120 s with the 19 both-routed 11.2% faster (14 faster, 0 slower).
//  - EEAT_CORR_FIELDS=1 (n5-s99-fields: the corridor's fields pass, also the portfolio's corridor arm): the corridor on the
//    chains 73.7% -> 87.9% (fields 65.1 -> 85.2%), the portfolio 85.7 -> 87.2% at 5 s; with EEAT_CORRIDOR 13 vs 10, 13 = 13
//    compiled of 25.
//  - EEAT_STRETCH=1 (n5-s99-budget: one continuous backward clock a stretch in a child process at nice +10): five A/Bs
//    pooled 145 vs 139 of 240 level runs (Stone Ruin 0 -> 3 / 5, Gravity's Rainbow 0 -> 3 / 5, The Blank Page 1 -> 5 / 5,
//    INVASION 3 -> 5 / 5).
//  - EEAT_BW_CHAIN=1 (n5-s99-gated: the gated levels as a chain of backward legs over trigger orders): 7 = 7 of the 20
//    gated levels, its own routes on 4 of 8 far faster (Late christmas 5,086 vs 8,851, Vignettes 8,156 vs 11,303); with
//    the stretch solver on, only on a GATED level (the stretch child takes the one-leg levels' whole-level solve).
const S99_DEFAULTS = [
	['EEAT_PORTFOLIO', '1'], ['EEAT_CORR_FIELDS', '1'], ['EEAT_STRETCH', '1'], ['EEAT_BW_CHAIN', '1'],
];
// THE GATED ORDER DEFAULTS (P4 gated, 2026-10-01; CLAUDE.md section 11 "THE GATED LEVELS' ORDER"; each =0 off,
// EEAT_GATED_DEFAULTS=0 none of them): the gated chain's own knobs (src/plan/lab/bwchain.js: they act only in the chain
// child, i.e. on a GATED level; every other level's compile is byte for byte the same):
//  - EEAT_BWC_RANK=est (the nearest usable edges, gain first, plan 1 second; KEEP over checkpoints): the order oracle on
//    the 19 gated known routes holds the route's next trigger first at 57.9% (the plans' first steps 34.5%); the chain
//    alone on the 78 gated levels 5 -> 6 finished (+ Weird Perfection), its legs found 874 -> 1,246; with the checkpoint
//    KEEP 7 (+ Summer Bee).
//  - EEAT_BWC_LEARN=1 (a leg lost at the full clock prices its edge at every node; the chain's planner learns its legs).
//  - EEAT_BWC_MORE=1 (THE ORDER BOUND: faster orders after the first route; Late christmas 6,649 -> 5,985 alone).
//  - EEAT_BWC_RELAY=1 (a lost full-clock leg's nearest node a relay node): under the compile's load Weird Perfection's
//    first leg passed the 40-s clock in every try without it (18 legs, 0 found); with it the compile's route 21,878 (best
//    known 20,731), never compiled before.
// NOT defaults (measured negative): EEAT_BWC_LEAD (the executor built its routes on the chain's anchors: Tutorial 3 2,204 vs
// 4,194), EEAT_BWC_ROOTS (the executor's far anchors took the chain's best-first: Weird Perfection's chain 87 -> 11 gain).
const GATED_DEFAULTS = [
	['EEAT_BWC_RANK', 'est'], ['EEAT_BWC_LEARN', '1'], ['EEAT_BWC_MORE', '1'], ['EEAT_BWC_RELAY', '1'],
];
/** set the defaults the environment does not name (EEAT_COMPILER_DEFAULTS=0: none of them; EEAT_S99_DEFAULTS=0: not the
 *  stretch defaults; EEAT_GATED_DEFAULTS=0: not the gated order's) */
function apply() {
	if (process.env.EEAT_COMPILER_DEFAULTS === '0') return [];
	const set = [];
	for (const [k, v] of DEFAULTS) if (process.env[k] === undefined) { process.env[k] = v; set.push(k); }
	if (process.env.EEAT_S99_DEFAULTS !== '0') for (const [k, v] of S99_DEFAULTS) if (process.env[k] === undefined) { process.env[k] = v; set.push(k); }
	if (process.env.EEAT_GATED_DEFAULTS !== '0') for (const [k, v] of GATED_DEFAULTS) if (process.env[k] === undefined) { process.env[k] = v; set.push(k); }
	return set;
}
module.exports = { DEFAULTS, S99_DEFAULTS, GATED_DEFAULTS, apply };

'use strict';
// cand.js: the S600 (search alone, 600 s, v1.7.1) status of the candidate "neither" levels
const fs = require('fs');
const c = ['01_4_Mount_Uonegatscil', '02_3_Springopolis', '03_5_Hunt', '09_4_ML_s_First_Samurai', '12_2_The_Square', '20_3_Not_Enough_Skeletons', '22_3_Weird_World',
	'23_4_Switcher_Puzzle', '28_1_Frolic', '28_4_Fizio1_Fun_Land', '31_2_Polar_Eclipse', '33_2_Nightmare_Relics', '40_4_MoonBase', '09_3_Toad_Town_Tunnels', '29_4_Rotcil_Illusions',
	'35_3_MegaMan_Dash', '34_3_Technological_Terror'];
const m = new Map();
for (const l of fs.readFileSync('/root/hy_baseline_out/S600/results.jsonl', 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); if (r.set === 'A') m.set(r.file.replace('.eelvl', ''), r); }
for (const id of c) { const r = m.get(id); console.log(id, r ? (r.routed ? `ROUTED ${r.firstRouteS}` : `none ${r.nearest && r.nearest.tiles}`) : 'not run'); }

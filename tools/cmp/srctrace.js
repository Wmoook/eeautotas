// node tools/cmp/srctrace.js (a diagnosis aid): replay a source event's inputs (a compile events.jsonl, the source whose desc matches a regex, the first one)
// and print the ball's tile / team / speed every k ticks from tick a to the end
// node tools/cmp/srctrace.js <level> <events.jsonl> <desc regex> <from tick> [k=8]
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const E = require(path.join(root, 'src/eesim.js'));
const [file, ev, re, fromArg, kArg] = process.argv.slice(2);
const L = T.loadLevelFile(file);
const W = 300, H = 300;
const rx = new RegExp(re);
let src = null;
for (const l of fs.readFileSync(ev, 'utf8').split('\n')) { if (!l) continue; let e; try { e = JSON.parse(l); } catch (err) { continue; } if (e.ev === 'source' && rx.test(e.desc || '') && e.inputs) { src = e; break; } }
if (!src) { console.log('no source'); process.exit(1); }
console.log('source', src.desc, 'tick', src.tick, 'anchor', src.anchor, src.label);
const masks = T.masksOf(src.inputs);
const sim = new E.EESim(L); sim.reset();
const inp = {};
const from = +fromArg, k = +(kArg || 8);
let line = [];
for (let t = 0; t < masks.length; t++) {
	E.applyMask(inp, masks[t]); sim.tick(inp);
	if (t + 1 >= from && ((t + 1 - from) % k === 0 || t + 1 === masks.length)) {
		const tile = T.tileOf(sim, W, H);
		line.push(`${t + 1}:(${tile % W},${(tile / W) | 0})T${sim.team}${sim.is_dead ? 'D' : ''}`);
	}
}
console.log(line.join(' '));

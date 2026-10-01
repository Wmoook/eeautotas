// node tools/cmp/fieldway.js (a diagnosis aid): the all-open field's way (steepest descent of the goal field's walk) from a tile to a trigger's tiles, the gates on it
// node tools/cmp/fieldway.js <level> <trig id> <x,y> ...
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const M = require(path.join(root, 'src/plan/model.js'));
const RF = require(path.join(root, 'src/reach.js'));
const [file, trigArg, ...from] = process.argv.slice(2);
const L = T.loadLevelFile(file);
const model = M.compileModel(L, { file });
const W = L.width || model.W, H = L.height || model.H, N = W * H;
const X = model.triggers[+trigArg];
console.log('goal', X.label, 'W', W, 'H', H);
const A = require(path.join(root, 'src/steer.js')).analyze(L);
const t0 = Date.now();
const f = T.goalField(L, X.tiles, { deaths: false });
console.log('field ms', Date.now() - t0, 'walk?', !!(f && f.walk));
const walk = f.walk;
for (const s of from) {
	const [x0, y0] = s.split(',').map(Number);
	let t = y0 * W + x0;
	const way = [], gates = [];
	for (let steps = 0; steps < N && walk[t] > 0 && walk[t] !== RF.CUT; steps++) {
		way.push(t);
		if (A.cls[t] === 3) gates.push(`(${t % W},${(t / W) | 0}) ${A.gateFeat[t]}`);
		const x = t % W, y = (t / W) | 0;
		let bt = -1;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const xx = x + dx, yy = y + dy;
			if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
			const j = yy * W + xx;
			if (walk[j] !== RF.CUT && walk[j] < walk[t] && (bt < 0 || walk[j] < walk[bt])) bt = j;
		}
		if (bt < 0) break;
		t = bt;
	}
	console.log(`from (${x0},${y0}) walk ${walk[y0 * W + x0]} steps ${way.length} end (${t % W},${(t / W) | 0}) walk ${walk[t]}; gates: ${gates.join('; ') || 'none'}`);
	console.log('  way: ' + way.filter((_, i) => i % 3 === 0).map((u) => `${u % W},${(u / W) | 0}`).join(' '));
}

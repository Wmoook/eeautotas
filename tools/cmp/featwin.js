// node tools/cmp/featwin.js <level> [feature ids] [trigger ids]: the model features / triggers by index; WIN=x0,y0,x1,y1 the gates and triggers in a window, TEAM=1 the team triggers and gates (a diagnosis aid)
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const M = require(path.join(root, 'src/plan/model.js'));
const file = process.argv[2];
const L = T.loadLevelFile(file);
const model = M.compileModel(L, { file });
console.log(Object.keys(model).join(' '));
const F = model.features || model.feats;
for (const i of (process.argv[3] || '59').split(',').map(Number)) console.log(i, JSON.stringify(F[i]).slice(0, 600));
for (const id of (process.argv[4] || '').split(',').filter(Boolean)) { const t = model.triggers[+id]; console.log('trig', id, JSON.stringify(t).slice(0, 800)); }
if (process.env.WIN) {
	const [x0, y0, x1, y1] = process.env.WIN.split(',').map(Number);
	const inW = (t) => { const x = t % 300, y = (t / 300) | 0; return x >= x0 && x <= x1 && y >= y0 && y <= y1; };
	for (const g of model.gates) if (g.tiles.some(inW)) console.log('G', g.id, g.feat, 'pol', g.pol, 'param', g.param, 'block', g.block, g.tiles.map((t) => `(${t % 300},${(t / 300) | 0})`).join(' '));
	for (const t of model.triggers) if (t && t.tiles && t.tiles.some(inW)) console.log('T', t.id, t.kind, t.feat, t.label);
}
if (process.env.TEAM) {
	for (const t of model.triggers) if (t && /team/.test(t.feat || t.kind || '')) console.log('T', t.id, t.kind, t.feat, t.param, t.label, t.tiles.length);
	const G = model.gates || [];
	console.log('gates', G.length, JSON.stringify(G[0]).slice(0, 400));
	for (const g of G) if (/team/.test(JSON.stringify(g).slice(0, 300))) console.log('G', JSON.stringify(g).slice(0, 300));
}

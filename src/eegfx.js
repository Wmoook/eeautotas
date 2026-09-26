'use strict';
// Everybody Edits graphics for the run viewer ("Watch"), loaded at run time from the user's own eeo-tas checkout.
// The block images belong to Everybody Edits: none of them (and no per-block sprite data) is in this repository or in
// EEAutoTAS.exe. The app finds eeo-tas (settings.json "eegfxDir", else $EEO_TAS, else ~/eeo-tas), reads its AS3
// source and builds the sprite map from it:
// - ItemManager.as createBrick(id, layer, base, payvault, desc, tab, owner, shadow, artoffset, ...): block id -> the
//   sheet behind `base` (its [Embed] PNG), the 16x16 frame `artoffset`, the ItemLayer (0 foreground, 1 background,
//   2 decoration, 3 above) and the drop shadow (ItemBrick.drawWithShadow: the image 2 px right and down, black 30%);
// - the BlockSprite declarations (spikes, doors, portals, one-ways, half blocks, coins, effects, ...): sheet, first
//   frame, frame count, shadow; the numbered sheets ItemManager.init generates (coin, death and switch doors, switches,
//   multi-jump: a brick with its number in block_numbers.png digits, white on a dark glow or black on a white glow);
// - getRotateableSprite + ItemId.isBlockRotateable: the sprite that draws a morphable block at its rotation;
// - addNpc (NPC images), addSmiley / Player.as (the 26x26 smiley drawn at x-5, y-5; the zombie face, the fire aura, the
//   fly flame and the effect icons above the head), AnimationManager (death.png).
// World.as onDraw / postDraw decide which frame a door, gate, switch, effect, portal or coin shows at a moment of the
// run; the page follows those rules (src/app/index.html, the gx* functions). The map is cached in <data>/eegfx.json,
// keyed by the eeo-tas files it was built from. The PNGs are served unchanged: GET /api/eegfx/sheet/<name>.png, only
// for names in the map.
//   node src/eegfx.js [eeo-tas dir]                       build and summarize the map
//   node src/eegfx.js coverage <level.eelvl> [...]        which block ids of these levels have a sprite
const fs = require('fs');
const path = require('path');
const os = require('os');
const C = require('./common.js');
const M = require('./minimap.js');

const GEN = 4;   // generator version: part of the cache key
const LAYER = { FORGROUND: 0, BACKGROUND: 1, DECORATION: 2, ABOVE: 3 };
// ItemId names the page's World.as rules use (sent as `ids`, resolved from this eeo-tas's ItemId.as)
const ID_NAMES = ['CHECKPOINT', 'DEATH_DOOR', 'DEATH_GATE', 'DOOR_PURPLE', 'GATE_PURPLE', 'DOOR_ORANGE', 'GATE_ORANGE', 'DOOR_GOLD', 'GATE_GOLD',
	'SWITCH_PURPLE', 'SWITCH_ORANGE', 'RESET_PURPLE', 'RESET_ORANGE', 'TIMEDOOR', 'TIMEGATE', 'SLOW_DOT_INVISIBLE', 'CROWNDOOR', 'CROWNGATE',
	'SILVERCROWNDOOR', 'SILVERCROWNGATE', 'COINDOOR', 'BLUECOINDOOR', 'COINGATE', 'BLUECOINGATE', 'ZOMBIE_DOOR', 'ZOMBIE_GATE', 'SPIKE',
	'SPIKE_SILVER', 'SPIKE_BLACK', 'SPIKE_RED', 'SPIKE_GOLD', 'SPIKE_GREEN', 'SPIKE_BLUE', 'PORTAL', 'PORTAL_INVISIBLE', 'WORLD_PORTAL', 'DIAMOND',
	'CAKE', 'HOLOGRAM', 'EFFECT_TEAM', 'TEAM_DOOR', 'TEAM_GATE', 'EFFECT_CURSE', 'EFFECT_FLY', 'EFFECT_JUMP', 'EFFECT_PROTECTION', 'EFFECT_RUN',
	'EFFECT_ZOMBIE', 'EFFECT_LOW_GRAVITY', 'EFFECT_MULTIJUMP', 'EFFECT_GRAVITY', 'EFFECT_POISON', 'LABEL', 'ICE', 'CAVE_TORCH', 'DUNGEON_TORCH',
	'CHRISTMAS_2016_CANDLE', 'HALLOWEEN_2016_EYES', 'FIREWORKS', 'WAVE', 'MUD_BUBBLE', 'FIRE', 'WATER', 'TOXIC_WASTE', 'TOXIC_WASTE_SURFACE',
	'TEXT_SIGN', 'LAVA', 'GOLDEN_EASTER_EGG', 'COIN_GOLD', 'COIN_BLUE'];

// ---------------------------------------------------------------- where eeo-tas is (settings.json, $EEO_TAS, ~/eeo-tas)
const settingsFile = () => path.join(C.DATA, 'settings.json');
const readSettings = () => C.readJSON(settingsFile(), {}) || {};
function writeSettings(patch) {
	const s = Object.assign(readSettings(), patch);
	for (const k of Object.keys(s)) if (s[k] === null || s[k] === undefined || s[k] === '') delete s[k];
	C.writeJSON(settingsFile(), s);
}
/** the ItemManager.as of an eeo-tas folder (src/items/ItemManager.as, or anywhere under src/ up to 4 levels deep) */
function findItemManager(dir) {
	const std = path.join(dir, 'src', 'items', 'ItemManager.as');
	if (fs.existsSync(std)) return std;
	const walk = (d, depth) => {
		let ents = [];
		try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return null; }
		for (const e of ents) if (e.isFile() && e.name === 'ItemManager.as') return path.join(d, e.name);
		if (depth <= 0) return null;
		for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) { const r = walk(path.join(d, e.name), depth - 1); if (r) return r; }
		return null;
	};
	return walk(path.join(dir, 'src'), 4);
}
/** null when `dir` is a usable eeo-tas checkout, else the reason */
function problem(dir) {
	if (!dir) return 'no folder given';
	let st = null;
	try { st = fs.statSync(dir); } catch (e) { return `${dir} does not exist`; }
	if (!st.isDirectory()) return `${dir} is not a folder`;
	if (!fs.existsSync(path.join(dir, 'media', 'blocks.png'))) return `${dir} has no media/blocks.png (is it the eeo-tas folder?)`;
	if (!findItemManager(dir)) return `${dir} has no src/items/ItemManager.as (is it the eeo-tas folder?)`;
	return null;
}
/** {dir, source, why}: the folder in use (dir null and why set when none is usable) */
function locate() {
	const tried = [];
	const s = readSettings();
	if (s.eegfxDir) {
		const why = problem(s.eegfxDir);
		if (!why) return { dir: path.resolve(s.eegfxDir), source: 'settings', why: null };
		tried.push(`the folder set in the viewer: ${why}`);
	}
	if (process.env.EEO_TAS) {
		const why = problem(process.env.EEO_TAS);
		if (!why) return { dir: path.resolve(process.env.EEO_TAS), source: 'env', why: null };
		tried.push(`EEO_TAS: ${why}`);
	}
	const home = path.join(os.homedir(), 'eeo-tas');
	const why = problem(home);
	if (!why) return { dir: home, source: 'default', why: null };
	tried.push(why.startsWith(home + ' does not exist') ? `${home} not found` : why);
	return { dir: null, source: null, why: `EE graphics come from your eeo-tas folder, which was not found (${tried.join('; ')}). Set its folder in the viewer.` };
}

// ---------------------------------------------------------------- AS3 parsing helpers
const readAs = (file) => M.stripComments(fs.readFileSync(file, 'utf8'));
/** the text of the braces block that starts at the first '{' at or after `from` */
function braceBlock(s, from) {
	const a = s.indexOf('{', from);
	if (a < 0) return '';
	let depth = 0;
	for (let i = a; i < s.length; i++) {
		if (s[i] === '{') depth++;
		else if (s[i] === '}' && --depth === 0) return s.slice(a + 1, i);
	}
	return s.slice(a + 1);
}
function functionBody(s, name) {
	const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(s);
	return m ? braceBlock(s, m.index) : '';
}
function pngSize(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const b = Buffer.alloc(24);
		fs.readSync(fd, b, 0, 24, 0);
		if (b.readUInt32BE(0) !== 0x89504E47) throw new Error(`${file} is not a PNG`);
		return [b.readUInt32BE(16), b.readUInt32BE(20)];
	} finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- the sprite map
function build(dir) {
	const imFile = findItemManager(dir);
	const itemsDir = path.dirname(imFile), srcDir = path.join(dir, 'src');
	const im = readAs(imFile);
	const idText = readAs(path.join(itemsDir, 'ItemId.as'));
	const warnings = [];
	const consts = new Map();
	for (const m of idText.matchAll(/static\s+const\s+(\w+)\s*:\s*int\s*=\s*(-?(?:0x[0-9a-f]+|\d+))\s*;/gi)) consts.set(m[1], parseInt(m[2]));
	// [Embed(source="/../media/x.png")] ... var fooBM:Class;   var fooBMD:BitmapData = new fooBM().bitmapData;
	const embed = new Map(), bmdFile = new Map();
	const scanEmbeds = (text) => {
		for (const m of text.matchAll(/\[Embed\(\s*source\s*=\s*"([^"]+)"\s*\)\s*\][^;]*?var\s+(\w+)\s*:\s*Class/g)) embed.set(m[2], m[1]);
		for (const m of text.matchAll(/var\s+(\w+)\s*:\s*BitmapData\s*=\s*new\s+(\w+)\(\)\.bitmapData/g)) if (embed.has(m[2])) bmdFile.set(m[1], path.basename(embed.get(m[2])));
	};
	scanEmbeds(im);
	// sheets: file name (without .png) -> index in `sheets`
	const sheets = [], sizes = [], sheetIdx = new Map();
	const sheetOf = (fileName) => {
		const name = fileName.replace(/\.png$/i, '');
		if (sheetIdx.has(name)) return sheetIdx.get(name);
		const f = path.join(dir, 'media', `${name}.png`);
		if (!/^[\w.-]+$/.test(name) || !fs.existsSync(f)) return -1;
		sheetIdx.set(name, sheets.length);
		sheets.push(name); sizes.push(pngSize(f));
		return sheets.length - 1;
	};
	const bmdSheet = (v) => (bmdFile.has(v) ? sheetOf(bmdFile.get(v)) : -1);
	// generated BitmapData sizes (new BitmapData(16*1000, 16, ...)) for "x.width/16" frame counts
	const genWidth = new Map();
	for (const m of im.matchAll(/var\s+(\w+)\s*:\s*BitmapData\s*=\s*new\s+BitmapData\s*\(/g)) {
		const a = M.callArgs(im, m.index + m[0].length - 1);
		if (a) { const w = evalNum(a[0]); if (w !== undefined) genWidth.set(m[1], w); }
	}
	function evalNum(t) {
		t = String(t).trim();
		if (/^-?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
		t = t.replace(/ItemId\.(\w+)/g, (_, n) => (consts.has(n) ? String(consts.get(n)) : 'NaN'));
		t = t.replace(/(\w+)\.width/g, (_, v) => {
			const s = bmdSheet(v);
			if (s >= 0) return String(sizes[s][0]);
			return genWidth.has(v) ? String(genWidth.get(v)) : 'NaN';
		});
		if (!/^[\d\s+\-*/().NaN]+$/.test(t)) return undefined;
		try { const v = Function(`return (${t})`)(); return Number.isFinite(v) ? Math.floor(v) : undefined; } catch (e) { return undefined; }
	}
	const idOf = (t) => { const v = evalNum(t); return v === undefined || v < 0 ? undefined : v; };

	// ---- bricks: createBrick(id, layer, base, payvaultid, description, tab, requiresOwnership, shadow, artoffset, minimapColor, ...)
	const blocks = {};
	let skipped = 0;
	for (const m of im.matchAll(/(?<!function\s)\bcreateBrick\s*\(/g)) {
		const a = M.callArgs(im, m.index + m[0].length - 1);
		if (!a || a.length < 9) { skipped++; continue; }
		if (a[2] === 'brickBMD') continue;   // addNpc's brick (below)
		const id = idOf(a[0]), layer = LAYER[(a[1].match(/ItemLayer\.(\w+)/) || [])[1]], sh = bmdSheet(a[2]), art = evalNum(a[8]);
		if (id === undefined || layer === undefined || sh < 0 || art === undefined) { skipped++; warnings.push(`createBrick(${a.slice(0, 3).join(', ')}, ..., ${a[8]}): not understood`); continue; }
		blocks[id] = [sh, art, 0, layer, a[7] === 'true' ? 1 : 0];
	}
	// ---- NPCs: addNpc(id, payvault, pack, frames = 2, ...) -> brick from npcBlocksBMD at (16 * index, 16); the NPC 16x32 frames
	const npcs = {};
	const npcSheet = bmdSheet('npcBlocksBMD');
	let npcIndex = 0;
	for (const m of im.matchAll(/(?<!function\s)\baddNpc\s*\(/g)) {
		const a = M.callArgs(im, m.index + m[0].length - 1);
		if (!a) continue;
		const id = idOf(a[0]), frames = a.length > 3 ? evalNum(a[3]) : 2;
		if (id !== undefined && npcSheet >= 0) { blocks[id] = [npcSheet, npcIndex, 16, LAYER.ABOVE, 0]; npcs[id] = [npcSheet, npcIndex, frames || 2]; }
		npcIndex += frames || 2;
	}
	// ---- sprites: sprX = new BlockSprite(bmd, indexx, indexy, width, height, frames, shadow = false)
	const sprites = {};
	for (const m of im.matchAll(/\b(spr\w+)\s*(?::\s*\w+\s*)?=\s*new\s+BlockSprite\s*\(/g)) {
		const a = M.callArgs(im, m.index + m[0].length - 1);
		if (!a || a.length < 6) continue;
		const frames = evalNum(a[5]), off = evalNum(a[1]), shadow = a[6] === 'true' ? 1 : 0;
		if (frames === undefined || off === undefined) { warnings.push(`${m[1]}: frames not understood`); continue; }
		const sh = bmdSheet(a[0]);
		if (sh >= 0) sprites[m[1]] = [sh, off, frames, shadow];
		else if (genWidth.has(a[0])) sprites[m[1]] = { gen: a[0], frames, shadow };
	}
	// the generated numbered sheets (ItemManager.init): what each frame is, and the number style
	const genBase = new Map(), genText = new Map();
	for (const m of im.matchAll(/(\w+)\.copyPixels\(\s*bmdBricks\[\s*([^\]]+)\]/g)) { const id = idOf(m[2]); if (id !== undefined) genBase.set(m[1], { brick: id }); }
	for (const m of im.matchAll(/(\w+)\.copyPixels\(\s*(\w+)\s*,\s*new\s+Rectangle\(\s*(\d+)\s*\*\s*16/g)) {
		const sh = bmdSheet(m[2]);
		if (sh >= 0 && genWidth.has(m[1])) genBase.set(m[1], { sheet: sh, frame: +m[3] });
	}
	const loopAt = im.indexOf('createBlockText(a)'), blackAt = im.indexOf('new ColorTransform(0, 0, 0)', loopAt);
	for (const m of im.matchAll(/(\w+)\.draw\(\s*blockText\s*,\s*m\s*\)/g)) if (m.index > loopAt) genText.set(m[1], blackAt > 0 && m.index > blackAt ? 'b' : 'w');
	for (const [name, s] of Object.entries(sprites)) {
		if (!s.gen) continue;
		const base = genBase.get(s.gen);
		if (!base) { warnings.push(`${name}: the frames of ${s.gen} were not found`); delete sprites[name]; continue; }
		Object.assign(s, base, { text: genText.get(s.gen) || null });
	}
	// ---- morphable blocks: ItemId.isBlockRotateable + ItemManager.getRotateableSprite
	const rotatable = [];
	for (const m of functionBody(idText, 'isBlockRotateable').matchAll(/case\s+(\w+)\s*:/g)) if (consts.has(m[1])) rotatable.push(consts.get(m[1]));
	const nonRotHalf = [];
	for (const m of functionBody(idText, 'isNonRotatableHalfBlock').matchAll(/case\s+(\w+)\s*:/g)) if (consts.has(m[1])) nonRotHalf.push(consts.get(m[1]));
	const rot = {};
	for (const m of functionBody(im, 'getRotateableSprite').matchAll(/case\s+ItemId\.(\w+)\s*:\s*return\s+(\w+)/g)) {
		if (consts.has(m[1]) && sprites[m[2]]) rot[consts.get(m[1])] = m[2];
	}
	// ---- smiley (addSmiley: 26x26 at 26 * id; Player.as draws it at x - 5, y - 5) and the death animation (64x64)
	let smiley = null;
	const smSheet = bmdSheet('smileysBMD');
	if (smSheet >= 0) {
		const body = functionBody(im, 'addSmiley');
		const sz = +((body.match(/new\s+Rectangle\(\s*(\d+)\s*\*\s*id/) || [])[1] || 26);
		let dx = 5;
		try { const pl = readAs(path.join(srcDir, 'Player.as')); const mm = pl.match(/var\s+playerX\s*:\s*Number\s*=\s*x\s*\+\s*ox\s*-\s*(\d+)/); if (mm) dx = +mm[1]; } catch (e) { /* default */ }
		smiley = { sheet: smSheet, size: sz, frame: 0, dx: -dx, dy: -dx };
	}
	// ---- a player with effects (Player.draw, drawFace, drawTagged, playLevitationAnimation): the BlSprites fireAnimation
	// (fire aura), levitationAnimation (the fly flame) and effectIcons (protection, curse, zombie, poison icons above the
	// head) as [sheet, first frame, width, height, frames] (frame f at x = (first + f) * width), and the zombie face's frame
	// in the smiley sheet (drawFace: `copyPixels(bmd, new Rectangle(26 * 87, ...))`)
	let player = null;
	try {
		const pl = readAs(path.join(srcDir, 'Player.as'));
		scanEmbeds(pl);
		const bl = {};
		for (const m of pl.matchAll(/var\s+(\w+)\s*:\s*BlSprite\s*=\s*new\s+BlSprite\s*\(/g)) {
			const a = M.callArgs(pl, m.index + m[0].length - 1);
			if (!a || a.length < 6) continue;
			const sh = bmdSheet(a[0]), first = evalNum(a[1]), w = evalNum(a[3]), h = evalNum(a[4]), frames = evalNum(a[5]);
			if (sh >= 0 && first >= 0 && w > 0 && h > 0 && frames > 0) bl[m[1]] = [sh, first, w, h, frames];
		}
		const zm = pl.match(/if\s*\(\s*zombie\s*\)\s*\{?\s*\w+\.copyPixels\(\s*bmd\s*,\s*new\s+Rectangle\(\s*(\d+)\s*\*\s*(\d+)/);
		player = { fire: bl.fireAnimation || null, levitation: bl.levitationAnimation || null, icons: bl.effectIcons || null,
			zombie: zm && smiley && +zm[1] === smiley.size ? +zm[2] : null };
	} catch (e) { /* no Player.as: the page marks the effects its own way */ }
	let death = null;
	try {
		const am = readAs(path.join(srcDir, 'animations', 'AnimationManager.as'));
		scanEmbeds(am);
		const mm = am.match(/\[Embed\(\s*source\s*=\s*"([^"]*death\.png)"\s*\)/);
		const sh = mm ? sheetOf(path.basename(mm[1])) : -1;
		if (sh >= 0) death = { sheet: sh, size: sizes[sh][1], frames: Math.floor(sizes[sh][0] / sizes[sh][1]), dx: -24, dy: -24, rate: 0.3 };
	} catch (e) { /* no death animation */ }
	const numbers = bmdSheet('blockNumbersBMD');
	const egg = bmdSheet('blocksGoldenEasterEggBMD');
	const ids = {};
	for (const n of ID_NAMES) if (consts.has(n)) ids[n] = consts.get(n);
	if (!Object.keys(blocks).length) throw new Error(`no createBrick(...) calls understood in ${imFile}`);
	return {
		format: 'eegfx-1', gen: GEN, dir, itemManager: path.relative(dir, imFile).replace(/\\/g, '/'),
		sheets, sizes, blocks, sprites, rot, rotatable, nonRotHalf, npcs, smiley, player, death, numbers: numbers >= 0 ? numbers : null, egg: egg >= 0 ? egg : null,
		ids, counts: { blocks: Object.keys(blocks).length, sprites: Object.keys(sprites).length, rot: Object.keys(rot).length, npcs: Object.keys(npcs).length, skipped },
		warnings: warnings.slice(0, 40),
	};
}

// ---------------------------------------------------------------- cache (<data>/eegfx.json, keyed by the files it is made of)
const cacheFile = () => path.join(C.DATA, 'eegfx.json');
function sourceKey(dir) {
	const st = (f) => { try { const s = fs.statSync(f); return `${Math.round(s.mtimeMs)}.${s.size}`; } catch (e) { return '-'; } };
	const im = findItemManager(dir);
	const parts = [GEN, dir, st(im), st(path.join(path.dirname(im), 'ItemId.as')), st(path.join(dir, 'src', 'Player.as')),
		st(path.join(dir, 'src', 'animations', 'AnimationManager.as'))];
	let media = [];
	try { media = fs.readdirSync(path.join(dir, 'media')).filter((f) => /\.png$/i.test(f)).sort(); } catch (e) { /* none */ }
	for (const f of media) parts.push(`${f}:${st(path.join(dir, 'media', f))}`);
	let h = 0x811c9dc5 | 0;
	const s = parts.join('|');
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return `${GEN}-${(h >>> 0).toString(36)}`;
}
let memo = null;   // {key, map}
/** The map for the eeo-tas folder in use: {available: true, dir, source, version, ...map} or {available: false, why}. */
function info() {
	const loc = locate();
	if (!loc.dir) return { available: false, dir: null, source: null, why: loc.why, settingsDir: readSettings().eegfxDir || null };
	let key;
	try {
		key = sourceKey(loc.dir);
		if (!memo || memo.key !== key) {
			const c = C.readJSON(cacheFile(), null);
			if (c && c.key === key && c.map && c.map.format === 'eegfx-1') memo = { key, map: c.map };
			else {
				const map = build(loc.dir);
				memo = { key, map };
				try { C.writeJSON(cacheFile(), { key, built: Date.now(), map }); } catch (e) { /* read-only data dir: keep it in memory */ }
			}
		}
	} catch (e) {
		return { available: false, dir: loc.dir, source: loc.source, why: `could not read the EE graphics in ${loc.dir}: ${e.message}`, settingsDir: readSettings().eegfxDir || null };
	}
	return Object.assign({ available: true, dir: loc.dir, source: loc.source, why: null, version: key, settingsDir: readSettings().eegfxDir || null }, memo.map);
}
/** The PNG file of a sheet in the map (null for any other name: no paths, only the map's own sheet names). */
function sheetFile(name) {
	const i = info();
	if (!i.available || typeof name !== 'string' || !/^[\w.-]+$/.test(name) || !i.sheets.includes(name)) return null;
	return path.join(i.dir, 'media', `${name}.png`);
}
/** Sets the eeo-tas folder (validated; '' or null = back to the default search). Returns info(). */
function setDir(dir) {
	const d = dir === null || dir === undefined ? '' : String(dir).trim().replace(/^"(.*)"$/, '$1');
	if (d) {
		const abs = path.resolve(d.replace(/^~(?=$|[\\/])/, os.homedir()));
		const why = problem(abs);
		if (why) throw new Error(why);
		writeSettings({ eegfxDir: abs });
	} else writeSettings({ eegfxDir: null });
	memo = null;
	return info();
}

/** For a level's block ids: which have a sprite (a brick, a rotatable sprite, an NPC), which not. */
function coverage(map, ids) {
	const mapped = [], unmapped = [];
	for (const id of ids) {
		if (!id) continue;
		if (map.blocks[id] || map.rot[id] || map.npcs[id]) mapped.push(id); else unmapped.push(id);
	}
	return { mapped, unmapped };
}

module.exports = { info, sheetFile, setDir, locate, problem, build, coverage, settingsFile, readSettings };

if (require.main === module) {
	const args = process.argv.slice(2);
	if (args[0] === 'coverage') {
		const E = require('./eelvl.js');
		const i = info();
		if (!i.available) { console.log(i.why); process.exit(1); }
		let allM = 0, allU = 0;
		for (const f of args.slice(1)) {
			let p;
			try { p = E.readEelvl(fs.readFileSync(f), { lenient: true }); } catch (e) { console.log(`${f}: ${e.message}`); continue; }
			const used = new Set([...p.fg, ...p.bg]);
			const c = coverage(i, [...used].sort((a, b) => a - b));
			allM += c.mapped.length; allU += c.unmapped.length;
			console.log(`${path.basename(f)}: ${c.mapped.length} block ids with a sprite, ${c.unmapped.length} without${c.unmapped.length ? ` (${c.unmapped.join(', ')})` : ''}`);
		}
		console.log(`total: ${allM} mapped, ${allU} unmapped`);
		return;
	}
	let i;
	if (args[0]) {   // that folder, without changing the setting
		const why = problem(path.resolve(args[0]));
		if (why) { console.log(why); process.exit(1); }
		i = Object.assign({ dir: path.resolve(args[0]), source: 'command line' }, build(path.resolve(args[0])));
	} else {
		i = info();
		if (!i.available) { console.log(i.why); process.exit(1); }
	}
	console.log(`[eegfx] ${i.dir} (${i.source}): ${i.counts.blocks} blocks, ${i.counts.sprites} sprites, ${i.counts.rot} morphable, ${i.counts.npcs} NPCs ` +
		`from ${i.sheets.length} sheets (${i.sheets.join(', ')})${args[0] ? '' : `; cached in ${cacheFile()}`}`);
	for (const w of i.warnings) console.log(`  ${w}`);
}

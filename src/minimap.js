'use strict';
// EE's own minimap colors per block id, for the level viewer (GET /api/jobs/:id/level). eeo-tas defines them in
// src/items/ItemManager.as: createBrick(id, layer, base, payvaultid, description, tab, requiresOwnership, shadow,
// artoffset, minimapColor, ...). A minimapColor of -1 means "the average color of the block's 16x16 image"
// (ItemBrick.generateThumbColor), 0x0 means transparent: MiniMap.as then shows the background block
// (World.getMinimapColor: color(decoration || foreground || background) || color(background)); unknown ids get
// block 0's color (black).
// The table is generated once into src/minimapcolors.json (committed; the app does not need eeo-tas):
//   node src/minimap.js build [path to eeo-tas]      (default C:\Users\super\eeo-tas or $EEO_TAS)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TABLE = path.join(__dirname, 'minimapcolors.json');

let cache = null;
/** id -> ARGB (uint32) for every block id eeo-tas defines */
function table() {
	if (cache) return cache;
	cache = new Map();
	try {
		const j = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
		for (const [k, v] of Object.entries(j.colors || {})) cache.set(+k, parseInt(v, 16) >>> 0);
	} catch (e) { /* no table: callers fall back to their own palette */ }
	return cache;
}
/** ItemManager.getMinimapColor(id): the block's color, or block 0's (black) for unknown ids */
function colorOf(id) {
	const t = table();
	if (t.has(id)) return t.get(id);
	return t.has(0) ? t.get(0) : 0xff000000;
}
/** World.getMinimapColor for one cell: layer-0 id (foreground or decoration) and background id */
function cellColor(fg, bg) { return colorOf(fg || bg) || colorOf(bg); }
const hex = (c) => (c >>> 0).toString(16).padStart(8, '0');

// ---------------------------------------------------------------- build (reads eeo-tas)
/** minimal PNG decoder: 8-bit gray / RGB / palette / gray+alpha / RGBA, no interlace -> {w, h, rgba} */
function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
	let o = 8, w = 0, h = 0, depth = 0, ct = 0, inter = 0, pal = null, trns = null;
	const idat = [];
	while (o < buf.length) {
		const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
		if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; inter = d[12]; }
		else if (type === 'PLTE') pal = d;
		else if (type === 'tRNS') trns = d;
		else if (type === 'IDAT') idat.push(d);
		else if (type === 'IEND') break;
		o += 12 + len;
	}
	if (depth !== 8 || inter !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${inter})`);
	const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
	if (!ch) throw new Error(`unsupported PNG color type ${ct}`);
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = w * ch;
	const px = Buffer.alloc(stride * h);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= ch ? px[dst + x - ch] : 0, b = y > 0 ? px[dst - stride + x] : 0, c = x >= ch && y > 0 ? px[dst - stride + x - ch] : 0;
			let v = raw[src + x];
			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			px[dst + x] = v & 255;
		}
	}
	const rgba = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		let r, g, b, al = 255;
		if (ct === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; al = px[i * 4 + 3]; }
		else if (ct === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
		else if (ct === 3) { const k = px[i]; r = pal[k * 3]; g = pal[k * 3 + 1]; b = pal[k * 3 + 2]; if (trns && k < trns.length) al = trns[k]; }
		else if (ct === 4) { r = g = b = px[i * 2]; al = px[i * 2 + 1]; }
		else { r = g = b = px[i]; }
		rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = al;
	}
	return { w, h, rgba };
}
/** AS3 source without comments (strings kept intact) */
function stripComments(s) {
	let out = '', i = 0;
	while (i < s.length) {
		const c = s[i];
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
			out += s.slice(i, j + 1); i = j + 1;
		} else if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; }
		else if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; }
		else { out += c; i++; }
	}
	return out;
}
/** the argument texts of a call whose '(' is at s[p] */
function callArgs(s, p) {
	const args = [];
	let depth = 0, cur = '', i = p;
	for (; i < s.length; i++) {
		const c = s[i];
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
			cur += s.slice(i, j + 1); i = j; continue;
		}
		if (c === '(' || c === '[' || c === '{') { if (depth > 0) cur += c; depth++; continue; }
		if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { args.push(cur.trim()); return args; } cur += c; continue; }
		if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
		cur += c;
	}
	return null;
}
function build(eeoDir) {
	const src = path.join(eeoDir, 'src', 'items');
	const im = stripComments(fs.readFileSync(path.join(src, 'ItemManager.as'), 'utf8'));
	const idText = stripComments(fs.readFileSync(path.join(src, 'ItemId.as'), 'utf8'));
	const consts = new Map();
	for (const m of idText.matchAll(/static\s+const\s+(\w+)\s*:\s*int\s*=\s*(-?\d+)/g)) consts.set(m[1], +m[2]);
	// sprite sheets: [Embed(source="/../media/x.png")] ... var fooBM:Class;  var fooBMD:BitmapData = new fooBM().bitmapData;
	const embed = new Map(), sheets = new Map(), images = new Map();
	for (const m of im.matchAll(/\[Embed\(source="([^"]+)"\)\s*\][^;]*?var\s+(\w+)\s*:\s*Class/g)) embed.set(m[2], m[1]);
	for (const m of im.matchAll(/var\s+(\w+)\s*:\s*BitmapData\s*=\s*new\s+(\w+)\(\)\.bitmapData/g)) if (embed.has(m[2])) sheets.set(m[1], embed.get(m[2]));
	const sheet = (name) => {
		if (!sheets.has(name)) return null;
		if (!images.has(name)) {
			let img = null;
			try { img = decodePng(fs.readFileSync(path.join(eeoDir, 'media', path.basename(sheets.get(name))))); } catch (e) { /* unreadable */ }
			images.set(name, img);
		}
		return images.get(name);
	};
	const num = (t) => {
		t = String(t).trim();
		if (/^-?0x[0-9a-f]+$/i.test(t)) return (t.startsWith('-') ? -parseInt(t.slice(1), 16) : parseInt(t, 16));
		if (/^-?\d+$/.test(t)) return +t;
		if (/^[\d\s+\-*()]+$/.test(t)) return Function(`return (${t})`)();   // e.g. artoffset 240-128
		if (/^ItemId\.\w+$/.test(t)) return consts.get(t.slice(7));
		return undefined;
	};
	const colors = {};
	let literal = 0, averaged = 0, skipped = 0;
	for (const m of im.matchAll(/(?<!function\s)\bcreateBrick\s*\(/g)) {
		const a = callArgs(im, m.index + m[0].length - 1);
		if (!a || a.length < 10) { skipped++; continue; }
		const id = num(a[0]), art = num(a[8]), mm = num(a[9]);
		if (id === undefined || mm === undefined) { skipped++; continue; }
		let c;
		if (mm === -1) {   // ItemBrick.generateThumbColor: average of the 16x16 image (transparent pixels count as black)
			const img = sheet(a[2]);
			if (!img || art === undefined) { skipped++; continue; }
			let r = 0, g = 0, b = 0;
			for (let y = 0; y < 16; y++) {
				for (let x = 0; x < 16; x++) {
					const X = 16 * art + x;
					if (X >= img.w || y >= img.h) continue;
					const k = (y * img.w + X) * 4;
					if (img.rgba[k + 3] === 0) continue;
					r += img.rgba[k]; g += img.rgba[k + 1]; b += img.rgba[k + 2];
				}
			}
			c = (0xff000000 | ((r / 256) << 16) | ((g / 256) << 8) | (b / 256)) >>> 0;
			averaged++;
		} else { c = mm >>> 0; literal++; }
		colors[id] = hex(c);
	}
	const out = { source: 'eeo-tas src/items/ItemManager.as createBrick(..., minimapColor): ARGB; -1 = the average of the block image ' +
		'(ItemBrick.generateThumbColor); 0 = transparent (the minimap shows the background block). Generated by node src/minimap.js build.',
	count: Object.keys(colors).length, colors };
	fs.writeFileSync(TABLE, JSON.stringify(out));
	cache = null;
	return { file: TABLE, count: out.count, literal, averaged, skipped };
}

module.exports = { colorOf, cellColor, table, decodePng, build };

if (require.main === module) {
	const [cmd, dir] = process.argv.slice(2);
	if (cmd !== 'build') { console.log('usage: node src/minimap.js build [path to eeo-tas]'); process.exit(1); }
	const r = build(dir || process.env.EEO_TAS || 'C:\\Users\\super\\eeo-tas');
	console.log(`[minimap] ${r.count} block colors (${r.literal} given, ${r.averaged} averaged from the images, ${r.skipped} skipped) -> ${r.file}`);
}

'use strict';
// Renders a PNG of the level region around a run's path in a time window (pure JS: a tiny RGB canvas, a 5x7
// bitmap font and a PNG encoder on top of Node's zlib). Used by `node src/tas.js render` and
// GET /api/jobs/:id/render.png. Tiles are colored by kind (src/blocks.js), the window's path is colored by time
// (cyan -> yellow -> red) with run-time labels, the rest of the run is a thin grey line. Tile coordinates are
// printed on the top and left edges (tile = 16 px of the game; x right, y down).
const zlib = require('zlib');
const B = require('./blocks.js');

// ---------------------------------------------------------------- PNG
const CRC = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
	return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
/** RGB pixels (w*h*3) -> PNG file bytes */
function encodePng(w, h, rgb) {
	const stride = w * 3;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- 5x7 font (rows of 5 bits, hex pairs)
const GLYPHS = {
	A: '0E11111F111111', B: '1E11111E11111E', C: '0E11101010110E', D: '1C12111111121C', E: '1F10101E10101F', F: '1F10101E101010',
	G: '0E1110171111 0F', H: '1111111F111111', I: '0E04040404040E', J: '07020202 02120C', K: '11121418141211', L: '1010101010101F',
	M: '111B1515111111', N: '11111915131111', O: '0E11111111110E', P: '1E11111E101010', Q: '0E11111115120D', R: '1E11111E141211',
	S: '0F10100E01011E', T: '1F040404040404', U: '1111111111110E', V: '1111111111 0A04', W: '1111111515150A', X: '11110A040A1111',
	Y: '1111110A040404', Z: '1F01020408101F',
	0: '0E111315191 10E', 1: '040C040404040E', 2: '0E11010204081F', 3: '1F020402011 10E', 4: '02060A121F0202', 5: '1F101E0101110E',
	6: '0608101E11110E', 7: '1F010204080808', 8: '0E11110E11110E', 9: '0E11110F01020C',
	':': '000C0C000C0C00', '.': '00000000000C0C', '-': '0000001F000000', '+': '0004041F040400', '(': '02040808080402',
	')': '08040202020408', '/': '00010204081000', ',': '00000000 0C0408', '=': '00001F001F0000', '?': '0E110102040004',
	'>': '08040201020408', '<': '02040810080402', '%': '18190204081303', '#': '0A0A1F0A1F0A0A', '_': '0000000000001F',
	'|': '04040404040404', '[': '0E08080808080E', ']': '0E02020202020E', "'": '04040800000000', '!': '04040404040004',
	'*': '0004150E150400', '"': '0A0A0000000000', '^': '040A1100000000', ' ': '00000000000000', '@': '0E11010D15150E',
};
const FONT = {};
for (const [k, v] of Object.entries(GLYPHS)) {
	const h = v.replace(/ /g, '');
	const rows = [];
	for (let i = 0; i < 7; i++) rows.push(parseInt(h.substr(i * 2, 2), 16));
	FONT[k] = rows;
}

// ---------------------------------------------------------------- canvas
class Canvas {
	constructor(w, h, bg) {
		this.w = w; this.h = h;
		this.p = Buffer.alloc(w * h * 3);
		for (let i = 0; i < w * h; i++) { this.p[i * 3] = bg[0]; this.p[i * 3 + 1] = bg[1]; this.p[i * 3 + 2] = bg[2]; }
	}
	set(x, y, c, a) {
		x |= 0; y |= 0;
		if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
		const k = this.clip;
		if (k && (x < k[0] || y < k[1] || x >= k[2] || y >= k[3])) return;
		const i = (y * this.w + x) * 3;
		if (a === undefined || a >= 1) { this.p[i] = c[0]; this.p[i + 1] = c[1]; this.p[i + 2] = c[2]; return; }
		this.p[i] = Math.round(this.p[i] * (1 - a) + c[0] * a);
		this.p[i + 1] = Math.round(this.p[i + 1] * (1 - a) + c[1] * a);
		this.p[i + 2] = Math.round(this.p[i + 2] * (1 - a) + c[2] * a);
	}
	rect(x, y, w, h, c, a) {
		const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
		const x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h));
		for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c, a);
	}
	frame(x, y, w, h, c, th = 1, a) {
		this.rect(x, y, w, th, c, a); this.rect(x, y + h - th, w, th, c, a);
		this.rect(x, y + th, th, h - 2 * th, c, a); this.rect(x + w - th, y + th, th, h - 2 * th, c, a);
	}
	disk(cx, cy, r, c, a) {
		const r2 = r * r;
		for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
			for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
				const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
				if (dx * dx + dy * dy <= r2) this.set(x, y, c, a);
			}
		}
	}
	ring(cx, cy, r, th, c, a) {
		const ro = r * r, ri = Math.max(0, r - th) ** 2;
		for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
			for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
				const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = dx * dx + dy * dy;
				if (d <= ro && d >= ri) this.set(x, y, c, a);
			}
		}
	}
	tri(ax, ay, bx, by, cx, cy, c, a) {
		const x0 = Math.floor(Math.min(ax, bx, cx)), x1 = Math.ceil(Math.max(ax, bx, cx));
		const y0 = Math.floor(Math.min(ay, by, cy)), y1 = Math.ceil(Math.max(ay, by, cy));
		const e = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
		const area = e(ax, ay, bx, by, cx, cy);
		if (area === 0) return;
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const px = x + 0.5, py = y + 0.5;
				const w0 = e(bx, by, cx, cy, px, py), w1 = e(cx, cy, ax, ay, px, py), w2 = e(ax, ay, bx, by, px, py);
				if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) this.set(x, y, c, a);
			}
		}
	}
	line(x0, y0, x1, y1, c, th = 1, a) {
		const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
		const r = th / 2;
		for (let i = 0; i <= n; i++) {
			const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
			if (th <= 1) this.set(Math.floor(x), Math.floor(y), c, a);
			else this.rect(x - r, y - r, th, th, c, a);
		}
	}
	textWidth(s, sc = 1) { return String(s).length * 6 * sc; }
	text(x, y, s, c, sc = 1, shadow = true) {
		const str = String(s).toUpperCase();
		const draw = (ox, oy, col) => {
			let cx = x + ox;
			for (const ch of str) {
				const g = FONT[ch] || FONT['?'];
				for (let r = 0; r < 7; r++) {
					for (let b = 0; b < 5; b++) {
						if ((g[r] >> (4 - b)) & 1) this.rect(cx + b * sc, y + oy + r * sc, sc, sc, col);
					}
				}
				cx += 6 * sc;
			}
		};
		if (shadow) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) draw(dx, dy, [0, 0, 0]);
		draw(0, 0, c);
	}
}

// ---------------------------------------------------------------- level data (eelvl.js toSimLevel JSON)
function decodeLevel(d) {
	const W = d.width | 0, H = d.height | 0;
	const int32 = (b64) => {
		const b = Buffer.from(b64 || '', 'base64');
		const a = new Int32Array(W * H);
		if (b.length === W * H * 4) for (let i = 0; i < W * H; i++) a[i] = b.readInt32LE(i * 4);
		return a;
	};
	const fg = int32(d.fg_b64), bg = int32(d.bg_b64);
	const rot = new Map(), portal = new Map();
	for (const e of d.extras || []) {
		const i = e[0], t = fg[i];
		if (t === 242 || t === 381) { if (!Array.isArray(d.portals)) portal.set(i, { rot: e[1] | 0, id: e[2] | 0, target: e[3] | 0 }); }
		else if (e[1] !== null && e[1] !== undefined) rot.set(i, e[1] | 0);
	}
	// exits per id: every entry of eeo-tas's portalLookup (`portals`: background and stale entries too), as eesim does
	const byId = new Map();
	if (Array.isArray(d.portals)) {
		for (const [i, r, id, target] of d.portals) {
			byId.set(id | 0, (byId.get(id | 0) || 0) + 1);
			if (fg[i] === 242 || fg[i] === 381) portal.set(i, { rot: r | 0, id: id | 0, target: target | 0 });
		}
	} else for (const p of portal.values()) byId.set(p.id, (byId.get(p.id) || 0) + 1);
	for (const p of portal.values()) p.random = p.target !== p.id && (byId.get(p.target) || 0) > 1;
	return { W, H, fg, bg, rot, portal };
}

// ---------------------------------------------------------------- colors
const BG = [16, 18, 24], BG_LAYER = [27, 30, 38], SOLID = [88, 97, 116], SOLID_EDGE = [62, 68, 82], DECO = [38, 42, 52];
const KEYC = { red: [235, 64, 64], green: [70, 200, 90], blue: [70, 120, 255], cyan: [60, 220, 230], magenta: [230, 80, 220], yellow: [240, 220, 60] };
const DOORC = (sub) => {
	for (const k of Object.keys(KEYC)) if (sub.startsWith(k)) return KEYC[k];
	if (/blue coin/.test(sub)) return [60, 140, 255];
	if (/coin/.test(sub)) return [230, 180, 30];
	if (/purple/.test(sub)) return [150, 80, 220];
	if (/orange/.test(sub)) return [240, 140, 40];
	if (/time/.test(sub)) return [60, 180, 170];
	if (/death/.test(sub)) return [150, 60, 60];
	return [160, 160, 170];
};
const LIQ = { water: [30, 90, 200], mud: [110, 80, 40], lava: [220, 90, 20], 'toxic waste': [90, 190, 40] };
function timeColor(f) {
	const a = [0, 229, 255], b = [255, 230, 0], c = [255, 59, 48];
	const mix = (p, q, u) => [0, 1, 2].map((i) => Math.round(p[i] + (q[i] - p[i]) * u));
	return f < 0.5 ? mix(a, b, f * 2) : mix(b, c, (f - 0.5) * 2);
}

function drawTile(cv, L, i, sx, sy, T, taken) {
	const id = L.fg[i];
	const k = B.kindOf(id);
	const rot = L.rot.get(i) | 0;
	if (L.bg[i]) cv.rect(sx, sy, T, T, BG_LAYER);
	const c = T / 2;
	switch (k.kind) {
		case 'empty': return;
		case 'solid':
			cv.rect(sx, sy, T, T, SOLID);
			if (T >= 8) cv.frame(sx, sy, T, T, SOLID_EDGE);
			return;
		case 'deco': cv.rect(sx, sy, T, T, DECO); return;
		case 'oneway': {
			const th = Math.max(2, Math.round(T / 4)), col = [185, 160, 105];
			const side = k.rotatable ? rot : 1;   // eesim overlaps(): rot 1 solid from above (top), 2 right, 3 bottom, 0 left
			if (side === 1) cv.rect(sx, sy, T, th, col);
			else if (side === 3) cv.rect(sx, sy + T - th, T, th, col);
			else if (side === 2) cv.rect(sx + T - th, sy, th, T, col);
			else cv.rect(sx, sy, th, T, col);
			return;
		}
		case 'half': {
			const h = T / 2;
			if (rot === 1) cv.rect(sx, sy + h, T, h, SOLID);
			else if (rot === 2) cv.rect(sx, sy, h, T, SOLID);
			else if (rot === 3) cv.rect(sx, sy, T, h, SOLID);
			else cv.rect(sx + h, sy, h, T, SOLID);
			return;
		}
		case 'door': {
			const col = DOORC(k.sub || '');
			cv.rect(sx, sy, T, T, col, 0.55);
			for (let d = 0; d < 2 * T; d += 4) cv.line(sx + Math.max(0, d - T), sy + Math.min(T - 1, d), sx + Math.min(T - 1, d), sy + Math.max(0, d - T), col, 1);
			if (T >= 6) cv.frame(sx, sy, T, T, col);
			return;
		}
		case 'arrow': case 'boost': {
			const col = k.kind === 'boost' ? [255, 140, 40] : (id >= 411 && id <= 413) || id === 1519 ? [60, 130, 170] : [90, 200, 255];
			const m = T * 0.18;
			if (k.dir === 'left') cv.tri(sx + m, sy + c, sx + T - m, sy + m, sx + T - m, sy + T - m, col);
			else if (k.dir === 'right') cv.tri(sx + T - m, sy + c, sx + m, sy + m, sx + m, sy + T - m, col);
			else if (k.dir === 'up') cv.tri(sx + c, sy + m, sx + m, sy + T - m, sx + T - m, sy + T - m, col);
			else cv.tri(sx + c, sy + T - m, sx + m, sy + m, sx + T - m, sy + m, col);
			return;
		}
		case 'dot': cv.disk(sx + c, sy + c, Math.max(1, T * 0.18), id === 414 ? [60, 130, 170] : [90, 200, 255]); return;
		case 'liquid': cv.rect(sx, sy, T, T, LIQ[k.sub] || [30, 90, 200], 0.75); return;
		case 'climbable': {
			const col = [150, 120, 80];
			cv.rect(sx + T * 0.3, sy, Math.max(1, T / 8), T, col); cv.rect(sx + T * 0.62, sy, Math.max(1, T / 8), T, col);
			return;
		}
		case 'spike': cv.tri(sx + c, sy + T * 0.15, sx + T * 0.15, sy + T * 0.85, sx + T * 0.85, sy + T * 0.85, [230, 50, 50]); return;
		case 'fire': cv.disk(sx + c, sy + c, T * 0.38, [255, 110, 0]); return;
		case 'coin': case 'bluecoin': {
			const col = k.kind === 'coin' ? [255, 205, 0] : [60, 140, 255];
			if (taken && taken.has(i)) cv.ring(sx + c, sy + c, Math.max(1.5, T * 0.34), 1, col, 0.5);
			else cv.disk(sx + c, sy + c, Math.max(1.5, T * 0.34), col);
			return;
		}
		case 'coin_taken': cv.ring(sx + c, sy + c, Math.max(1.5, T * 0.34), 1, [150, 130, 60]); return;
		case 'portal': {
			const p = L.portal.get(i);
			const col = k.sub === 'invisible' ? [140, 90, 190] : [200, 90, 255];
			cv.ring(sx + c, sy + c, Math.max(2, T * 0.45), Math.max(1, T / 7), col);
			if (p && p.random) cv.disk(sx + c, sy + c, Math.max(1, T * 0.16), [255, 255, 255]);
			return;
		}
		case 'worldportal': cv.ring(sx + c, sy + c, Math.max(2, T * 0.45), Math.max(1, T / 7), [255, 150, 60]); return;
		case 'key': cv.rect(sx + T * 0.2, sy + T * 0.3, T * 0.6, T * 0.4, KEYC[k.sub] || [255, 255, 255]); return;
		case 'switch': cv.rect(sx + T * 0.2, sy + T * 0.2, T * 0.6, T * 0.6, k.sub === 'orange' ? [240, 140, 40] : [150, 80, 220]); return;
		case 'reset': cv.ring(sx + c, sy + c, T * 0.35, 1, k.sub === 'orange' ? [240, 140, 40] : [150, 80, 220]); return;
		case 'crown': cv.tri(sx + T * 0.15, sy + T * 0.8, sx + c, sy + T * 0.2, sx + T * 0.85, sy + T * 0.8, [255, 200, 0]); return;
		case 'complete':
			cv.rect(sx, sy, T, T, [30, 170, 80]);
			if (T >= 6) { const q = T / 2; cv.rect(sx, sy, q, q, [230, 255, 230]); cv.rect(sx + q, sy + q, T - q, T - q, [230, 255, 230]); }
			return;
		case 'checkpoint': cv.tri(sx + T * 0.25, sy + T * 0.15, sx + T * 0.25, sy + T * 0.6, sx + T * 0.8, sy + T * 0.37, [60, 220, 90]); return;
		case 'spawn': cv.frame(sx + 1, sy + 1, T - 2, T - 2, [235, 235, 235]); return;
		case 'effect': cv.tri(sx + c, sy + T * 0.15, sx + T * 0.15, sy + c, sx + c, sy + T * 0.85, [80, 230, 200]); cv.tri(sx + c, sy + T * 0.15, sx + T * 0.85, sy + c, sx + c, sy + T * 0.85, [80, 230, 200]); return;
		case 'secret': cv.rect(sx, sy, T, T, [45, 45, 60]); return;
		default: cv.rect(sx, sy, T, T, DECO);
	}
}

/**
 * opts: { levelJson (object), trace (common.replay(..., {trace: true})), from, to (ticks), title, fmt (run time
 * formatter), margin (tiles, default 6), scale (px per tile; default: fit ~1800x1300), maxPx }
 * Returns { png, width, height, region: {x0, y0, x1, y1}, scale }
 */
function renderPath(opts) {
	const L = decodeLevel(opts.levelJson);
	const tr = opts.trace;
	const n = tr.n;
	const from = Math.max(0, Math.min(n, opts.from | 0)), to = Math.max(from, Math.min(n, opts.to === undefined ? n : opts.to | 0));
	const fmt = opts.fmt || ((t) => String(t));
	const margin = opts.margin === undefined ? 6 : opts.margin;
	// region: the window's path (box centres) plus a margin
	let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
	for (let t = from; t <= to; t++) {
		const cx = (tr.X[t] + 8) / 16, cy = (tr.Y[t] + 8) / 16;
		if (cx < minx) minx = cx; if (cx > maxx) maxx = cx; if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
	}
	let x0 = Math.floor(minx) - margin, x1 = Math.ceil(maxx) + margin, y0 = Math.floor(miny) - margin, y1 = Math.ceil(maxy) + margin;
	const minW = 24, minH = 14;
	if (x1 - x0 < minW) { const d = minW - (x1 - x0); x0 -= Math.floor(d / 2); x1 += Math.ceil(d / 2); }
	if (y1 - y0 < minH) { const d = minH - (y1 - y0); y0 -= Math.floor(d / 2); y1 += Math.ceil(d / 2); }
	x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(L.W - 1, x1); y1 = Math.min(L.H - 1, y1);
	const wT = x1 - x0 + 1, hT = y1 - y0 + 1;
	const maxW = (opts.maxPx && opts.maxPx[0]) || 1800, maxH = (opts.maxPx && opts.maxPx[1]) || 1300;
	let T = opts.scale ? Math.max(2, Math.min(48, opts.scale | 0)) : Math.max(2, Math.min(24, Math.floor(Math.min(maxW / wT, maxH / hT))));
	const LEFT = 30, TOP = 44;
	// at most maxPixels (default 60 Mpx, ~240 MB of canvas): a larger scale is lowered to fit (a whole big level at
	// scale 48 would take gigabytes and block the server for seconds)
	const maxPixels = opts.maxPixels || 60e6;
	const px = (t) => (LEFT + wT * t + 4) * (TOP + hT * t + 4);
	while (T > 2 && px(T) > maxPixels) T--;
	if (px(T) > maxPixels) throw new Error(`the region (${wT} x ${hT} tiles) is too large to draw; use a shorter time range or a smaller margin`);
	const W = LEFT + wT * T + 4, H = TOP + hT * T + 4;
	const cv = new Canvas(W, H, [10, 11, 15]);
	cv.rect(LEFT, TOP, wT * T, hT * T, BG);
	// coins collected before the window (hollow)
	const taken = new Set();
	for (const ev of tr.events || []) {
		if (ev.t > from) break;
		if ((ev.kind === 'coin' || ev.kind === 'blue_coin') && ev.data && ev.data.tile) taken.add(ev.data.tile.y * L.W + ev.data.tile.x);
	}
	for (let ty = y0; ty <= y1; ty++) {
		for (let tx = x0; tx <= x1; tx++) drawTile(cv, L, ty * L.W + tx, LEFT + (tx - x0) * T, TOP + (ty - y0) * T, T, taken);
	}
	// grid + coordinates
	const step = T >= 14 ? 5 : T >= 6 ? 10 : 20;
	for (let tx = Math.ceil(x0 / step) * step; tx <= x1; tx += step) {
		cv.rect(LEFT + (tx - x0) * T, TOP, 1, hT * T, [255, 255, 255], tx % (step * 2) === 0 ? 0.16 : 0.08);
		cv.text(LEFT + (tx - x0) * T + 1, TOP - 10, String(tx), [170, 175, 190], 1, false);
	}
	for (let ty = Math.ceil(y0 / step) * step; ty <= y1; ty += step) {
		cv.rect(LEFT, TOP + (ty - y0) * T, wT * T, 1, [255, 255, 255], ty % (step * 2) === 0 ? 0.16 : 0.08);
		cv.text(1, TOP + (ty - y0) * T - 3, String(ty), [170, 175, 190], 1, false);
	}
	// path: screen position of the box centre after t ticks (drawing clipped to the map area)
	cv.clip = [LEFT, TOP, LEFT + wT * T, TOP + hT * T];
	const SX = (t) => LEFT + ((tr.X[t] + 8) / 16 - x0) * T, SY = (t) => TOP + ((tr.Y[t] + 8) / 16 - y0) * T;
	const jump = (t) => Math.abs(tr.X[t + 1] - tr.X[t]) + Math.abs(tr.Y[t + 1] - tr.Y[t]) > 40;   // teleport / respawn
	const inView = (t) => { const x = SX(t), y = SY(t); return x >= LEFT - T && y >= TOP - T && x <= LEFT + (wT + 1) * T && y <= TOP + (hT + 1) * T; };
	for (let t = 0; t < n; t++) {
		if (t >= from && t < to) continue;
		if (!jump(t) && (inView(t) || inView(t + 1))) cv.line(SX(t), SY(t), SX(t + 1), SY(t + 1), [130, 130, 145], 1, 0.7);
	}
	const th = Math.max(2, Math.round(T / 6));
	for (let t = from; t < to; t++) {
		if (jump(t)) continue;
		cv.line(SX(t), SY(t), SX(t + 1), SY(t + 1), timeColor((t - from) / Math.max(1, to - from)), th);
	}
	// events in the window
	for (const ev of tr.events || []) {
		if (ev.t < from || ev.t > to) continue;
		const x = SX(ev.t), y = SY(ev.t);
		if (ev.kind === 'jump') cv.tri(x, y - th - 5, x - 4, y - th + 1, x + 4, y - th + 1, [255, 255, 255]);
		else if (ev.kind === 'portal' && ev.data) {
			const fx = LEFT + (ev.data.from.x + 0.5 - x0) * T, fy = TOP + (ev.data.from.y + 0.5 - y0) * T;
			cv.ring(fx, fy, Math.max(4, T * 0.6), 2, [255, 80, 255]);
			const ex = LEFT + (ev.data.to.x + 0.5 - x0) * T, ey = TOP + (ev.data.to.y + 0.5 - y0) * T;
			cv.ring(ex, ey, Math.max(4, T * 0.6), 2, [80, 255, 255]);
		} else if ((ev.kind === 'coin' || ev.kind === 'blue_coin') && ev.data) {
			cv.ring(LEFT + (ev.data.tile.x + 0.5 - x0) * T, TOP + (ev.data.tile.y + 0.5 - y0) * T, Math.max(4, T * 0.62), 2, [255, 255, 255]);
		} else if (ev.kind === 'death') {
			cv.line(x - 6, y - 6, x + 6, y + 6, [255, 40, 40], 3); cv.line(x - 6, y + 6, x + 6, y - 6, [255, 40, 40], 3);
		}
	}
	// ball (16x16 box = one tile) at the window's start and end
	const box = (t, col) => cv.frame(LEFT + (tr.X[t] / 16 - x0) * T, TOP + (tr.Y[t] / 16 - y0) * T, T, T, col, Math.max(1, Math.round(T / 8)));
	box(from, [60, 255, 120]);
	box(to, [255, 70, 70]);
	// time labels (run time), spaced so they do not pile up
	const span = to - from;
	const K = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((k) => span / k <= 16) || 20000;
	const placed = [];
	const free = (r) => placed.every((q) => r[0] >= q[2] || q[0] >= r[2] || r[1] >= q[3] || q[1] >= r[3]);
	const label = (t, force) => {
		const s = fmt(t), w = cv.textWidth(s), x = SX(t), y = SY(t);
		for (const [dx, dy] of [[6, -12], [6, 4], [-w - 6, -12], [-w - 6, 4], [-w / 2, -18], [-w / 2, 10]]) {
			const r = [x + dx - 1, y + dy - 1, x + dx + w + 1, y + dy + 8];
			if (force || free(r)) { placed.push(r); cv.disk(x, y, th + 1, [255, 255, 255]); cv.text(x + dx, y + dy, s, [255, 255, 255]); return; }
		}
	};
	label(from, true);
	label(to, true);
	const off = tr.RUN[to] > 0 ? to - tr.RUN[to] : 0;   // tick - run time while the timer runs: labels at round run times
	for (let t = Math.ceil((from + 1 - off) / K) * K + off; t < to; t += K) label(t, false);
	cv.clip = null;
	// header
	cv.text(4, 4, opts.title || '', [255, 255, 255]);
	cv.text(4, 16, 'PATH CYAN->YELLOW->RED = EARLY->LATE, LABELS = RUN TIME, GREEN BOX = START, RED BOX = END, GREY = REST OF RUN', [175, 180, 195], 1, false);
	cv.text(4, 26, 'O YELLOW/BLUE = COIN (HOLLOW = TAKEN), PURPLE RING = PORTAL (WHITE DOT = RANDOM EXIT), ^ = JUMP, TRIANGLES = ARROWS/BOOSTS', [175, 180, 195], 1, false);
	return { png: encodePng(W, H, cv.p), width: W, height: H, region: { x0, y0, x1, y1 }, scale: T };
}

module.exports = { renderPath, encodePng, Canvas, decodeLevel };

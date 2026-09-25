'use strict';
// The app icon (a fast yellow ball on a dark tile), drawn in code for EEAutoTAS.exe: makeIco() -> .ico bytes with
// 16, 24, 32, 48, 64 and 256 px images (PNG inside the .ico, supported since Windows Vista). Each size is drawn with
// 4x4 supersampling so small sizes stay crisp.
const zlib = require('zlib');

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
function pngRGBA(w, h, px) {
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Color [r, g, b, a] (0..1) of the icon at (u, v) in 0..1. */
function shade(u, v, size) {
	const out = [0, 0, 0, 0];
	const over = (c, a) => { for (let i = 0; i < 3; i++) out[i] = c[i] * a + out[i] * (1 - a); out[3] = a + out[3] * (1 - a); };
	// tile: rounded square, dark blue with a light top
	const r = 0.2, m = 0.02, qx = Math.max(Math.abs(u - 0.5) - (0.5 - m - r), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - m - r), 0);
	if (Math.hypot(qx, qy) <= r) over([0.10 + 0.08 * (1 - v), 0.13 + 0.10 * (1 - v), 0.22 + 0.14 * (1 - v)], 1);
	else return out;
	const cx = 0.60, cy = 0.52, R = 0.25;
	// speed lines behind the ball (fewer on tiny icons)
	const lines = size <= 24 ? [[0.44, 0.30]] : [[0.40, 0.26], [0.52, 0.34], [0.64, 0.24]];
	const lw = size <= 24 ? 0.07 : 0.045;
	for (const [ly, len] of lines) {
		const x1 = cx - 0.10, x0 = x1 - len;
		if (u >= x0 && u <= x1 && Math.abs(v - ly) <= lw / 2) over([0.45, 0.85, 1.0], 0.35 + 0.65 * (u - x0) / len);
	}
	// the ball: yellow with a darker rim, eyes and a smile
	const d = Math.hypot(u - cx, v - cy);
	if (d <= R) {
		over(d > R * 0.86 ? [0.80, 0.55, 0.05] : [1.0, 0.80 + 0.12 * (cy - v) / R, 0.10], 1);
		if (size >= 32) {
			const ex = 0.085, ey = cy - 0.06, er = 0.035;
			if (Math.hypot(u - (cx - ex), v - ey) <= er || Math.hypot(u - (cx + ex), v - ey) <= er) over([0.20, 0.12, 0.02], 1);
			const sd = Math.hypot(u - cx, v - (cy + 0.0));
			if (v > cy + 0.05 && Math.abs(sd - 0.14) <= 0.022) over([0.20, 0.12, 0.02], 1);
		}
	}
	return out;
}

function image(size) {
	const px = Buffer.alloc(size * size * 4), S = 4;
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const acc = [0, 0, 0, 0];
		for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
			const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, size);
			for (let i = 0; i < 3; i++) acc[i] += c[i] * c[3];
			acc[3] += c[3];
		}
		const a = acc[3] / (S * S), o = (y * size + x) * 4;
		for (let i = 0; i < 3; i++) px[o + i] = acc[3] ? Math.round(255 * acc[i] / acc[3]) : 0;
		px[o + 3] = Math.round(255 * a);
	}
	return pngRGBA(size, size, px);
}

function makeIco(sizes = [16, 24, 32, 48, 64, 256]) {
	const imgs = sizes.map(image);
	const head = Buffer.alloc(6 + 16 * sizes.length);
	head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
	let off = head.length;
	sizes.forEach((s, i) => {
		const e = 6 + 16 * i;
		head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s; head[e + 2] = 0; head[e + 3] = 0;
		head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
		head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(off, e + 12);
		off += imgs[i].length;
	});
	return Buffer.concat([head, ...imgs]);
}

module.exports = { makeIco, image };
if (require.main === module) {   // node tools/exe/icon.js out.png [size]: a preview
	require('fs').writeFileSync(process.argv[2] || 'icon.png', image(+process.argv[3] || 256));
}

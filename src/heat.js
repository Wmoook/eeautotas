'use strict';
// The exploration view of Find a route (the level editor's "exploration" layer, src/app/editor.html; the user, 2026-09-29:
// "a super cool ui that i can see all of the routes its trying like maybe the bg changes ... it has to be lightweight"):
//
//   THE HEAT: where the search has been, per tile. src/goexplore.js --heat=1 (the editor passes it; off by default: no
//   event, no mark) marks the tile of every cell its workers make and of every cell they pick (the CPU one
//   search), and of a time-bounded sample of the cells the GPU random runs register (--gpu=1: the run that reached the
//   cell, replayed on the host while the GPU plays the next batch), and prints the tiles marked since its last event at
//   most every HEAT_MS: {"ev":"heat","w":W,"h":H,"n":n,"enc":"idx"|"bits","tiles":"<base64>"} (heatEvent: the tile
//   indices as little-endian uint32, or a bitset of W x H bits when that is smaller). The editor (src/editor.js) merges
//   every strategy's heat events, and the tips of the other strategies' attempts (every move, the relay, the wall
//   breaker, the escape: their closest attempts and sources, sampled), into a HeatMap: per tile a visit count (uint16,
//   saturating: the updates that marked it) and the last visit (uint32 ms since the search's start), versioned: GET
//   /api/editor/solve/heat?since=<version> gives the tiles changed since that version, or every visited tile (since=0,
//   another search, or a version older than the change log keeps).
//
//   THE TRAILS: the latest attempts of every strategy (Trails, the newest TRAIL_MAX), each downsampled to at most
//   TRAIL_PTS points (downsample: whole px, the jumps of a portal or a respawn kept as breaks), with its strategy and
//   the time it came; the same endpoint gives those newer than ?trail=<id>. The page draws them as thin lines in the
//   strategy's colour, fading out over ~10 s.
//
// Nothing here changes a search: goexplore's marks are a byte per tile outside the memory budget (no draw, no budget, no
// order changes: the same seed makes the same search with the heat on or off: test/editor.js explore).
const HEAT_MS = 2000;        // goexplore.js prints a heat event at most this often
const HEAT_POST_MS = 1000;   // a worker's marks to the main thread at most this often
const TRAIL_MAX = 60, TRAIL_PTS = 200;
// (the change log of a HeatMap: the updates kept for ?since= deltas, at most this many tiles in all)
const LOG_TILES = 400000, LOG_ENTRIES = 512;

/** a set of marked tiles 0 .. N-1: mark(t) (each tile once until the next take), take() -> Int32Array of the tiles
 *  marked since the last take */
function heatMarks(N) {
	const f = new Uint8Array(N), list = new Int32Array(N);
	let n = 0;
	return {
		get n() { return n; },
		mark(t) { if (t >= 0 && t < N && f[t] === 0) { f[t] = 1; list[n++] = t; } },
		add(tiles) { for (let i = 0; i < tiles.length; i++) { const t = tiles[i]; if (t >= 0 && t < N && f[t] === 0) { f[t] = 1; list[n++] = t; } } },
		take() { const out = list.slice(0, n); for (let i = 0; i < n; i++) f[list[i]] = 0; n = 0; return out; },
	};
}

/** the heat event for tiles (indices 0 .. W x H - 1, each once): the indices (uint32 LE) or, when smaller, a bitset */
function heatEvent(W, H, tiles) {
	const N = W * H, n = tiles.length;
	if (4 * n <= Math.ceil(N / 8)) {
		const b = Buffer.alloc(4 * n);
		for (let i = 0; i < n; i++) b.writeUInt32LE(tiles[i] >>> 0, 4 * i);
		return { ev: 'heat', w: W, h: H, n, enc: 'idx', tiles: b.toString('base64') };
	}
	const b = Buffer.alloc(Math.ceil(N / 8));
	for (let i = 0; i < n; i++) { const t = tiles[i]; b[t >> 3] |= 1 << (t & 7); }
	return { ev: 'heat', w: W, h: H, n, enc: 'bits', tiles: b.toString('base64') };
}

/** the tiles of a heat event (Int32Array; out-of-range indices dropped); null when it is no heat event of a W x H level */
function heatTiles(ev, W, H) {
	if (!ev || ev.ev !== 'heat' || typeof ev.tiles !== 'string') return null;
	if ((W !== undefined && ev.w !== W) || (H !== undefined && ev.h !== H)) return null;
	const N = ev.w * ev.h;
	if (!(N > 0)) return null;
	const b = Buffer.from(ev.tiles, 'base64');
	if (ev.enc === 'bits') {
		const out = [];
		for (let i = 0; i < b.length; i++) { let v = b[i]; while (v) { const k = 31 - Math.clz32(v & -v); const t = i * 8 + k; if (t < N) out.push(t); v &= v - 1; } }
		return Int32Array.from(out);
	}
	const n = b.length >> 2, out = new Int32Array(n);
	let m = 0;
	for (let i = 0; i < n; i++) { const t = b.readUInt32LE(4 * i); if (t < N) out[m++] = t; }
	return m === n ? out : out.slice(0, m);
}

/** a W x H level's heat for one search: per tile its visit count (uint16, saturating) and last visit (ms since the
 *  search's start), versioned for the page's deltas */
class HeatMap {
	constructor(W, H) {
		this.W = W; this.H = H; this.N = W * H;
		this.count = new Uint16Array(this.N); this.last = new Uint32Array(this.N);
		this.version = 0; this.visited = 0; this.log = []; this.logTiles = 0;
		this.scratch = new Uint8Array(this.N);
	}
	/** tiles (each once) visited at tMs (ms since the search's start): their counts +1, their last visits tMs */
	merge(tiles, tMs) {
		if (!tiles || !tiles.length) return;
		const tm = Math.max(0, Math.min(0xffffffff, Math.round(tMs)));
		const c = this.count, l = this.last, N = this.N, keep = [];
		for (let i = 0; i < tiles.length; i++) {
			const t = tiles[i];
			if (!(t >= 0 && t < N)) continue;
			if (c[t] === 0) this.visited++;
			if (c[t] < 65535) c[t]++;
			l[t] = tm;
			keep.push(t);
		}
		if (!keep.length) return;
		this.version++;
		const tl = Int32Array.from(keep);
		this.log.push({ v: this.version, tiles: tl });
		this.logTiles += tl.length;
		while (this.log.length > 1 && (this.logTiles > LOG_TILES || this.log.length > LOG_ENTRIES)) this.logTiles -= this.log.shift().tiles.length;
	}
	/** the changes since version v: {version, full, n, idx, count, last} (base64: uint32 LE tiles, uint16 LE counts, uint32
	 *  LE last visits); every visited tile when v is 0, newer than this map's or older than the change log keeps */
	since(v) {
		v = Math.max(0, Math.floor(+v || 0));
		let tiles;
		const full = !(v > 0 && v <= this.version && this.log.length && this.log[0].v <= v + 1);
		if (v === this.version && v > 0) tiles = new Int32Array(0);
		else if (full) {
			const out = [];
			for (let t = 0; t < this.N; t++) if (this.count[t]) out.push(t);
			tiles = Int32Array.from(out);
		} else {
			const f = this.scratch, out = [];
			for (let k = this.log.length - 1; k >= 0 && this.log[k].v > v; k--) for (const t of this.log[k].tiles) if (f[t] === 0) { f[t] = 1; out.push(t); }
			for (const t of out) f[t] = 0;
			tiles = Int32Array.from(out);
		}
		const n = tiles.length, bi = Buffer.alloc(4 * n), bc = Buffer.alloc(2 * n), bl = Buffer.alloc(4 * n);
		for (let i = 0; i < n; i++) { const t = tiles[i]; bi.writeUInt32LE(t, 4 * i); bc.writeUInt16LE(this.count[t], 2 * i); bl.writeUInt32LE(this.last[t], 4 * i); }
		return { version: this.version, full: full && !(v === this.version && v > 0), n, visited: this.visited, idx: bi.toString('base64'), count: bc.toString('base64'), last: bl.toString('base64') };
	}
}

/** a path of [x, y] (px, per tick) as at most max points of whole px (flat [x0, y0, x1, y1, ...]) and the point indices
 *  where a new piece starts (a jump of more than 40 px between two ticks: a portal, a respawn); the last point kept */
function downsample(P, max = TRAIL_PTS) {
	const n = P ? P.length : 0, pts = [], br = [];
	if (!n) return { pts, br };
	const k = Math.max(1, Math.ceil(n / Math.max(2, max)));
	let last = -1;
	const push = (i) => { if (i === last) return; pts.push(Math.round(P[i][0]), Math.round(P[i][1])); last = i; };
	for (let i = 0; i < n; i++) {
		if (i > 0 && Math.abs(P[i][0] - P[i - 1][0]) + Math.abs(P[i][1] - P[i - 1][1]) > 40) {
			push(i - 1);
			br.push(pts.length / 2);
			push(i);
			continue;
		}
		if (i % k === 0 || i === n - 1) push(i);
	}
	return { pts, br };
}

/** the latest attempts of every strategy: add({k, label, t, ticks, pts, br}) (an id each), since(id) -> the newer ones */
class Trails {
	constructor(max = TRAIL_MAX) { this.max = max; this.list = []; this.id = 0; }
	add(o) {
		const x = Object.assign({ id: ++this.id }, o);
		this.list.push(x);
		if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
		return x;
	}
	since(id) { id = Math.max(0, Math.floor(+id || 0)); return this.list.filter((x) => x.id > id); }
}

module.exports = { HEAT_MS, HEAT_POST_MS, TRAIL_MAX, TRAIL_PTS, heatMarks, heatEvent, heatTiles, HeatMap, downsample, Trails };

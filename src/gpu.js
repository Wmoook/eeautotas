'use strict';
// The native engine (native/eecore.h: the physics of eesim.js in C++, bit for bit) and its GPU search, seen from JS:
// - levelBlob(level): the prepared level (eesim.js prepareLevel) as the flat binary the native side reads
//   (native/eecore.h struct Level; field order = BLOB_INTS / BLOB_ARRAYS below, shared with native/eegpu.cpp),
// - the path of the native tool (native/build/eegpu.exe, or next to the app in EEAutoTAS.exe) and a runner.
const fs = require('fs');
const path = require('path');
const E = require('./eesim.js');

const BLOB_MAGIC = 0x324c4545;   // 'EEL2'
const BLOB_VERSION = 1;
// int32 header fields, in this order (native/eegpu.cpp readLevel uses the same list)
const BLOB_INTS = ['W', 'H', 'N', 'nFlags', 'maxX', 'maxY', 'nPortals', 'nExIds', 'multiTargetPortals', 'rngScriptLen',
	'nCoins', 'coinWords', 'nSecrets', 'secretWords', 'nPortalCoins', 'pgWords', 'nSpawns', 'nSw', 'swWords', 'nOsw',
	'oswWords', 'nKeyColors', 'hasTimeDoors', 'hasCoinGate', 'hasBlueCoinGate', 'hasDeathDoor', 'hasDeathGate',
	'hasTeamEffect', 'startMode', 'idleTicks', 'startSpawn', 'hasStartSpawn', 'goldBorder', 'ticksPerFrame', 'offCoin',
	'offSecret', 'offPg', 'offSw', 'offOsw', 'tailWords', 'keyInts', 'nExits'];
// arrays, in this order: [name, element type]
const BLOB_ARRAYS = [['fg', 'i32'], ['lookup0', 'i32'], ['flags', 'u8'], ['xflags', 'u8'], ['ovl', 'u8'], ['airMask', 'u16'],
	['airPS', 'i32'], ['gMorx', 'i8'], ['gMory', 'i8'], ['gMox', 'f64'], ['gMoy', 'f64'], ['gFlags', 'u8'],
	['portalSlot', 'i32'], ['pId', 'i32'], ['pTarget', 'i32'], ['pRot', 'i32'], ['exIds', 'i32'], ['exOff', 'i32'],
	['exX', 'i32'], ['exY', 'i32'], ['exPc', 'i32'], ['rngScript', 'i32'], ['coinBit', 'i32'], ['coinTiles', 'i32'],
	['coinBaseId', 'i32'], ['secretBit', 'i32'], ['portalCoinIdx', 'i32'], ['spawnsX', 'i32'], ['spawnsY', 'i32'],
	['swIds', 'i32'], ['oswIds', 'i32'], ['keyColors', 'i32'], ['coinBits0', 'i32']];
const TYPED = { i32: Int32Array, u8: Uint8Array, i8: Int8Array, u16: Uint16Array, f64: Float64Array };
const KEY_IDS = { 6: 0, 7: 1, 8: 2, 408: 3, 409: 4, 410: 5 };

/** The prepared level (eesim.js prepareLevel) -> Buffer for the native engine. */
function levelBlob(L) {
	const W = L.width, H = L.height, N = W * H;
	// portal exits per id: ids ascending, each id's exits in lookup order (eesim.js portalsById)
	const ids = [...L.portalsById.keys()].sort((a, b) => a - b);
	const exOff = [0], exX = [], exY = [], exPc = [];
	for (const id of ids) {
		const t = L.portalsById.get(id);
		for (let k = 0; k < t.n; k++) { exX.push(t.xs[k]); exY.push(t.ys[k]); exPc.push(t.pc ? t.pc[k] : -1); }
		exOff.push(exX.length);
	}
	// switch ids any press can turn on: the numbers of switch / reset tiles (a 1000 presses 0..999 too)
	const sw = new Set(), osw = new Set();
	const keyColors = new Set();
	for (let i = 0; i < N; i++) {
		const t = L.fg[i];
		if (t === 113 || t === 1619) sw.add(L.lookup0[i]);
		else if (t === 467 || t === 1620) osw.add(L.lookup0[i]);
		if (KEY_IDS[t] !== undefined) keyColors.add(KEY_IDS[t]);
	}
	for (const s of [sw, osw]) if (s.has(1000)) for (let i = 0; i < 1000; i++) s.add(i);
	const swIds = [...sw].sort((a, b) => a - b), oswIds = [...osw].sort((a, b) => a - b);
	const nCoins = L.coinTiles.length, nSecrets = L.secretTiles.length;
	const pgWords = L.nPortalCoins > 0 ? L.portalGone0.length : 0;
	const swWords = Math.ceil(swIds.length / 32), oswWords = Math.ceil(oswIds.length / 32);
	const offCoin = 0, offSecret = offCoin + L.coinWords, offPg = offSecret + L.secretWords, offSw = offPg + pgWords;
	const offOsw = offSw + swWords, tailWords = offOsw + oswWords;
	// the hash's int slots (EESim._initKeyLayout)
	let keyInts = 16 + keyColors.size;
	for (const f of [L.hasTimeDoors, L.hasDeathDoor, L.hasCoinGate, L.hasBlueCoinGate, L.hasDeathGate, L.multiTargetPortals]) if (f) keyInts++;
	if (L.hasTeamEffect) keyInts += 2;
	if (nCoins) keyInts += L.coinWords;
	if (nSecrets) keyInts += L.secretWords;
	if (L.nPortalCoins > 0) keyInts += pgWords;
	if (keyInts & 1) keyInts++;
	const ints = {
		W, H, N, nFlags: L.flags.length, maxX: W * 16 - 16, maxY: H * 16 - 16, nPortals: L.pId.length, nExIds: ids.length,
		multiTargetPortals: L.multiTargetPortals ? 1 : 0, rngScriptLen: L.rngScript ? L.rngScript.length : -1,
		nCoins, coinWords: L.coinWords, nSecrets, secretWords: L.secretWords, nPortalCoins: L.nPortalCoins, pgWords,
		nSpawns: L.spawnsX.length, nSw: swIds.length, swWords, nOsw: oswIds.length, oswWords, nKeyColors: keyColors.size,
		hasTimeDoors: +L.hasTimeDoors, hasCoinGate: +L.hasCoinGate, hasBlueCoinGate: +L.hasBlueCoinGate,
		hasDeathDoor: +L.hasDeathDoor, hasDeathGate: +L.hasDeathGate, hasTeamEffect: +L.hasTeamEffect,
		startMode: L.startMode === 'load' ? 1 : 0, idleTicks: L.idleTicks | 0, startSpawn: L.startSpawn === null ? 0 : L.startSpawn | 0,
		hasStartSpawn: L.startSpawn === null ? 0 : 1, goldBorder: L.goldBorder ? 1 : 0, ticksPerFrame: L.ticksPerFrame | 0,
		offCoin, offSecret, offPg, offSw, offOsw, tailWords, keyInts, nExits: exX.length,
	};
	const arrays = {
		fg: L.fg, lookup0: L.lookup0, flags: L.flags, xflags: L.xflags, ovl: L.ovl, airMask: L.airMask, airPS: L.airPS,
		gMorx: L.gMorx, gMory: L.gMory, gMox: L.gMox, gMoy: L.gMoy, gFlags: L.gFlags, portalSlot: L.portalSlot,
		pId: L.pId, pTarget: L.pTarget, pRot: L.pRot, exIds: ids, exOff, exX, exY, exPc,
		rngScript: L.rngScript || [], coinBit: L.coinBit, coinTiles: L.coinTiles, coinBaseId: L.coinBaseId,
		secretBit: L.secretBit, portalCoinIdx: L.portalCoinIdx || [], spawnsX: L.spawnsX, spawnsY: L.spawnsY,
		swIds, oswIds, keyColors: [...keyColors].sort((a, b) => a - b), coinBits0: L.coinBits0,
	};
	// layout: magic, version, nInts, nArrays, ints, gravityMult (f64), rngSeed (u64), then (offset, count) per array
	const head = 16 + 4 * BLOB_INTS.length + 16 + 8 * BLOB_ARRAYS.length;
	let off = (head + 7) & ~7;
	const parts = [];
	const table = [];
	for (const [name, type] of BLOB_ARRAYS) {
		const T = TYPED[type];
		const a = T.from(arrays[name]);
		const bytes = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
		table.push([off, a.length]);
		parts.push({ off, bytes });
		off = (off + bytes.length + 7) & ~7;
	}
	const out = Buffer.alloc(off);
	out.writeUInt32LE(BLOB_MAGIC, 0); out.writeUInt32LE(BLOB_VERSION, 4);
	out.writeUInt32LE(BLOB_INTS.length, 8); out.writeUInt32LE(BLOB_ARRAYS.length, 12);
	let p = 16;
	for (const k of BLOB_INTS) {
		if (!Number.isInteger(ints[k])) throw new Error(`levelBlob: ${k} = ${ints[k]}`);
		out.writeInt32LE(ints[k], p); p += 4;
	}
	out.writeDoubleLE(L.gravityMult, p); p += 8;
	out.writeBigUInt64LE(E.RNG_SEED_STATE, p); p += 8;
	for (const [o, n] of table) { out.writeUInt32LE(o, p); out.writeUInt32LE(n, p + 4); p += 8; }
	for (const { off: o, bytes } of parts) bytes.copy(out, o);
	return out;
}

/** The native tool: next to this file in the exe's app folder (bin/), else the repo build. null when missing. */
function nativeTool() {
	for (const p of [path.join(__dirname, 'bin', 'eegpu.exe'), path.join(__dirname, '..', 'native', 'build', 'eegpu.exe')]) {
		if (fs.existsSync(p)) return p;
	}
	return null;
}

/**
 * Why the GPU engine cannot run this level (null = it can). The native engine's integer shortcuts for double tests
 * (native/eecore.h "exact integer forms") assume no NaN can occur: that holds when the gravity multiplier is finite
 * and not huge (every other number comes from finite tables); the state must also fit the kernels' largest tail.
 */
function unsupported(L) {
	const g = L.gravityMult;
	if (!Number.isFinite(g) || Math.abs(g) >= 1e300) return `the level's gravity multiplier (${g}) is not a normal number`;
	const blob = levelBlob(L);
	const tail = blob.readInt32LE(16 + 4 * BLOB_INTS.indexOf('tailWords'));
	if (tail > 512) return `the level needs ${tail} words of state per run (the GPU engine takes up to 512)`;
	return null;
}

// ---------------------------------------------------------------- the GPU benchmark (cached like src/bench.js)
const BENCH_FILE = () => path.join(require('./common.js').DATA, '_gpu.json');
function toolKey(tool) {
	try {
		const parts = [tool, ...[8, 32, 128, 512].map((tw) => path.join(path.dirname(tool), `eegpu_${tw}.ptx`))];
		return parts.map((f) => { const s = fs.statSync(f); return `${s.size}-${Math.round(s.mtimeMs)}`; }).join('|');
	} catch (e) { return ''; }
}
/** The cached benchmark record, or null when missing or made by another build of the native tool. */
function cachedBench() {
	const tool = nativeTool();
	if (!tool) return { gpu: null, why: 'the GPU engine is not part of this build' };
	try {
		const r = JSON.parse(fs.readFileSync(BENCH_FILE(), 'utf8'));
		return r.key === toolKey(tool) ? r : null;
	} catch (e) { return null; }
}
/**
 * Measures the GPU on src/bench.js's arena (random sticky inputs, the CPU benchmark's workload, so the numbers
 * compare): { gpu: {name, sms, ...} | null, why, ticksPerSec, nativeCpuSingle }. Cached in data/_gpu.json.
 */
function runBench() {
	return new Promise((resolve) => {
		const tool = nativeTool();
		if (!tool) return resolve({ gpu: null, why: 'the GPU engine is not part of this build' });
		const E2 = require('./eesim.js');
		const BENCH = require('./bench.js');
		const C = require('./common.js');
		const L = E2.prepareLevel(BENCH.arenaJson());
		const f = path.join(C.DATA, '_gpu_arena.bin');
		fs.mkdirSync(C.DATA, { recursive: true });
		fs.writeFileSync(f, levelBlob(L));
		require('child_process').execFile(tool, ['bench', f, '--seconds=3', '--ticks=24'], { encoding: 'utf8', timeout: 300000, windowsHide: true }, (err, out) => {
			let r;
			try { r = JSON.parse(String(out).trim().split('\n').pop()); } catch (e) { r = { gpu: null, why: err ? err.message : 'the GPU benchmark failed' }; }
			r.key = toolKey(tool);
			r.measured = Date.now();
			try { fs.writeFileSync(BENCH_FILE(), JSON.stringify(r, null, 1)); } catch (e) { /* read-only */ }
			resolve(r);
		});
	});
}
/** "NVIDIA GeForce RTX 3080 Laptop GPU: 150 M ticks/s (measured)" or why it is not available. */
function describeBench(r) {
	if (!r) return 'GPU: not measured yet';
	if (!r.gpu) return `GPU: not available (${r.why || 'no NVIDIA GPU found'})`;
	return `${r.gpu.name}: ${(r.ticksPerSec / 1e6).toFixed(0)} M ticks/s (measured)`;
}

module.exports = { levelBlob, nativeTool, unsupported, cachedBench, runBench, describeBench, BLOB_INTS, BLOB_ARRAYS };

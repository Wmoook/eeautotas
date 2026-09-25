'use strict';
// eelvl.js - Everybody Edits Offline level reader (.eelvl and .eelvls), exact to eeo-tas's own loader, plus
// the bridge to tools/tas/eesim.js (no Godot needed).
//
//   const { readEelvl, toSimLevel, loadEelvlLevel } = require('./eelvl.js');
//   const lvl = readEelvl(fs.readFileSync('level.eelvl'));   // header, fg/bg, per-block args, AS3 lookups
//   const simLevel = loadEelvlLevel('level.eelvl');           // = eesim.prepareLevel(toSimLevel(lvl))
//
// Format and every quirk: tools/tas/eeo_spec/eelvl_format.md. AS3 references (eeo-tas/src):
//   header    ui/campaigns/CampaignPage.as:598-625 (onFileLoaded), writer DownloadLevel.as:20-153
//   records   World.as:193-400 (deserializeFromMessage), readUShortArray World.as:182-191
//   arg kinds items/ItemId.as (isBlockRotateable 441-552, isNonRotatableHalfBlock 554-564,
//             isBlockNumbered 400-433, NpcArray 340-362) and World.as:259-283
//   .eelvls   ui/campaigns/CampaignPage.as:566-588 + com/nochump/util/zip/ZipFile.as
// Node built-ins only (fs, zlib). CommonJS.

const fs = require('fs');
const zlib = require('zlib');

// ------------------------------------------------------------------ ItemId.as
/** ItemId.isBlockRotateable (ItemId.as:441-552). Note: SHADOW_E 1608 and SHADOW_J 1613 are NOT in it. */
const ROTATABLE_IDS = [376, 375, 379, 380, 377, 378, 438, 439, 1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056,
  1092, 275, 327, 328, 273, 329, 440, 338, 339, 340, 276, 277, 279, 280, 447, 448, 449, 450, 451, 452, 1042, 1043,
  1041, 456, 457, 458, 464, 465, 1075, 1076, 1077, 1078, 471, 477, 475, 476, 481, 482, 483, 497, 492, 493, 494, 499,
  1502, 1500, 1507, 1506, 1116, 1117, 1118, 1119, 1120, 1121, 1122, 1123, 1124, 1125, 1535, 1135, 1134, 1536, 1537,
  1538, 1140, 1141, 1581, 1587, 1588, 1155, 1592, 1593, 1160, 1594, 1595, 1596, 1605, 1606, 1607, 1609, 1610, 1611,
  1612, 1614, 1615, 1616, 1617, 1597];
/** ItemId.isNonRotatableHalfBlock (ItemId.as:554-564): christmas 2016 presents. */
const NONROT_HALF_IDS = [1101, 1102, 1103, 1104, 1105];
/** ItemId.isBlockNumbered (ItemId.as:400-433). */
const NUMBERED_IDS = [43, 213, 165, 214, 113, 467, 184, 185, 1619, 1079, 1080, 1620, 1011, 1012, 1027, 1028, 423,
  421, 418, 1517, 417, 453, 461, 1584, 420, 419, 422, 1582];
/** GUITAR, DRUMS, PIANO (World.as:260). */
const MUSIC_IDS = [1520, 83, 77];
/** SPIKE and the 6 coloured spikes (World.as:261-262). The *_CENTER spikes (1580, 1626, ...) carry no args. */
const ROT_SPIKE_IDS = [361, 1625, 1627, 1629, 1631, 1633, 1635];
const PORTAL = 242, PORTAL_INVISIBLE = 381, TEXT_SIGN = 385, WORLD_PORTAL = 374, LABEL = 1000;
const SPAWNPOINT = 255, WORLD_PORTAL_SPAWN = 1582;
/** ItemId.NpcArray (ItemId.as:340-362): 1550-1559, 1569-1579. */
const NPC_IDS = [1550, 1551, 1552, 1553, 1554, 1555, 1556, 1557, 1558, 1559, 1570, 1569, 1571, 1572, 1573, 1574,
  1575, 1576, 1577, 1578, 1579];

/** Per-record argument kinds, in the precedence order of World.as:259-283. */
const ARG_NONE = 'none', ARG_INT = 'int', ARG_PORTAL = 'portal', ARG_SIGN = 'sign',
  ARG_WORLD_PORTAL = 'world_portal', ARG_LABEL = 'label', ARG_NPC = 'npc';
const INT_ARG_SET = new Set([...ROTATABLE_IDS, ...NONROT_HALF_IDS, ...NUMBERED_IDS, ...MUSIC_IDS, ...ROT_SPIKE_IDS]);
const NPC_SET = new Set(NPC_IDS);
function argKind(id) {
  if (INT_ARG_SET.has(id)) return ARG_INT;                                       // int32 rotation / number
  if (id === PORTAL || id === PORTAL_INVISIBLE) return ARG_PORTAL;               // int32 rotation, id, target
  if (id === TEXT_SIGN) return ARG_SIGN;                                         // UTF text, int32 type
  if (id === WORLD_PORTAL) return ARG_WORLD_PORTAL;                              // UTF target world, int32 spawn id
  if (id === LABEL) return ARG_LABEL;                                            // UTF text, UTF colour, int32 wrap
  if (NPC_SET.has(id)) return ARG_NPC;                                           // UTF name, 3x UTF message
  return ARG_NONE;
}

// ------------------------------------------------------------------ byte reader (flash.utils.ByteArray, BIG_ENDIAN)
class EOFError extends Error {}
class Reader {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  need(n) { if (this.p + n > this.b.length) throw new EOFError(`EOF: need ${n} bytes at ${this.p} of ${this.b.length} (AS3 Error #2030)`); }
  i32() { this.need(4); const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  u32() { this.need(4); const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  f32() { this.need(4); const v = this.b.readFloatBE(this.p); this.p += 4; return v; }
  f32bits() { this.need(4); return this.b.readUInt32BE(this.p); }
  bool() { this.need(1); return this.b[this.p++] !== 0; }
  utf() {  // readUTF: uint16 BE byte length + UTF-8 bytes
    this.need(2); const n = this.b.readUInt16BE(this.p); this.p += 2;
    this.need(n); const s = this.b.toString('utf8', this.p, this.p + n); this.p += n; return s;
  }
  /** World.readUShortArray (World.as:182-191), exact: uint32 byte length L, then ceil(L/2) big-endian uint16
   *  (the loop runs while i < L/2 with Number division), so an odd L reads one byte past L; the position ends
   *  at offset + 2*ceil(L/2) (offset itself when L == 0). */
  ushorts() {
    const len = this.u32();
    // `var length:int = readUnsignedInt()`: a length >= 2^31 becomes negative, the loop never runs and the
    // position stays right after the length field.
    if (len >= 0x80000000) return { arr: new Uint16Array(0), odd: false, negative: true };
    const count = Math.ceil(len / 2);
    this.need(2 * count);
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = this.b.readUInt16BE(this.p + 2 * i);
    this.p += 2 * count;
    return { arr: out, odd: (len & 1) === 1 };
  }
}

// ------------------------------------------------------------------ decompression
function isZlibHeader(b) { return b.length >= 2 && (b[0] & 0x0F) === 8 && (b[0] >> 4) <= 7 && ((b[0] << 8) | b[1]) % 31 === 0; }

/** Candidate decodings, most EEO-like first. EEO itself only does ByteArray.inflate() = raw DEFLATE
 *  (CampaignPage.as:598); zlib, gzip and uncompressed files are accepted here for convenience. */
function decodings(buf) {
  const out = [];
  try { out.push({ data: zlib.inflateRawSync(buf), compression: 'raw-deflate' }); } catch (e) { /* not raw deflate */ }
  if (isZlibHeader(buf)) { try { out.push({ data: zlib.inflateSync(buf), compression: 'zlib' }); } catch (e) { /* no */ } }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) { try { out.push({ data: zlib.gunzipSync(buf), compression: 'gzip' }); } catch (e) { /* no */ } }
  out.push({ data: buf, compression: 'none' });
  return out;
}

// ------------------------------------------------------------------ parsing
function readHeader(r) {
  const h = {};
  h.owner = r.utf();                  // CampaignPage.as:600
  h.name = r.utf();                   // :602
  h.width = r.i32();                  // :604
  h.height = r.i32();                 // :606
  h.gravityBits = r.f32bits();        // raw float32 bits
  h.gravity = r.f32();                // :608 readFloat -> Number (exact float32 value)
  h.bgColor = r.u32();                // :610 ARGB, custom background iff alpha == 0xFF (World.as:83)
  h.description = r.utf();            // :612
  h.campaign = r.bool();              // :614
  h.crewId = r.utf();                 // :616
  h.crewName = r.utf();               // :618
  h.crewStatus = r.i32();             // :620
  h.minimap = r.bool();               // :622
  h.ownerId = r.utf();                // :624
  return h;
}

/** Reads the block records (World.as:240-284) from r.p to the end. Returns raw records in file order. */
function readRecords(r, warnings, lenient) {
  const recs = [];
  while (r.p < r.b.length) {
    const start = r.p;
    try {
      const id = r.i32();
      const layer = r.i32();
      const xs = r.ushorts();
      const ys = r.ushorts();
      if (xs.odd || ys.odd) warnings.push(`record @${start} (id ${id}): odd coordinate byte length (AS3 reads one extra byte)`);
      if (xs.negative || ys.negative) warnings.push(`record @${start} (id ${id}): coordinate byte length >= 2^31 (AS3 reads 0 entries)`);
      const kind = argKind(id);
      let args = [];
      switch (kind) {
        case ARG_INT: args = [r.i32()]; break;
        case ARG_PORTAL: args = [r.i32(), r.i32(), r.i32()]; break;        // rotation, id, target
        case ARG_SIGN: args = [r.utf(), r.i32()]; break;                   // text, sign type
        case ARG_WORLD_PORTAL: args = [r.utf(), r.i32()]; break;           // target world, spawn id
        case ARG_LABEL: args = [r.utf(), r.utf(), r.i32()]; break;         // text, "#rrggbb", wrap length
        case ARG_NPC: args = [r.utf(), r.utf(), r.utf(), r.utf()]; break;  // name, message 1..3
        default: break;
      }
      recs.push({ id, layer, xs: xs.arr, ys: ys.arr, kind, args, offset: start });
    } catch (e) {
      if (!(e instanceof EOFError) || !lenient) throw e;
      warnings.push(`truncated record at byte ${start} of ${r.b.length} (${r.b.length - start} trailing bytes ignored; EEO would throw)`);
      r.p = r.b.length;
    }
  }
  return recs;
}

/** Plausibility check used only to pick the compression variant (EEO accepts anything that does not throw). */
function plausibleHeader(h) {
  return h.width >= 1 && h.height >= 1 && h.width <= 100000 && h.height <= 100000 && h.width * h.height <= 50e6;
}

function tryParse(data, hasHeader, opts) {
  const warnings = [];
  const r = new Reader(data);
  let h;
  if (hasHeader) {
    h = readHeader(r);
    if (!plausibleHeader(h)) throw new Error(`implausible size ${h.width}x${h.height}`);
  } else {
    h = { owner: '', name: '', width: 0, height: 0, gravityBits: 0x3f800000, gravity: 1.0, bgColor: 0, description: '',
      campaign: false, crewId: '', crewName: '', crewStatus: 0, minimap: true, ownerId: '' };
  }
  const dataPos = r.p;
  const records = readRecords(r, warnings, !!opts.lenient);
  for (const rec of records) {
    if (rec.id < 0) warnings.push(`negative block id ${rec.id} at byte ${rec.offset} (EEO stores it; eesim.prepareLevel rejects it on layer 0)`);
  }
  if (!hasHeader) {
    // ee_level.gd's headerless variant (not an EEO format): size = max coordinate + 1 over all records.
    let mx = 0, my = 0;
    for (const rec of records) { for (const v of rec.xs) if (v > mx) mx = v; for (const v of rec.ys) if (v > my) my = v; }
    h.width = opts.width || mx + 1; h.height = opts.height || my + 1;
    if (opts.gravity !== undefined) { h.gravity = Math.fround(opts.gravity); const t = Buffer.alloc(4); t.writeFloatBE(h.gravity); h.gravityBits = t.readUInt32BE(0); }
    if (opts.name !== undefined) h.name = opts.name;
    warnings.push('no header (raw block data): not loadable by EEO; width/height from max coordinates, gravity 1');
  }
  return { h, dataPos, records, warnings };
}

/**
 * Parses a .eelvl (raw deflate as EEO writes it, zlib, gzip or uncompressed; with header, or the headerless raw
 * block-data variant ee_level.gd also accepts).
 * opts: { lenient: false, width, height, gravity, name (headerless only) }
 * Returns { owner, name, width, height, gravity, gravityBits, bgColor, description, campaign, crewId, crewName,
 *   crewStatus, minimap, ownerId, compression, hasHeader, dataPos, fg, bg, blocks, records, lookup, spawnPoints,
 *   warnings } - see eeo_spec/eelvl_format.md section 10.
 */
function readEelvl(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length === 0) throw new Error('empty file');
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) throw new Error('this is a zip (.eelvls): use readEelvls()');
  let res = null, comp = null, hasHeader = true;
  const errors = [];
  const cands = decodings(buffer);
  for (const c of cands) {
    try { res = tryParse(c.data, true, opts); comp = c.compression; break; } catch (e) { errors.push(`${c.compression}: ${e.message}`); }
  }
  if (!res) {
    for (const c of cands) {
      try { res = tryParse(c.data, false, opts); comp = c.compression; hasHeader = false; break; } catch (e) { errors.push(`${c.compression} (headerless): ${e.message}`); }
    }
  }
  if (!res) throw new Error('not an .eelvl: ' + errors.join('; '));
  const { h, dataPos, records, warnings } = res;
  const W = h.width, H = h.height, N = W * H;
  if (comp !== 'raw-deflate') warnings.push(`compression ${comp}: EEO only loads raw deflate (ByteArray.inflate)`);

  // ---- World.deserializeFromMessage (World.as:193-400), exact
  const fg = new Int32Array(N), bg = new Int32Array(N);
  const blocks = [];
  const lookup = {
    int: new Map(),          // Lookup.lookup (getInt): index -> int (rotation / number), all layers, last write wins
    portals: new Map(),      // portalLookup: index -> {id, target, rotation, type}
    worldPortals: new Map(), // worldPortalLookup: index -> {target (string), spawnId}
    signs: new Map(),        // signLookup: index -> {text, type}
    labels: new Map(),       // labelLookup: index -> {text, color, wrap}
    npcs: new Map(),         // npcLookup: index -> {name, messages}
  };
  const spawnPoints = [];    // World.spawnPoints: spawn id -> [[x, y], ...] in load order (255 -> id 0)
  // function-scoped AS3 vars without initializer keep their value across records (World.as:248-255)
  let signText = null, signType = 0;
  let skipped = 0;
  for (const rec of records) {
    const { id, layer, xs, ys, kind, args } = rec;
    const rotation = kind === ARG_INT || kind === ARG_PORTAL ? args[0] : 0;     // `var rotation:int = 0` per record
    if (kind === ARG_SIGN) { signText = args[0]; signType = args[1]; }
    const tgt = layer === 0 ? fg : layer === 1 ? bg : null;
    for (let o = 0; o < xs.length; o++) {
      const nx = xs[o];
      const ny = o < ys.length ? ys[o] : 0;          // ys[o] undefined -> int 0
      if (nx >= W || ny >= H) { skipped++; continue; }
      const i = ny * W + nx;
      if (tgt === null) {                             // layers[layer] undefined: EEO throws TypeError #1010
        if (!opts.lenient) throw new Error(`layer ${layer} (block ${id}) at byte ${rec.offset}: EEO throws TypeError #1010 here`);
        continue;
      }
      tgt[i] = id;
      if (kind !== ARG_NONE) blocks.push({ x: nx, y: ny, layer, id, args });
      if (kind === ARG_INT) lookup.int.set(i, args[0]);                                            // :296-348
      else if (kind === ARG_PORTAL) lookup.portals.set(i, { id: args[1], target: args[2], rotation: args[0], type: id }); // :349-353
      else if (kind === ARG_WORLD_PORTAL) lookup.worldPortals.set(i, { target: args[0], spawnId: args[1] });              // :354-357
      if (id === SPAWNPOINT || id === WORLD_PORTAL_SPAWN) {                                         // :359-366
        if (!spawnPoints[rotation]) spawnPoints[rotation] = [];
        spawnPoints[rotation].push([nx, ny]);
      }
      if (id === LABEL) {                                                                          // :374-381, falls through
        lookup.labels.set(i, { text: args[0], color: args[1], wrap: args[2] });
        lookup.signs.set(i, { text: signText, type: signType });
      } else if (id === TEXT_SIGN) lookup.signs.set(i, { text: args[0], type: args[1] });          // :383-386
      if (kind === ARG_NPC) lookup.npcs.set(i, { name: args[0], messages: [args[1], args[2], args[3]] }); // :392-394
    }
  }
  if (skipped) warnings.push(`${skipped} block positions outside ${W}x${H} skipped (as EEO does)`);
  return {
    owner: h.owner, name: h.name, width: W, height: H, gravity: h.gravity, gravityBits: h.gravityBits,
    bgColor: h.bgColor, description: h.description, campaign: h.campaign, crewId: h.crewId, crewName: h.crewName,
    crewStatus: h.crewStatus, minimap: h.minimap, ownerId: h.ownerId,
    compression: comp, hasHeader, dataPos,
    fg, bg, blocks, records, lookup, spawnPoints, warnings,
  };
}

/** Parses an .eelvls (zip of .eelvl files, CampaignPage.as:566-588). Returns [{name, level}] in central
 *  directory order, keeping only entries whose text after the FIRST '.' is exactly "eelvl" (EEO's filter). */
function readEelvls(buffer, opts = {}) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b[i] === 0x50 && b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('invalid zip');
  const total = b.readUInt16LE(end + 10);
  let p = b.readUInt32LE(end + 16);
  const out = [];
  for (let k = 0; k < total; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('invalid CEN header (bad signature)');
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const loc = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    const type = name.substring(name.indexOf('.') + 1);
    if (type !== 'eelvl') continue;
    const lxlen = b.readUInt16LE(loc + 28);
    const ds = loc + 30 + name.length + lxlen;        // ZipFile.getInput uses the name's character count
    const raw = b.subarray(ds, ds + csize);
    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error('invalid compression method ' + method);
    out.push({ name, level: readEelvl(content, opts) });
  }
  return out;
}

// ------------------------------------------------------------------ bridge to eesim.js
function doubleHexLE(v) { const t = Buffer.alloc(8); t.writeDoubleLE(v); return t.toString('hex'); }
function int32ToB64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
const DRAG_HEX = {
  BASE_DRAG: '6accf435f866ef3f', ICE_NO_MOD_DRAG: 'fac64b3b25c8ef3f', ICE_DRAG: 'bebf054af2f0ef3f',
  NO_MOD_DRAG: '1db5c8e6e3f1ec3f', WATER_DRAG: '8dffc581bf70ee3f', MUD_DRAG: '1bcd6139b7d8e83f',
  LAVA_DRAG: 'b6e3faa08926ea3f', TOXIC_DRAG: '1db5c8e6e3f1ec3f',
};

/**
 * The level JSON that tools/tas/export_level.gd writes (eesim.prepareLevel input). `extras` follows ee_level.gd
 * exactly: a Dictionary index -> args of layer-0 positions whose record has args (ee_level.gd: layer != 1; the same
 * for every file EEO can load), keyed in first-insertion order, value replaced wholesale on a later write;
 * exported as [index, rotation|null, id|null, target|null].
 * Extra fields (ignored by prepareLevel) carry what EEO's loader knows beyond that: spawn_points (AS3 order),
 * world_portals, lookup_int, portals (AS3 lookups).
 */
function toSimLevel(p, opts = {}) {
  const W = p.width, H = p.height;
  const extra = new Map();
  for (const rec of p.records) {
    if (rec.kind === ARG_NONE || rec.layer !== 0) continue;   // ee_level.gd: layer 1 -> bg, else fg + extra
    const a = rec.args;
    let ex;
    if (rec.kind === ARG_INT) ex = [a[0], null, null];
    else if (rec.kind === ARG_PORTAL) ex = [a[0], a[1], a[2]];
    else if (rec.kind === ARG_WORLD_PORTAL) ex = [null, null, a[1]];
    else ex = [null, null, null];                  // sign / label / npc: no rotation/id/target keys
    for (let o = 0; o < rec.xs.length; o++) {
      const nx = rec.xs[o], ny = o < rec.ys.length ? rec.ys[o] : 0;
      if (nx >= W || ny >= H) continue;
      extra.set(ny * W + nx, ex);                  // Map.set keeps the first insertion position, like Dictionary
    }
  }
  const extras = [];
  for (const [i, ex] of extra) extras.push([i, ex[0], ex[1], ex[2]]);
  const spawn = [];
  for (let s = 0; s < p.spawnPoints.length; s++) spawn.push(p.spawnPoints[s] ? p.spawnPoints[s] : []);
  return {
    format: 'eesim-level-1',
    level_id: opts.id || '',
    level_file: opts.file || '',
    world_name: p.name,
    width: W,
    height: H,
    gravity_hex: doubleHexLE(p.gravity),
    gravity: p.gravity,
    fg_b64: int32ToB64(p.fg),
    bg_b64: int32ToB64(p.bg),
    extras,
    drag_hex: DRAG_HEX,
    // --- not read by eesim.prepareLevel (yet): EEO loader facts it currently ignores
    spawn_points: spawn,                                                        // World.spawnPoints[id] (load order)
    world_portals: [...p.lookup.worldPortals].map(([i, w]) => [i, w.target, w.spawnId]),
    lookup_int: [...p.lookup.int],                                              // [index, int] incl. layer 1 writes
    portals: [...p.lookup.portals].map(([i, q]) => [i, q.rotation, q.id, q.target, q.type]),
    header: { owner: p.owner, description: p.description, bgColor: p.bgColor, campaign: p.campaign, crewId: p.crewId,
      crewName: p.crewName, crewStatus: p.crewStatus, minimap: p.minimap, ownerId: p.ownerId,
      gravityBits: p.gravityBits, compression: p.compression, hasHeader: p.hasHeader },
  };
}

/** Reads a level file and returns eesim's prepared level object (what eesim.loadLevel returns for a JSON). */
function loadEelvlLevel(file, opts = {}) {
  const E = require('./eesim.js');
  const p = readEelvl(fs.readFileSync(file), opts);
  const path = require('path');
  const d = toSimLevel(p, { id: opts.id || path.basename(file).replace(/\.eelvl$/i, ''), file });
  return E.prepareLevel(d);
}

module.exports = {
  readEelvl, readEelvls, toSimLevel, loadEelvlLevel, argKind,
  ROTATABLE_IDS, NONROT_HALF_IDS, NUMBERED_IDS, MUSIC_IDS, ROT_SPIKE_IDS, NPC_IDS,
  PORTAL, PORTAL_INVISIBLE, TEXT_SIGN, WORLD_PORTAL, LABEL, SPAWNPOINT, WORLD_PORTAL_SPAWN,
  ARG_NONE, ARG_INT, ARG_PORTAL, ARG_SIGN, ARG_WORLD_PORTAL, ARG_LABEL, ARG_NPC,
};

// ------------------------------------------------------------------ CLI
// node tools/tas/eelvl.js <file.eelvl|.eelvls> [--json=<out.json>] [--id=<level id>]
if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.log('usage: node tools/tas/eelvl.js <file.eelvl|.eelvls> [--json=out.json] [--id=name] [--lenient]'); process.exit(1); }
  const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : undefined; };
  const lenient = args.includes('--lenient');
  const buf = fs.readFileSync(file);
  const list = /\.eelvls$/i.test(file) ? readEelvls(buf, { lenient }) : [{ name: file, level: readEelvl(buf, { lenient }) }];
  for (const { name, level: p } of list) {
    const ids = new Map();
    for (let i = 0; i < p.fg.length; i++) if (p.fg[i]) ids.set(p.fg[i], (ids.get(p.fg[i]) || 0) + 1);
    console.log(`${name}: "${p.name}" by "${p.owner}" ${p.width}x${p.height} gravity ${p.gravity} bg 0x${p.bgColor.toString(16)} ` +
      `(${p.compression}${p.hasHeader ? '' : ', headerless'}), ${p.records.length} records, ${p.blocks.length} blocks with args, ` +
      `${ids.size} fg ids`);
    for (const w of p.warnings) console.log('  warning: ' + w);
  }
  const out = opt('json');
  if (out) {
    const p = list[0].level;
    fs.writeFileSync(out, JSON.stringify(toSimLevel(p, { id: opt('id') || require('path').basename(file).replace(/\.eelvls?$/i, ''), file })));
    console.log('wrote ' + out);
  }
}

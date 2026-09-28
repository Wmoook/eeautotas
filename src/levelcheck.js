'use strict';
// Level file checks: is this file the level EEO plays? (2026-09-28: the user imported a damaged copy of Forgotten Helix,
// md5 3b03c5ea..., whose 182 gravity effects were all stored as 0 = down, and a whole night "proved" a level nobody plays
// has no route; EEO's own copy, md5 bed5116e..., routes. src/out/night/helix_refute.md.)
// - campaign: EEO has its campaign levels built in: eeo-tas media/campaigns/campaigns.zip, embedded in the game
//   (CampaignPage.as:52, read at 760-850: "<campaign>/<tier>.eelvl", ".info", "campaign.info" split on U+1399). A file
//   with the same name and size as one of them is compared with it cell by cell: the blocks of both layers, the numbers
//   and portals the game reads (the AS3 Lookup: position keyed, last write wins), world portals and the world gravity
//   (not signs, labels or NPC texts). A difference is said plainly ("this file differs from EEO's own copy of <name> in N cells (e.g. 160
//   gravity effects): the game plays its own copy"), and EEO's copy is offered instead (campaignCopy).
// - noops: effect blocks that can never do anything (listed with their cells): gravity effects all 0 = down (gravity starts
//   down, and only a gravity effect turns it), jump / speed / fly / protection / low gravity effects all off (what the ball
//   starts with), curse / zombie / poison effects that only lift an effect nothing gives, effect resets with nothing to
//   reset. Only where no other block can change that state (eesim.js 1901-2013: the pickups; 760-805: the resets).
// - md5: the file's md5, which every "no route" verdict names, so a wrong file shows.
// The eeo-tas folder is found like the EE graphics' (src/eegfx.js): settings.json "eegfxDir", else $EEO_TAS, else
// ~/eeo-tas; the first of them with media/campaigns/campaigns.zip. The zip is read with Node's zlib (no dependencies);
// its index (every level's entry, name, owner, size, md5, campaign title, tier) is kept in memory and in
// <data>/campaigns_index.json, keyed by the zip's path, size and time.
//   node src/levelcheck.js <level.eelvl> [...]      the checks of these files (and where campaigns.zip is)
//   node src/levelcheck.js --list                    the campaign levels EEO has built in
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const C = require('./common.js');
const EL = require('./eelvl.js');
const B = require('./blocks.js');

const INDEX_VERSION = 1;
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || (/[^aeiou]y$/.test(one) ? `${one.slice(0, -1)}ies` : `${one}s`)}`;

// ---------------------------------------------------------------- where campaigns.zip is
const ZIP_REL = path.join('media', 'campaigns', 'campaigns.zip');
/** {file, dir, source, why}: EEO's campaigns.zip (file null and why set when none is found) */
function campaignsZip() {
	const tried = [];
	const at = (dir, source) => {
		if (!dir) return null;
		const f = path.join(path.resolve(dir), ZIP_REL);
		try { if (fs.statSync(f).isFile()) return { file: f, dir: path.resolve(dir), source, why: null }; } catch (e) { /* none */ }
		tried.push(`${source === 'settings' ? 'the eeo-tas folder set in the viewer' : source === 'env' ? 'EEO_TAS' : path.resolve(dir)}: no ${ZIP_REL.replace(/\\/g, '/')}`);
		return null;
	};
	let s = {};
	try { s = C.readJSON(path.join(C.DATA, 'settings.json'), {}) || {}; } catch (e) { s = {}; }
	return at(s.eegfxDir, 'settings') || at(process.env.EEO_TAS, 'env') || at(path.join(os.homedir(), 'eeo-tas'), 'default') ||
		{ file: null, dir: null, source: null, why: `EEO's campaign levels were not found (${tried.join('; ')})` };
}

// ---------------------------------------------------------------- zip (store and deflate; Node's zlib)
/** The entries of a zip (central directory): [{name, method, csize, size, loc}] */
function zipEntries(b) {
	let end = -1;
	for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
		if (b[i] === 0x50 && b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
	}
	if (end < 0) throw new Error('not a zip file (no end of central directory)');
	const total = b.readUInt16LE(end + 10);
	let p = b.readUInt32LE(end + 16);
	const out = [];
	for (let k = 0; k < total; k++) {
		if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip (bad central directory entry)');
		const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
		out.push({ name: b.toString('utf8', p + 46, p + 46 + nlen), method: b.readUInt16LE(p + 10), csize: b.readUInt32LE(p + 20), size: b.readUInt32LE(p + 24),
			loc: b.readUInt32LE(p + 42) });
		p += 46 + nlen + xlen + clen;
	}
	return out;
}
/** One entry's bytes (stored or deflated) */
function zipRead(b, e) {
	if (e.loc + 30 > b.length || b.readUInt32LE(e.loc) !== 0x04034b50) throw new Error(`broken zip (bad local header of ${e.name})`);
	const ds = e.loc + 30 + b.readUInt16LE(e.loc + 26) + b.readUInt16LE(e.loc + 28);
	const raw = b.subarray(ds, ds + e.csize);
	if (e.method === 0) return Buffer.from(raw);
	if (e.method === 8) return zlib.inflateRawSync(raw);
	throw new Error(`${e.name}: zip method ${e.method} is not supported`);
}

// ---------------------------------------------------------------- the campaign index
let memo = null;   // {key, zip, levels, why}
const indexFile = () => path.join(C.DATA, 'campaigns_index.json');
const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
/**
 * EEO's campaign levels: {file, levels: [{entry, name, owner, width, height, md5, bytes, campaign, title, tier, tiers}],
 * why}. `tier` is 1-based (EEO's "tier 2/5" for 41/1.eelvl), `title` the campaign's name from campaign.info.
 */
function campaignIndex() {
	const z = campaignsZip();
	if (!z.file) return { file: null, levels: [], why: z.why };
	let st;
	try { st = fs.statSync(z.file); } catch (e) { return { file: null, levels: [], why: `cannot read ${z.file}: ${e.message}` }; }
	const key = `${INDEX_VERSION}|${z.file}|${st.size}|${Math.round(st.mtimeMs)}`;
	if (memo && memo.key === key) return memo;
	const disk = C.readJSON(indexFile(), null);
	if (disk && disk.key === key && Array.isArray(disk.levels)) { memo = { key, file: z.file, levels: disk.levels, why: null }; return memo; }
	let levels = [], why = null;
	try {
		const buf = fs.readFileSync(z.file);
		const ents = zipEntries(buf);
		const titles = new Map(), tiers = new Map();
		const text = (e) => zipRead(buf, e).toString('utf8').split(String.fromCharCode(0x1399));   // (CampaignPage.as: split on U+1399)
		for (const e of ents) {
			const m = /^([^/]+)\/(.+)$/.exec(e.name);
			if (!m) continue;
			if (m[2] === 'campaign.info') { try { titles.set(m[1], String(text(e)[1] || '').trim()); } catch (x) { /* broken entry */ } }
			else if (/\.info$/.test(m[2])) tiers.set(m[1], (tiers.get(m[1]) || 0) + 1);   // (maxTier: one per tier's .info)
		}
		for (const e of ents) {
			const m = /^([^/]+)\/(\d+)\.eelvl$/.exec(e.name);
			if (!m) continue;
			try {
				const bytes = zipRead(buf, e);
				const p = EL.readEelvl(bytes);
				levels.push({ entry: e.name, name: p.name, owner: p.owner, width: p.width, height: p.height, md5: md5(bytes), bytes: bytes.length,
					campaign: m[1], title: titles.get(m[1]) || '', tier: +m[2] + 1, tiers: tiers.get(m[1]) || 0 });
			} catch (x) { /* an entry EEO could not read either */ }
		}
	} catch (e) { why = `cannot read ${z.file}: ${e.message}`; levels = []; }
	memo = { key, file: z.file, levels, why };
	if (!why) { try { C.writeJSON(indexFile(), { key, levels }); } catch (e) { /* read-only data folder */ } }
	return memo;
}
/** the campaign levels with this name and size */
function campaignLevelsFor(name, width, height) {
	const n = normName(name);
	if (!n) return [];
	return campaignIndex().levels.filter((l) => normName(l.name) === n && l.width === width && l.height === height);
}
const copyMemo = new Map();   // entry -> {bytes, p} (the last few read)
/** EEO's own copy of a campaign level: its .eelvl bytes, exactly as in campaigns.zip (null when there is no such entry) */
function campaignCopy(entry) {
	const idx = campaignIndex();
	const l = idx.levels.find((x) => x.entry === entry);
	if (!l || !idx.file) return null;
	const k = `${idx.key}|${entry}`;
	if (copyMemo.has(k)) return copyMemo.get(k).bytes;
	const buf = fs.readFileSync(idx.file);
	const e = zipEntries(buf).find((x) => x.name === entry);
	if (!e) return null;
	const bytes = zipRead(buf, e);
	copyMemo.set(k, { bytes, p: null });
	if (copyMemo.size > 3) copyMemo.delete(copyMemo.keys().next().value);
	return bytes;
}
function campaignParsed(entry) {
	const bytes = campaignCopy(entry);
	if (!bytes) return null;
	const k = `${memo.key}|${entry}`, m = copyMemo.get(k);
	if (m && !m.p) m.p = EL.readEelvl(bytes);
	return m ? m.p : EL.readEelvl(bytes);
}

// ---------------------------------------------------------------- comparing a level with EEO's copy
const GRAV_DIR = ['down', 'left', 'up', 'right', 'none (zero gravity)'];
/** plural names for the blocks a difference is counted by (else "<n> <block name> blocks") */
const KIND_NAME = { 1517: 'gravity effect', 417: 'jump effect', 418: 'fly effect', 419: 'speed effect', 420: 'protection effect', 421: 'curse effect',
	422: 'zombie effect', 423: 'team effect', 453: 'low gravity effect', 461: 'multijump effect', 1584: 'poison effect', 1618: 'effect reset', 242: 'portal',
	381: 'invisible portal', 374: 'world portal', 43: 'coin door', 165: 'coin gate', 213: 'blue coin door', 214: 'blue coin gate', 100: 'coin', 101: 'blue coin',
	255: 'spawn point', 121: 'trophy', 360: 'checkpoint', 385: 'sign', 1000: 'label', 113: 'purple switch', 467: 'orange switch', 361: 'spike' };
const kindWord = (id, n) => (KIND_NAME[id] ? plural(n, KIND_NAME[id]) : `${n} ${B.blockName(id) || `block ${id}`} block${n === 1 ? '' : 's'}`);
/** what a cell holds for the game: [fg, bg, the number its foreground block reads (the Lookup's int: rotation, gravity
 *  direction, door count, ...; 0 when none), its portal entry (a stale one under another block is an exit too), world
 *  portal]. Signs, labels and NPC texts are left out: they change nothing in play, and a file saved again (the level
 *  editor's own round trip) may give a label another sign text (World.as keeps the last sign's text for a label). */
function cellOf(p, i) {
	const L = p.lookup, g = (m) => (m.has(i) ? JSON.stringify(m.get(i)) : '');
	const num = p.fg[i] && EL.argKind(p.fg[i]) === 'int' ? (L.int.has(i) ? L.int.get(i) : 0) : '';
	return [p.fg[i], p.bg[i], num, g(L.portals), g(L.worldPortals)];
}
/** a cell's value as words (for the examples): "gravity effect up", "block 9", "empty" */
function cellWords(p, i) {
	const id = p.fg[i];
	if (!id) return p.bg[i] ? `background ${B.blockName(p.bg[i]) || p.bg[i]}` : 'empty';
	const n = KIND_NAME[id] || B.blockName(id) || `block ${id}`;
	if (id === 1517) { const v = p.lookup.int.has(i) ? p.lookup.int.get(i) : 0; return `${n} ${GRAV_DIR[v] || v}`; }
	if (p.lookup.portals.has(i)) { const q = p.lookup.portals.get(i); return `${n} (rotation ${q.rotation}, id ${q.id} -> ${q.target})`; }
	if (p.lookup.int.has(i) && EL.argKind(id) === 'int') return `${n} ${p.lookup.int.get(i)}`;
	return n;
}
/**
 * p (readEelvl) against EEO's copy q of the same size: {cells (the cells that differ), kinds [{id, what, n}] most first,
 * examples [{x, y, here, eeo}], gravity: {here, eeo} | null (the world gravity multiplier, when it differs)}
 */
function diffLevels(p, q) {
	const W = p.width, N = W * p.height;
	let cells = 0;
	const kinds = new Map(), examples = [];
	for (let i = 0; i < N; i++) {
		const a = cellOf(p, i), b = cellOf(q, i);
		let same = true;
		for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { same = false; break; }
		if (same) continue;
		cells++;
		// counted by the block EEO's copy has there (else this file's; a background difference by the background block)
		const id = a[0] !== b[0] ? (b[0] || a[0]) : a[0] || (b[1] || a[1]);
		kinds.set(id, (kinds.get(id) || 0) + 1);
		if (examples.length < 12) examples.push({ x: i % W, y: Math.floor(i / W), here: cellWords(p, i), eeo: cellWords(q, i) });
	}
	const list = [...kinds].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([id, n]) => ({ id, n, what: kindWord(id, n) }));
	const gravity = p.gravityBits !== q.gravityBits ? { here: p.gravity, eeo: q.gravity } : null;
	return { cells, kinds: list, examples, gravity };
}
/**
 * The campaign match of a level (p: readEelvl): null (no campaign level of this name and size, or no campaigns.zip), else
 * {entry, name, title, tier, tiers, eeoMd5, same, cells, kinds, examples, gravity, text}: `same` = the game's cells and world
 * gravity equal EEO's copy (the bytes may differ: another writer); `text` the sentence for the page / import.
 */
function campaignMatch(p) {
	let cands;
	try { cands = campaignLevelsFor(p.name, p.width, p.height); } catch (e) { return null; }
	let best = null;
	for (const l of cands) {
		let q;
		try { q = campaignParsed(l.entry); } catch (e) { continue; }
		if (!q) continue;
		const d = diffLevels(p, q);
		const score = d.cells + (d.gravity ? 1 : 0);
		if (!best || score < best.score) best = { l, d, score };
		if (!score) break;
	}
	if (!best) return null;
	const { l, d } = best;
	const where = `${l.name} (campaign ${l.title || l.campaign}, level ${l.tier}${l.tiers ? ` of ${l.tiers}` : ''})`;
	const same = !d.cells && !d.gravity;
	const eg = d.kinds.slice(0, 2).map((k) => k.what).join(', ');
	const grav = d.gravity ? `the world gravity (${+d.gravity.here.toPrecision(7)} here, ${+d.gravity.eeo.toPrecision(7)} in EEO's copy)` : '';
	const text = same ? `The same blocks as EEO's own copy of ${where}.`
		: `This file differs from EEO's own copy of ${where} in ${d.cells ? `${plural(d.cells, 'cell')} (e.g. ${eg})` : ''}${d.cells && grav ? ' and ' : ''}${grav}: the game plays its own copy.`;
	return { entry: l.entry, name: l.name, title: l.title, campaign: l.campaign, tier: l.tier, tiers: l.tiers, eeoMd5: l.md5, same, cells: d.cells, kinds: d.kinds,
		examples: d.examples, gravity: d.gravity, text };
}

// ---------------------------------------------------------------- effect blocks that can never do anything
const cellText = (cells, max = 12) => `${cells.slice(0, max).map(([x, y]) => `(${x}, ${y})`).join(', ')}${cells.length > max ? ` and ${cells.length - max} more` : ''}`;
/**
 * The level's effect blocks that can never change anything (p: readEelvl): [{id, what, n, cells: [[x, y], ...], text}].
 * An effect block acts when the ball's centre enters its foreground cell, with the number the AS3 Lookup holds there
 * (eesim.js 1901-2013); the ball starts with no effect (eesim.js 608-617), and only these blocks change the states below.
 */
function noopEffects(p) {
	const W = p.width, N = W * p.height;
	const by = new Map();   // id -> [[x, y, value], ...]
	for (let i = 0; i < N; i++) {
		const id = p.fg[i];
		if (!((id >= 417 && id <= 423) || id === 453 || id === 461 || id === 1517 || id === 1584 || id === 1618 || id === 1573)) continue;
		if (!by.has(id)) by.set(id, []);
		by.get(id).push([i % W, Math.floor(i / W), p.lookup.int.has(i) ? p.lookup.int.get(i) : 0]);
	}
	const all = (id) => by.get(id) || [];
	const any = (id, f) => all(id).some((c) => f(c[2]));
	const out = [];
	// (lead: the claim, rest: why; the cells between them)
	const add = (id, cells, lead, rest) => out.push({ id, what: KIND_NAME[id] || B.blockName(id), n: cells.length, cells: cells.map((c) => [c[0], c[1]]),
		text: `${lead} (at ${cellText(cells)})${rest}.` });
	// gravity: 0 = down (the direction it starts in); only a gravity effect turns it (the effect reset turns it back down)
	const grav = all(1517);
	if (grav.length && grav.every((c) => c[2] === 0)) {
		add(1517, grav, `${grav.length === 1 ? 'The gravity effect (1517) is' : `All ${grav.length} gravity effects (1517) are`} set to 0 = down`,
			`: gravity starts down and nothing else in this level turns it, so ${grav.length === 1 ? 'it' : 'they'} can never do anything` +
			// (a few such blocks are often decoration; many are the sign of a copy that lost their directions, as Forgotten Helix's)
			(grav.length >= 3 ? '. A damaged copy of a level can lose their directions: check the file' : ''));
	}
	// the static effects: all set to what the ball starts with (jump / speed 0 = normal, fly / protection / low gravity 0 = off)
	for (const [id, what, val] of [[417, 'jump effect', 'normal jumps'], [419, 'speed effect', 'normal speed'], [418, 'fly effect', 'off'],
		[420, 'protection effect', 'off'], [453, 'low gravity effect', 'off']]) {
		const c = all(id);
		if (c.length && c.every((x) => x[2] === 0)) {
			add(id, c, `${c.length === 1 ? `The ${what} (${id}) is` : `All ${c.length} ${what}s (${id}) are`} set to 0 = ${val}`,
				`: the ball starts that way and nothing in this level changes it, so ${c.length === 1 ? 'it' : 'they'} can never do anything`);
		}
	}
	// the timed effects: a block with a number <= 0 lifts it; without a block that gives it (a number > 0; for zombie also
	// the zombie NPC 1573) it has nothing to lift
	for (const [id, what, extra] of [[421, 'curse', 0], [422, 'zombie', 1573], [1584, 'poison', 0]]) {
		const lift = all(id).filter((c) => c[2] <= 0);
		if (lift.length && !any(id, (v) => v > 0) && !(extra && all(extra).length)) {
			add(id, lift, `${lift.length === 1 ? `The ${what} effect (${id}) is` : `The ${lift.length} ${what} effects (${id}) are`} set to 0, which lifts the ${what} effect`,
				`, but nothing in this level gives it: ${lift.length === 1 ? 'it' : 'they'} can never do anything`);
		}
	}
	// the effect reset (1618) resets jump, speed, fly, protection, low gravity, multijump and gravity (eesim.js 1927-1933)
	const reset = all(1618);
	const gives = any(417, (v) => v !== 0) || any(419, (v) => v !== 0) || any(418, (v) => v !== 0) || any(420, (v) => v !== 0) || any(453, (v) => v !== 0) ||
		any(461, (v) => v !== 1) || any(1517, (v) => v !== 0);
	if (reset.length && !gives) {
		add(1618, reset, reset.length === 1 ? 'The effect reset (1618)' : `The ${reset.length} effect resets (1618)`,
			` reset${reset.length === 1 ? 's' : ''} jump, speed, fly, protection, low gravity, multijump and gravity effects, but nothing in this level gives the ball one: ` +
			`${reset.length === 1 ? 'it' : 'they'} can never do anything`);
	}
	return out;
}

// ---------------------------------------------------------------- the checks of a file
/**
 * The checks of a level file (buf: .eelvl bytes; p: its readEelvl result when the caller has it): {md5, name, width,
 * height, campaign (campaignMatch or null), noops (noopEffects), warnings (texts: a campaign difference, the no-ops),
 * notes (texts: "the same blocks as EEO's own copy"), campaigns (where the zip is, or why not)}.
 */
function checkLevel(buf, p) {
	if (!p) p = EL.readEelvl(buf);
	const campaign = p.hasHeader ? campaignMatch(p) : null;
	let noops = [];
	try { noops = noopEffects(p); } catch (e) { noops = []; }
	const warnings = [], notes = [];
	if (campaign) (campaign.same ? notes : warnings).push(campaign.text);
	for (const x of noops) warnings.push(x.text);
	const idx = memo || null;
	return { md5: buf ? md5(buf) : null, name: p.name, width: p.width, height: p.height, campaign, noops, warnings, notes,
		campaigns: idx ? { file: idx.file, levels: idx.levels.length, why: idx.why } : null };
}
/** a short form for meta.json / the page: the texts and the campaign match without its long lists */
function brief(r) {
	if (!r) return null;
	const c = r.campaign;
	return { md5: r.md5, warnings: r.warnings, notes: r.notes,
		campaign: c ? { entry: c.entry, name: c.name, title: c.title, tier: c.tier, tiers: c.tiers, eeoMd5: c.eeoMd5, same: c.same, cells: c.cells,
			kinds: c.kinds.slice(0, 6), examples: c.examples.slice(0, 6), gravity: c.gravity, text: c.text } : null,
		noops: r.noops.map((x) => ({ id: x.id, what: x.what, n: x.n, cells: x.cells.slice(0, 400), text: x.text })) };
}
/** "file <name>, md5 <md5>" for a verdict: the file a level came from (source {name, md5}, when the level is that file as
 *  opened), else the md5 of the bytes the verdict is about */
function fileTag(buf, source) {
	if (source && /^[0-9a-f]{32}$/.test(String(source.md5 || ''))) return `file ${String(source.name || 'level.eelvl').slice(0, 120)}, md5 ${source.md5}`;
	return `level file md5 ${md5(buf)}`;
}

module.exports = { campaignsZip, campaignIndex, campaignLevelsFor, campaignCopy, campaignMatch, diffLevels, noopEffects, checkLevel, brief, fileTag, md5,
	zipEntries, zipRead, GRAV_DIR };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
	const argv = process.argv.slice(2);
	if (argv.includes('--list')) {
		const idx = campaignIndex();
		if (!idx.file) { console.log(idx.why); process.exit(1); }
		console.log(`${idx.file}: ${idx.levels.length} levels`);
		for (const l of idx.levels) console.log(`  ${l.entry.padEnd(12)} ${l.name} (${l.width} x ${l.height}, ${l.owner}; campaign ${l.title || l.campaign}, level ${l.tier} of ${l.tiers}) md5 ${l.md5}`);
		process.exit(0);
	}
	const files = argv.filter((x) => !x.startsWith('--'));
	if (!files.length) { console.log('usage: node src/levelcheck.js <level.eelvl> [...] | --list'); process.exit(2); }
	for (const f of files) {
		const buf = fs.readFileSync(f);
		const r = checkLevel(buf);
		console.log(`${f}: "${r.name}" ${r.width} x ${r.height}, md5 ${r.md5}`);
		for (const s of r.notes) console.log(`  ${s}`);
		for (const s of r.warnings) console.log(`  WARNING: ${s}`);
		if (r.campaign && !r.campaign.same) for (const e of r.campaign.examples.slice(0, 6)) console.log(`    (${e.x}, ${e.y}): ${e.here} here, ${e.eeo} in EEO's copy`);
		if (!r.warnings.length && !r.notes.length) console.log(`  no findings${r.campaigns && r.campaigns.why ? ` (${r.campaigns.why})` : ''}`);
	}
}

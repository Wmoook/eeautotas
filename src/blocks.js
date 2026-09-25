'use strict';
// Block names and a coarse "kind" per block id, for humans and AI assistants (tas.js where / render). Names come
// from src/blocknames.json (generated from docs/eeo_spec/blocks.json = eeo-tas ItemManager.as). The id sets mirror
// eeo-tas ItemId.as and src/eesim.js; they are for display only - the physics lives in eesim.js.
const NAMES = (() => { try { return require('./blocknames.json'); } catch (e) { return {}; } })();

const set = (a) => new Set(a);
const CLIMBABLE = set([120, 118, 98, 99, 424, 459, 460, 472, 1534, 1146, 1563, 1602]);
const JUMP_THROUGH = set([61, 62, 63, 64, 89, 90, 91, 96, 97, 122, 123, 124, 125, 126, 127, 146, 154, 158, 194, 211, 216, 1069, 1087,
	1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1050, 1051, 1164, 1165, 1147, 1148, 1149, 1155, 1160]);
const ROT_ONEWAY = set([1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1155]);
const HALF = set([1041, 1042, 1043, 1075, 1076, 1077, 1078, 1101, 1102, 1103, 1104, 1105, 1116, 1117, 1118, 1119, 1120, 1121, 1122, 1123,
	1124, 1125, 1140, 1141]);
const SPIKES = set([361, 1580, 1625, 1626, 1627, 1628, 1629, 1630, 1631, 1632, 1633, 1634, 1635, 1636]);
const KEY_COLOR = { 6: 'red', 7: 'green', 8: 'blue', 408: 'cyan', 409: 'magenta', 410: 'yellow' };
const KEY_DOOR = { 23: 'red', 24: 'green', 25: 'blue', 26: 'red', 27: 'green', 28: 'blue', 1005: 'cyan', 1006: 'magenta', 1007: 'yellow',
	1008: 'cyan', 1009: 'magenta', 1010: 'yellow' };
const EFFECTS = set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1584, 1618]);
const OTHER_DOORS = { 43: 'coin door', 165: 'coin gate', 213: 'blue coin door', 214: 'blue coin gate', 156: 'time door', 157: 'time gate',
	184: 'purple switch door', 185: 'purple switch gate', 1079: 'orange switch door', 1080: 'orange switch gate', 1011: 'death door',
	1012: 'death gate', 200: 'gold door', 201: 'gold gate', 1094: 'crown door', 1095: 'crown gate', 1152: 'silver crown door',
	1153: 'silver crown gate', 1027: 'team door', 1028: 'team gate', 206: 'zombie gate', 207: 'zombie door', 50: 'secret (appears)' };
const ARROWS = { 1: 'left', 411: 'left', 2: 'up', 412: 'up', 3: 'right', 413: 'right', 1518: 'down', 1519: 'down' };
const BOOSTS = { 114: 'left', 115: 'right', 116: 'up', 117: 'down' };
const LIQUIDS = { 119: 'water', 369: 'mud', 416: 'lava', 1585: 'toxic waste' };

/** eesim.js's solidity rule (ItemId.isSolid): the id ranges minus climbables and two music blocks */
const isSolidId = (id) => !CLIMBABLE.has(id) && ((id >= 9 && id <= 97) || (id >= 122 && id <= 217) || (id >= 1001 && id <= 1499)) && id !== 83 && id !== 77;

/**
 * Coarse kind of a block id: empty, solid, oneway (rot = which side is solid), half, door (sub = what opens it),
 * arrow / boost (dir), dot, liquid, climbable, spike, fire, coin, bluecoin, coin_taken, portal, worldportal, key,
 * switch, reset, crown, complete, checkpoint, spawn, effect, secret, deco.
 */
function kindOf(id) {
	if (!id) return { kind: 'empty' };
	if (id === 100) return { kind: 'coin' };
	if (id === 101) return { kind: 'bluecoin' };
	if (id === 110 || id === 111) return { kind: 'coin_taken' };
	if (ARROWS[id]) return { kind: 'arrow', dir: ARROWS[id] };
	if (id === 4 || id === 414) return { kind: 'dot' };
	if (BOOSTS[id]) return { kind: 'boost', dir: BOOSTS[id] };
	if (LIQUIDS[id]) return { kind: 'liquid', sub: LIQUIDS[id] };
	if (CLIMBABLE.has(id)) return { kind: 'climbable' };
	if (SPIKES.has(id)) return { kind: 'spike' };
	if (id === 368) return { kind: 'fire' };
	if (id === 242 || id === 381) return { kind: 'portal', sub: id === 381 ? 'invisible' : '' };
	if (id === 374) return { kind: 'worldportal' };
	if (KEY_COLOR[id]) return { kind: 'key', sub: KEY_COLOR[id] };
	if (KEY_DOOR[id]) return { kind: 'door', sub: KEY_DOOR[id] + ((id >= 26 && id <= 28) || id >= 1008 ? ' key gate' : ' key door') };
	if (OTHER_DOORS[id]) return { kind: 'door', sub: OTHER_DOORS[id] };
	if (id === 113) return { kind: 'switch', sub: 'purple' };
	if (id === 467) return { kind: 'switch', sub: 'orange' };
	if (id === 1619 || id === 1620) return { kind: 'reset', sub: id === 1619 ? 'purple' : 'orange' };
	if (id === 5) return { kind: 'crown' };
	if (id === 121) return { kind: 'complete' };
	if (id === 360) return { kind: 'checkpoint' };
	if (id === 255 || id === 1582) return { kind: 'spawn' };
	if (EFFECTS.has(id)) return { kind: 'effect' };
	if (id === 243) return { kind: 'secret' };
	if (ROT_ONEWAY.has(id)) return { kind: 'oneway', rotatable: true };
	if (JUMP_THROUGH.has(id)) return { kind: 'oneway', rotatable: false };
	if (HALF.has(id)) return { kind: 'half' };
	if (isSolidId(id)) return { kind: 'solid' };
	return { kind: 'deco' };
}
function blockName(id) {
	if (!id) return 'empty';
	const n = NAMES[id];
	return n ? n[0] : `block ${id}`;
}
/** "9 Grey Gray Taupe [solid, basic]" */
function describe(id, rot) {
	if (!id) return '0 (empty)';
	const k = kindOf(id);
	const n = NAMES[id];
	const bits = [k.kind + (k.dir ? ' ' + k.dir : '') + (k.sub ? ' ' + k.sub : '')];
	if (k.kind === 'oneway' || k.kind === 'half') bits.push(`rotation ${rot | 0}`);
	if (n && n[1]) bits.push(n[1]);
	return `${id} ${blockName(id)} [${bits.join(', ')}]`;
}

module.exports = { kindOf, blockName, describe, isSolidId, KEY_COLOR };

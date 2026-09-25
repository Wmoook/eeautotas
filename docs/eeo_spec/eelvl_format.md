# EEO level files (.eelvl / .eelvls) and how eeo-tas loads them

Ground truth: `~\eeo-tas\src` (AS3). All `file:line` references are to that tree unless another path is
given. The level-loading code in eeo-tas is byte-identical to the original EE Offline (`~\ee-offline\src`):
`ui/campaigns/CampaignPage.as`, `DownloadLevel.as`, `Lookup.as`, `items/ItemId.as`, `Global.as`, `Portal.as`,
`WorldPortal.as`, `TextSign.as`, `LabelLookup.as` are unchanged, and the `World.as` diff touches only the key/time-door
timers and secret drawing (World.as:102-156, 1060-1073, 1099-1119, 1306, 1420), not `deserializeFromMessage`.

Node implementation: `tools/tas/eelvl.js` (section 10). Survey of the 35 sample levels: `level_survey.md`.

Contents
1. Container and compression
2. Load path (call graph)
3. Header
4. Block records
5. `World.deserializeFromMessage`: what the loader builds
6. Argument semantics per block id (who reads what)
7. Spawn points
8. Portals, world portals, determinism
9. The writer (`DownloadLevel.SaveLevel`)
10. `tools/tas/eelvl.js`
11. Differences between EEO and ee_level.gd / eesim.js

---

## 1. Container and compression

| file | bytes on disk | EEO reader |
|---|---|---|
| `.eelvl` | the level byte stream (sections 3-4) compressed with **raw DEFLATE** (RFC 1951, no zlib or gzip wrapper) | `ByteArray.inflate()` (CampaignPage.as:598, also :555, :579, :849) |
| `.eelvls` | a ZIP archive whose entries are complete `.eelvl` files (each still raw-deflated inside) | `com.nochump.util.zip.ZipFile` (CampaignPage.as:566-588) |

- `ByteArray.deflate()/inflate()` are raw DEFLATE (the writer is DownloadLevel.as:153). `ByteArray.inflate()` on a zlib
  stream (`78 xx ...`) or on uncompressed data throws `IOError #2058`, so **EEO only opens raw-deflate files**. Tools
  outside EEO produce other variants: `3d33/levels/forgotten_veil.eelvl` is zlib-wrapped (`78 da`) with an emptied
  header, `3d33/levels/ex_crew_odyssey.eelvl` is uncompressed block data with no header at all (it equals the bytes after
  the header of `Downloads/EX Crew Odyssey.eelvl`). All 35 files in `~\Downloads` are raw deflate with the
  full header.
- The inflated stream is read in place: `data.inflate(); data.position = 0;` then header, then records.
- Byte order is big-endian (the `ByteArray` default). Primitive encodings used below:

| name | AS3 call | encoding |
|---|---|---|
| `int` | `readInt` | 4 bytes, two's complement, BE |
| `uint` | `readUnsignedInt` | 4 bytes BE |
| `float` | `readFloat` | IEEE-754 binary32 BE, widened exactly to a Number (double) |
| `bool` | `readBoolean` | 1 byte, non-zero = true |
| `UTF` | `readUTF` | uint16 BE byte length, then that many UTF-8 bytes (writer: `writeUTF`, max 65535 bytes) |
| `u16[]` | `World.readUShortArray` (World.as:182-191) | see 4.2 |

## 2. Load path (call graph)

Opening a file ("Open level", CampaignPage.as:425-427):
1. `FileReference.browse` -> `onFileSelected` (468-471) -> `onFileLoaded(e)` (565-706).
2. If the file name ends in `s` (`.eelvls`, test at 566): `ZipFile(file.data)`; for every entry in central-directory order
   whose name, **after its first `.`**, is exactly `eelvl` (572-574): push a copy into `Global.worlds`, inflate the
   entry, read owner and name into `Global.worldNames`. Then `worldData = Global.worlds[0]` (587). A world whose name
   contains a `.` (entry `"01 - My.World - owner.eelvl"`) is silently dropped by that test.
3. `data.inflate(); data.position = 0;` (598-599), header (600-625, section 3).
4. A `NavigationEvent.JOIN_WORLD` carries `width, height, owner (crewName if non-empty), gravity, bg, minimap,
   spawn = worldSpawn` (664-673); `Global.worldInfo.*` gets every header field (689-701);
   `Global.newData = data; Global.dataPos = data.position` (703-704) = the offset of the first block record.
5. `EverybodyEdits.handleJoinWorld` (198-203) -> `joinDownloaded` (451-464) -> `handleJoinDownloaded` (467-577) ->
   `new PlayState(smiley, aura, auraColor, goldBorder, width, height, gravity, bgColour, worldSpawn)` (499-501).
6. `PlayState` constructor (states/PlayState.as:99-192):
   `rw, rh = width, height` (101-102); `gravityMultiplier = gravity` (104); `world = new World()` (107, `lookup.reset()`);
   **`world.deserializeFromMessage(rw, rh)`** (108, section 5); `setBackgroundColor(bgColor)` (109);
   `totalCoins/bonusCoins += world.getTypeCount(100/101)` (112-113, counts both layers, UI only);
   `player = new Me(...)` (115); `player.worldGravityMultiplier = gravityMultiplier` (116);
   `player.worldSpawn = worldSpawn` (122); **`player.placeAtSpawn()`** (123, section 7).
7. Campaign levels (embedded `media/campaigns/campaigns.zip`, CampaignPage.as:52, 754-968) go through the same
   `onFileLoaded(null, cWorld.worldData, tierData)` (1156-1172). For a non-trial campaign level with saved progress,
   `handleJoinDownloaded` then restores position, speed, coins, switches, effects etc. from the cookie
   (EverybodyEdits.as:520-566). Not relevant for a TAS of an opened file.

Other entry points that re-run `deserializeFromMessage` on the same `Global.newData` from `Global.dataPos`:
- `/loadlevel` (UI2.as:1662-1700): clears `spawnPoints` and `nextSpawnPos`, re-applies header gravity/size/bg, reloads
  blocks, `resetPlayer(true)`, `orangeSwitches = new ByteArray()`.
- `/resize` (UI2.as:1850-1889): reloads with a new size **without clearing `spawnPoints`** (spawns are appended again).
- Sub-world travel `joinWorld` -> `joinWorld2` (CampaignPage.as:493-523) saves the current world and loads
  `Global.worlds[i]` with `worldSpawn = i's portal target`.
- After any save, `DownloadLevel.fileSaved` (DownloadLevel.as:190-207) replaces `Global.newData` with the re-serialized
  level (section 9), so later reloads read the writer's record order.
- `createEmptyWorld` (CampaignPage.as:708-741) sets `dataPos = -1`; `deserializeFromMessage` then builds an empty world
  with a border of block 9 on layer 0 (World.as:218-235).

## 3. Header

In order, immediately at offset 0 of the inflated stream (reader CampaignPage.as:600-625, writer DownloadLevel.as:24-36):

| # | field | type | reader | EEO writes | used for |
|---|---|---|---|---|---|
| 1 | owner | UTF | 600 | owner, or the cookie username if owner is "player" | `worldInfo.owner`; display (crewName wins, 669); edit rights (EverybodyEdits.as:515-516) |
| 2 | world name | UTF | 602 | `Global.currentLevelname` | display; `Global.worldNames`; "Moderator Land" easter egg (below) |
| 3 | width | int | 604 | world width | **map width** (`PlayState.rw`); `World.overlaps` treats x > width*16-16 as solid (World.as:605) |
| 4 | height | int | 606 | world height | **map height** |
| 5 | gravity | float | 608 | `PlayState.gravityMultiplier` | **world gravity multiplier** (`Player.worldGravityMultiplier`, Player.as:347-352) |
| 6 | background | uint | 610 | `Global.currentBgColor` | ARGB colour; custom background iff alpha byte == 0xFF (World.as:83); drawing only |
| 7 | description | UTF | 612 | `ui2.description` | UI |
| 8 | campaign | bool | 614 | `worldInfo.campaign` | stored only (`Bl.data.isCampaignRoom` comes from the campaign page, not from this flag) |
| 9 | crew id | UTF | 616 | `""` | stored only |
| 10 | crew name | UTF | 618 | `""` | display owner if non-empty (669) |
| 11 | crew status | int | 620 | `0` | stored only |
| 12 | minimap | bool | 622 | `ui2.minimapEnabled` | UI |
| 13 | owner id | UTF | 624 | `"made offline"` | "Moderator Land" easter egg only |

Physics-relevant header fields: **width, height, gravity**. Notes:
- gravity is the exact float32 value widened to double (1.0 in every sample level; 0.8 would be `0.800000011920929`).
  EEO applies it unclamped: `gm = 1; if (low_gravity) gm *= 0.15; gm *= worldGravityMultiplier` (Player.as:347-352),
  used as `mox *= gravityMultiplier; moy *= gravityMultiplier` (Player.as:711-712). 0 or negative values are used as is
  (the `/gravity` command limits input to 0.1..3, UI2.as:1830-1849, but a file can hold anything).
- width/height are not validated on load. `height == 0` crashes `setMapArray` (BlTilemap.as:47-48 reads `map[0][0]`).
- Easter egg: world name "Moderator Land" + owner "stubby" + owner id "simple1298507192333x32" adds a fake player
  "mrvoid" (EverybodyEdits.as:503-507). Other players never collide with you.
- A non-1 gravity shows a one-time "Easter Egg!" popup (PlayState.as:117-120), no state change.

## 4. Block records

### 4.1 Record layout

After the header, records follow back to back until the end of the stream: `while (position < length)` (World.as:240).
Each record:

| field | type | reader |
|---|---|---|
| block id | int | World.as:241 |
| layer | int | :242 (0 = foreground/"action" layer, 1 = background) |
| xs | u16[] | :243 |
| ys | u16[] | :244 |
| args | depends on the id, 4.3 | :259-283 |

The record places block `id` on `layer` at every `(xs[o], ys[o])`. There is no record count and no terminator; a
truncated record makes `ByteArray` throw `EOFError #2030` and the level fails to load.

### 4.2 `readUShortArray` (World.as:182-191), exactly

```
L = readUnsignedInt() stored into `var length:int`   (so L >= 2^31 becomes negative)
offset = position
for (i = 0; i < L / 2; i++)                          (Number division: runs ceil(L/2) times)
    position = offset + 2*i
    arr[i] = (readUnsignedByte() << 8) | readUnsignedByte()
```
- Normal case (L even): L/2 big-endian uint16 values, position ends at offset + L.
- L odd: ceil(L/2) values; the last one takes one byte **past** L, and the position ends at offset + L + 1.
- L >= 2^31: negative, no values, the position stays at offset (the array bytes are not skipped).
- L == 0: empty array.
Coordinates are therefore 0..65535, never negative.

### 4.3 Record arguments

The id selects the argument layout; the tests run in this order (World.as:259-283), first match wins:

| kind | ids | args (in file order) | reader |
|---|---|---|---|
| **int** | `ItemId.isBlockRotateable` (105 ids, ItemId.as:441-552) + `isNonRotatableHalfBlock` (1101-1105, :554-564) + `isBlockNumbered` (28 ids, :400-433) + `GUITAR 1520, DRUMS 83, PIANO 77` + `SPIKE 361` and coloured spikes `1625, 1627, 1629, 1631, 1633, 1635` | `int rotation` | :259-263 |
| **portal** | `PORTAL 242`, `PORTAL_INVISIBLE 381` | `int rotation, int id, int target` | :264-267 |
| **sign** | `TEXT_SIGN 385` | `UTF text, int signType` | :268-270 |
| **world portal** | `WORLD_PORTAL 374` | `UTF targetWorld, int spawnId` | :271-273 |
| **label** | `LABEL 1000` | `UTF text, UTF colour ("#RRGGBB"), int wrapLength` | :274-277 |
| **npc** | `ItemId.NpcArray` = 1550-1559, 1569-1579 (ItemId.as:340-362, `isNPC` :682-684) | `UTF name, UTF message1, UTF message2, UTF message3` | :278-283 |
| none | every other id | nothing | |

Arguments are read **once per record** and apply to every position of the record.

The full "int" set (148 ids; `tools/tas/eelvl.js` checks itself against ItemId.as, and it equals
`ee_level.gd ROTATION_IDS` exactly):
- isBlockRotateable: 273 MEDIEVAL_SHIELD, 275 MEDIEVAL_AXE, 276-277 DOJO_LIGHT_LEFT/RIGHT, 279-280 DOJO_DARK_LEFT/RIGHT,
  327 MEDIEVAL_BANNER, 328 MEDIEVAL_COATOFARMS, 329 MEDIEVAL_SWORD, 338-340 TOOTH_BIG/SMALL/TRIPLE, 375-380 glowy lines
  (blue/yellow/green slope+straight), 438-439 glowy red slope/straight, 440 MEDIEVAL_TIMBER, 447-452 DOMESTIC_LIGHT_BULB,
  TAP, PAINTING, VASE, TV, WINDOW, 456-458 HALLOWEEN_2015 window rect/circle/lamp, 464-465 NEW_YEAR_2015 balloon/streamer,
  471 FAIRYTALE_FLOWERS, 475-477 SPRING daisy/tulip/daffodil, 481-483 SUMMER flag/awning/icecream, 492-494 RESTAURANT
  cup/plate/bowl, 497 CAVE_CRYSTAL, 499 HALLOWEEN_2016_ROTATABLE, **1001-1004 ONEWAY cyan/orange/yellow/pink**,
  **1041-1043 HALFBLOCK_DOMESTIC yellow/brown/white**, **1052-1056 ONEWAY gray/blue/red/green/black**, **1075-1078
  HALFBLOCK_FAIRYTALE orange/green/blue/pink**, **1092 ONEWAY_WHITE**, **1116-1125 HALFBLOCK white..purple**, 1134
  INDUSTRIAL_TABLE, 1135 INDUSTRIAL_PIPE_THICK, **1140-1141 HALFBLOCK_WINTER2018 snow/glacier**, **1155
  METAL_PLATFORM**, 1160 DUNGEON_PILLAR_TOP, 1500 HALLOWEEN_2016_PUMPKIN, 1502 HALLOWEEN_2016_EYES, 1506-1507
  CHRISTMAS_2016_LIGHTS up/down, 1535 INDUSTRIAL_PIPE_THIN, 1536-1538 DOMESTIC_PIPE_STRAIGHT/PIPE_T/FRAME_BORDER, 1581
  FIREWORKS, 1587 TOXIC_WASTE_BARREL, 1588 SEWER_PIPE, 1592-1595 DUNGEON_PILLAR_BOTTOM/MIDDLE, ARCH_LEFT/RIGHT, 1596
  SHADOW_A, 1597 DUNGEON_TORCH, 1605-1607 SHADOW_B-D, 1609-1612 SHADOW_F-I, 1614-1617 SHADOW_K-N.
  **Not** in the list: SHADOW_E 1608 and SHADOW_J 1613 (they carry no args).
- isNonRotatableHalfBlock: **1101-1105** HALFBLOCK_CHRISTMAS_2016_PRESENT red/green/white/blue/yellow.
- isBlockNumbered: **43 COINDOOR, 165 COINGATE, 213 BLUECOINDOOR, 214 BLUECOINGATE, 113 SWITCH_PURPLE, 184 DOOR_PURPLE,
  185 GATE_PURPLE, 1619 RESET_PURPLE, 467 SWITCH_ORANGE, 1079 DOOR_ORANGE, 1080 GATE_ORANGE, 1620 RESET_ORANGE, 1011
  DEATH_DOOR, 1012 DEATH_GATE, 1027 TEAM_DOOR, 1028 TEAM_GATE, 423 EFFECT_TEAM, 421 EFFECT_CURSE, 418 EFFECT_FLY, 1517
  EFFECT_GRAVITY, 417 EFFECT_JUMP, 453 EFFECT_LOW_GRAVITY, 461 EFFECT_MULTIJUMP, 1584 EFFECT_POISON, 420
  EFFECT_PROTECTION, 419 EFFECT_RUN, 422 EFFECT_ZOMBIE, 1582 WORLD_PORTAL_SPAWN**.
- music: 77 PIANO, 83 DRUMS, 1520 GUITAR. Spikes with rotation: 361, 1625, 1627, 1629, 1631, 1633, 1635.

No args (despite looking related): the `*_CENTER` spikes 1580, 1626, 1628, 1630, 1632, 1634, 1636; SPAWNPOINT 255;
CHECKPOINT 360; EFFECT_RESET 1618; RESET_POINT 466; keys 6/7/8/408/409/410 and their doors/gates 23-28, 1005-1010;
time door/gate 156/157; crown 5 and crown doors 1094/1095; trophy 121 and silver crown doors 1152/1153; coins 100/101
(and 110/111); gold doors 200/201; zombie gate/door 206/207; secrets 50/243; god block 1516; map block 1583; fire 368;
liquids; ice; gravity arrows 1-4, 411-414, 1518, 1519; speed arrows 114-117; climbables. The unused local
`var onStatus:Boolean` (World.as:254) shows that EE-online style on/off arguments are not part of the EEO format.

## 5. `World.deserializeFromMessage` (World.as:193-400): what the loader builds

State produced:
- `layers[2][height][width]` of ints, all 0 (204-216), then `setMapArray(layers)` (398) copies it into
  `realmap[layer][y][x]` (`Vector.<int>`; BlTilemap.as:42-77). **Physics reads layer 0 only** (`World.overlaps`,
  "Checks only in layer 0", World.as:581-751; `Player` uses `world.getTile(0, ...)`). `getTile` returns 0 out of bounds
  (BlTilemap.as:151-158).
- The `Lookup` tables (Lookup.as), keyed by the string `x + "x" + y` (Lookup.as:216-219), **no layer in the key**:
  `lookup` (ints: rotation/number), `portalLookup`, `worldPortalLookup`, `signLookup`, `labelLookup`, `npcLookup`.
  `lookup.reset()` runs first (201).
- `World.spawnPoints` (array indexed by spawn id of arrays of `[x, y]`), **appended to** (never cleared here).

Per record, in file order (240-396):
1. Read id, layer, xs, ys and the args (4.3). `rotation`, `id`, `tar` are re-initialised to 0 for every record
   (`var rotation:int = 0` etc., 245-247) and `messages = new Array()` (256). The other locals (`text, text_color,
   wrapLength, target_world, sign_text, sign_type, name`) are AS3 function-scoped without initialiser: they **keep the
   value from the previous record that set them** (null / 0 at first).
2. For each `o` in `0 .. xs.length-1` (288): `nx = xs[o]`, `ny = ys[o]` (if `ys` is shorter, `ys[o]` is undefined and
   `var ny:int` becomes 0).
   - `if (nx >= width || ny >= height) continue;` (292): out-of-range positions are dropped entirely (no lookup either).
   - `layers[layer][ny][nx] = type` (294). A layer other than 0/1 throws `TypeError #1010` here (level load fails);
     later records overwrite earlier ones at the same position (last write wins).
   - int-kind ids from isBlockRotateable / isNonRotatableHalfBlock / isBlockNumbered: `lookup.setInt(nx, ny, rotation)`
     (296-298); music 77/83/1520 (331-336) and the 7 rotatable spikes (339-348) do the same in the switch. So every
     int-kind id stores its int in `lookup` at (nx, ny).
   - portals 242/381: `lookup.setPortal(nx, ny, new Portal(id, tar, rotation, type))` (349-353).
   - world portal 374: `lookup.setWorldPortal(nx, ny, new WorldPortal(target_world, tar))` (354-357).
   - SPAWNPOINT 255 and WORLD_PORTAL_SPAWN 1582: `spawnPoints[rotation].push([nx, ny])` (359-366). For 255 `rotation`
     is 0 (no args), for 1582 it is the record's number: world-portal spawns with number 0 join the normal spawn list.
   - LABEL 1000: `lookup.setLabel(...)` plus a text object (374-381), then **falls through** (no `break`) into the
     TEXT_SIGN case: `lookup.setTextSign(nx, ny, new TextSign(sign_text, sign_type))` with the carried-over sign
     values (383-386). Harmless (display only).
   - TEXT_SIGN 385: `lookup.setTextSign` (383-386). BRICK_COMPLETE 121: nothing (388-390).
   - NPCs: `lookup.setNpc(nx, ny, name, messages, ItemManager.getNpcById(type))` (392-394).
3. Nothing else happens at load: no blink state (set only by editing, `setTileComplex` World.as:501-517, and by
   touching, Me.as:136-147, 186-191; drawing only), no secrets (revealed during play by `overlaps`), collected coins
   110/111 stay 110/111 until `resetPlayer` -> `world.resetCoins()` (Player.as:1287, World.as:402-409) turns them into
   100/101 (the PlayState constructor does not call it).

Consequences worth knowing:
- Lookups are position keyed across layers and are never cleared per cell during load. If two records write the same
  cell (never the case in files EEO writes, and not in any sample level), the tile is the last one, but the old
  lookups stay: e.g. a portal cell later overwritten by block 9 keeps its `portalLookup` entry, which
  `getPortals` still returns as a teleport destination (section 8), and an int written by a layer-1 record would
  change the foreground block's number.
- `Lookup.getInt` returns `lookup[...] || 0` (Lookup.as:70-73): 0 when unset; `getBoolean` returns the stored int
  coerced to Boolean (non-zero = true, Lookup.as:95-98); `getPortal` returns `new Portal(0, 0, 0)` when unset
  (Lookup.as:135-138).
- Unknown ids are kept in `realmap` (drawing just skips them, BlTilemap.as:102-137); physics treats them by id range
  (`ItemId.isSolid`, ItemId.as:366-372: 9-97, 122-217, 1001-1499 except climbables, 77 and 83). Negative ids are stored
  too.

## 6. Argument semantics per block id (who reads what)

"int" below is the record's single int, read back with `lookup.getInt(cx, cy)` unless stated.

| ids | meaning of the int | physics read site | notes |
|---|---|---|---|
| one-ways 1001-1004, 1052-1056, 1092, 1155 (`isRotatableHalfBlock`, ItemId.as:664-680) | direction: 1 = platform passable from below ("up"), 2 = "right", 3 = "down", 0 = "left" | World.as:634-661 | any other value: the one-way never skips, it collides as a full solid tile |
| half blocks 1041-1043, 1075-1078, 1116-1125, 1140-1141, 1101-1105 (`isHalfBlock`, ItemId.as:632-662) | which half is solid: 1 = bottom (y+8..16), 2 = left (x 0..8), 3 = top (y 0..8), 0 = right (x 8..16) | World.as:663-680 | other values: full tile. Player's "current tile" shift (Player.as:409-418): rot 1 -> `cy -= 1`, rot 0 -> `cx -= 1`; for 1101-1105 **only there** rot is forced to 1, while `overlaps` uses the file value |
| 1134, 1135, 1160 (solid rotatables that are not half/one-way) | none (full tile; 1160 is a plain jump-through) | | rotation is drawing only |
| all other isBlockRotateable ids | none | | non-solid decoration, drawing only |
| spikes 361, 1625-1635 odd | none | | kill test is by tile id (Player.as:538-551); rotation is drawing only |
| 43 COINDOOR / 213 BLUECOINDOOR | coins needed: passable iff `int <= coins` | World.as:724-725 | |
| 165 COINGATE / 214 BLUECOINGATE | passable iff `int > showCoinGate` (the PlayState-mirrored count) | World.as:727-728, PlayState.as:564-571 | |
| 1011 DEATH_DOOR / 1012 DEATH_GATE | deaths: door passable iff `int <= deaths`, gate iff `int > showDeathGate` | World.as:726, 729 | |
| 113 SWITCH_PURPLE | switch id; toggles `player.switches[id]`; **1000 = all ids 0..999** | Me.as:162-166, Player.as:1570-1580 | |
| 184 DOOR_PURPLE / 185 GATE_PURPLE | switch id | World.as:709-710 | |
| 1619 RESET_PURPLE | switch id (1000 = all): switches it off if on | Me.as:173-178 | |
| 467 SWITCH_ORANGE, 1079 DOOR_ORANGE, 1080 GATE_ORANGE, 1620 RESET_ORANGE | same with `world.orangeSwitches` | Me.as:167-171, 179-184; PlayState.as:227-237; World.as:712-713 | |
| 1027 TEAM_DOOR / 1028 TEAM_GATE | team id: door passable iff `team == int`, gate iff `team != int` | World.as:731-732 | team starts 0 |
| 423 EFFECT_TEAM | team id set on touch (with an overlap re-check) | Me.as:320-323, Player.as:1583-1600 | |
| 417 EFFECT_JUMP | `jumpBoost`: 0 off, 1 = jump x1.3, 2 = x0.75, other = no multiplier | Me.as:253-258, Player.as:354-358 | |
| 419 EFFECT_RUN | `speedBoost`: 0 off, 1 = speed x1.5, 2 = x0.6 | Me.as:265-270, Player.as:363-368 | |
| 418 EFFECT_FLY | levitation on iff int != 0 (`getBoolean`) | Me.as:259-264 | |
| 453 EFFECT_LOW_GRAVITY | on iff int != 0; gravity x0.15 | Me.as:271-276, Player.as:349 | |
| 420 EFFECT_PROTECTION | on iff int != 0 | Me.as:300-315 | |
| 461 EFFECT_MULTIJUMP | `maxJumps` (>= 1000 = infinite) | Me.as:337-342, Player.as:974-988 | |
| 1517 EFFECT_GRAVITY | `flipGravity` direction 0 down, 1 left, 2 up, 3 right (other values: no rotation) | Me.as:343-348, Player.as:641-... | |
| 421 EFFECT_CURSE / 422 EFFECT_ZOMBIE / 1584 EFFECT_POISON | duration in seconds; `> 0` switches it on | Me.as:277-294 | death when `ticks - start > (int + 2*0.2) * 100` evaluated in doubles (Player.as:399-403, 1724-1729, `Global.ping` = 0.2 Global.as:166-169): first fatal tick difference is `floor((int + 0.4) * 100) + 1`, e.g. 5 -> 541 but 20 -> 2040 (2039.9999999999998) |
| 1582 WORLD_PORTAL_SPAWN | spawn id: which `spawnPoints[]` list the tile joins | World.as:359-366 | section 7 |
| 77 PIANO / 83 DRUMS / 1520 GUITAR | note index | Me.as:136-147 (sound + blink) | no physics while valid (piano -27..60, drums 0..19, guitar 0..48, SoundManager.as:402-414); another number throws RangeError in touchBlock and aborts the rest of every tick that starts in the cell (ENGINE_NOTES "Block mechanics") |
| portal 242/381 | rotation (0 down, 1 left, 2 up, 3 right), own id, target id | Player.as:1087-1173 | section 8 |
| world portal 374 | target world string, spawn id | Player.as:1057-1085 | section 8 |
| sign 385, label 1000, NPCs | text | UI only | touching NPC_ZOMBIE 1573 gives zombie by id (Me.as:295-299), no args involved |

Values seen in the samples: switch ids 0-53, 69, 100, 200, 300, 1000; coin door counts 1-160; team ids 0-6; effect
ints 0/1 (jump, run, fly, low gravity, protection), multijump 1/2/5/6/8, gravity effect 0, curse 0-10, zombie 0-12.

## 7. Spawn points

- `World.spawnPoints[k]` holds the positions of 255 (k = 0) and 1582 (k = number) **in load order**: record order in
  the file, then xs order inside a record (World.as:359-366).
- `Player.placeAtSpawn(checkpoint)` (Player.as:1212-1238):
  ```
  nx = ny = 1
  if (checkpoint && checkpoint_x != -1) { nx, ny = checkpoint }
  else if (world.spawnPoints.length > 0) {
      if (!spawnPoints[worldSpawn]) spawnPoints[worldSpawn] = []
      spawnID = spawnPoints[worldSpawn].length > 0 ? worldSpawn : 0
      if (!nextSpawnPos[spawnID] || nextSpawnPos[spawnID] >= spawnPoints[spawnID].length) nextSpawnPos[spawnID] = 0
      if (spawnPoints[spawnID].length > 0) { nx, ny = spawnPoints[spawnID][nextSpawnPos[spawnID]]; nextSpawnPos[spawnID]++ }
  }
  x = nx * 16; y = ny * 16
  ```
  `worldSpawn` is 0 for an opened file. No spawn at all -> the player starts at tile (1, 1) = (16, 16) px (3 sample
  levels). Note `spawnPoints.length` is the array length (highest spawn id + 1), so a level whose only spawns are 1582
  with number 3 still enters the branch and falls back to (1, 1) via the empty `spawnPoints[0]`.
- Called by the PlayState constructor (the first spawn, `nextSpawnPos[0]` becomes 1) and by every `respawn()`
  (Player.as:1240-1263) with `checkpoint = true`, i.e. deaths without a checkpoint and `resetPlayer` (Player.as:1296).
  Several spawns are used round-robin.
- `nextSpawnPos` is cleared only by `/resetall` (UI2.as:1706-1710), `/loadlevel` (1665) and `/clear` (1723). `/reset`
  (UI2.as:1701-1705) keeps it: with n > 1 spawns, where a TAS starts after `/reset` depends on how many spawns
  happened since the level was loaded (a TAS start-state issue; see the TAS start spec).
- In files written by EEO all 255 tiles sit in one record in row-major order (section 9), so for 255-only levels the
  load order equals a y-then-x scan. It differs when 1582 tiles with number 0 exist: `A Music Extravaganza` loads
  `spawnPoints[0] = [[1,2] (the 1582), [118,171] (the 255)]`, so EEO spawns first at (1, 2), eesim at (118, 171).
- `Player.resetPlayer(false, false, wp.target)` from a world portal sets `worldSpawn` (Player.as:1267-1268); only
  reachable with the Y key (section 8).

## 8. Portals, world portals, determinism

Portals (Player.as:1051-1174, `processPortals`, runs every tick for the local player):
- Teleport only if not in god mode, the layer-0 tile at the player's centre cell is 242 or 381, and
  `getPortal(cx,cy).target != getPortal(cx,cy).id` (1087); nothing while `lastPortal` is set (1092).
- Destinations: `lookup.getPortals(target)` (Lookup.as:155-171) iterates **`for (var id:String in portalLookup)`** and
  returns every entry whose `id == target`, as `Point(x << 4, y << 4)`. It includes stale entries (5) and both portal
  types. The enumeration order is AVM2's hashtable order of the string keys `"XxY"`: unspecified by the language; do
  not assume insertion order or that it is the same from run to run.
- The pick is `portals[Math.floor(Math.random() * n)]` (`randomRange(0, n - 1)`, 1046-1049, 1099). **With n > 1 the
  destination is random (Math.random, unseeded) and not reproducible**; with n == 1 it is deterministic.
  14 of the 30 distinct sample levels have such portals (FV: 14 portals), see level_survey.md. eesim instead picks
  with an outcome script (rng.js) or a seeded PCG32 (`_randiRange`) over the insertion order of the same entries
  (toSimLevel `portals`), which is a stand-in for the unreproducible draw; the set of exits is EEO's.
- Rotations: `old = getPortal(entry).rotation`, `new = getPortal(dest).rotation`, `if (old < new) old += 4`,
  `dir = old - new` in {1, 2, 3} rotates speed/modifier by 90/180/270 degrees with factor 1.42 (1101-1157); any other
  dir (0, or out-of-range rotations) keeps the velocity.

World portals 374 (Player.as:1057-1085) and reset points 466 (Me.as:125-128) act only while the **"World Interaction"
key (Y, KeyBinding.as:21) is physically held** (`KeyBinding.risky.isDown()`). A `.eetas` byte only encodes jump, left,
right, up, down (tas/TASInput.as:26-33), so during TAS playback they never fire (unless someone holds Y). If they fire:
the target string is `parseInt`-ed into a world index; if `Global.isValidWorldIndex(id)` (Global.as:94-100: an
`.eelvls` sub-world other than the current one) the game travels there (`campaigns.joinWorld(id, spawnId)`), otherwise
it runs `resetPlayer(false, false, spawnId)` (a full level reset that also switches `worldSpawn`). Sample levels
converted from EE online carry room ids such as `"PWy17rcRUScEI"` (parseInt -> NaN -> 0).

Everything real-time or random that touches level data:
- `Math.random` portal pick above (Player.as:1048). The only random physics outcome in the load-dependent code.
- AS3 Object enumeration order: `Lookup.getPortals` (destination list order) and `DownloadLevel.SaveLevel` (record
  order of a saved file, section 9).
- Cake 337 picks a random smiley (`Random.nextInt`, Me.as:196): cosmetic.
- World portals / reset points depend on the real Y key.
- The loader itself (sections 3-5) uses no clock and no randomness.

## 9. The writer (`DownloadLevel.SaveLevel`, DownloadLevel.as:20-188)

Useful to know what files written by EEO look like (and why the samples are "clean"):
- Header as in section 3, with crew id/name `""`, crew status 0, owner id `"made offline"` (24-36).
- Blocks: for z = 0..1, y = 0..height-1, x = 0..width-1 (40-42), skipping 0; 110/111 are written as 100/101 (48-52).
  Blocks are grouped into an Object keyed by `id + "᎙" + z` (plain blocks) or `id + "᎙0᎙" + args...` (blocks with args;
  **the layer is hard-coded to 0**, 59-114). So each record holds one (id, layer, args) combination, positions in
  row-major order.
- Records are emitted by `for (var i:String in blocks)` (127): AVM2 hash order, not id order.
- Args are written by re-parsing the key (140-151): strings via `writeUTF` for sign text, label text/colour, world
  portal target and all NPC fields; the rest `writeInt` if the piece equals its `parseInt`, else `writeUTF`. A `᎙` inside
  a world-portal target, label colour or NPC name would corrupt the file (only sign text and NPC messages are stripped
  of it, World.as:427-435).
- `data.deflate()` (153). `.eelvls`: `ZipOutput` with entries `"NN - <world name> - <owner>.eelvl"` (164-181).
- The in-memory copy is inflated again and becomes `Global.newData` (fileSaved, 190-207).

The sample levels were converted from EE online (owner ids like `simple1282345507098x62`, crew ids, room-id world
portal targets) but have the same shape: one record per (id, layer, args), row-major positions, no duplicates, no
out-of-range positions, layers 0/1 only (checked for all 35).

## 10. `tools/tas/eelvl.js`

CommonJS, Node built-ins only (`fs`, `zlib`).

```js
const { readEelvl, readEelvls, toSimLevel, loadEelvlLevel } = require('./tools/tas/eelvl.js');
const p = readEelvl(fs.readFileSync(file));        // throws on anything EEO would fail on (unless {lenient: true})
const d = toSimLevel(p, { id, file });             // = the JSON export_level.gd writes (+ extra fields)
const level = loadEelvlLevel(file);                // = eesim.prepareLevel(toSimLevel(readEelvl(...)))
```

`readEelvl(buffer, opts)`:
- Compression: tries raw deflate (EEO's), zlib, gzip, uncompressed, each with the full header; the first that parses
  to the exact end wins. Then the headerless variant (block data only, as `3d33/levels/ex_crew_odyssey.eelvl`): size =
  max coordinate + 1 (or `opts.width/height`), gravity 1 (or `opts.gravity`, stored as float32). Warnings name
  anything EEO could not load (non raw-deflate, no header).
- Returns: header fields `owner, name, width, height, gravity, gravityBits (raw float32 bits), bgColor, description,
  campaign, crewId, crewName, crewStatus, minimap, ownerId`; `compression`, `hasHeader`, `dataPos`;
  `fg`, `bg` (`Int32Array`, index `y * width + x`, layers 0 and 1, last write wins);
  `blocks`: `{x, y, layer, id, args}` for every placed position of every record with args, file order, where `args` is
  `[rotation]`, `[rotation, id, target]`, `[text, signType]`, `[targetWorld, spawnId]`, `[text, colour, wrap]` or
  `[name, m1, m2, m3]`;
  `records`: the raw records `{id, layer, xs, ys, kind, args, offset}`;
  `lookup`: AS3-exact lookup tables as `Map(index -> value)`: `int`, `portals {id, target, rotation, type}`,
  `worldPortals {target, spawnId}`, `signs {text, type}` (including the label fall-through), `labels {text, color,
  wrap}`, `npcs {name, messages}`;
  `spawnPoints`: `World.spawnPoints` (spawn id -> `[[x, y], ...]`, load order); `warnings`.
- Mirrors every rule of section 5 (bounds skip, `ys` shorter -> 0, odd/huge `u16[]` lengths, carried-over sign values,
  position-keyed lookups across layers). Errors (like EEO): truncated record (`EOF`), layer not 0/1 at an in-range
  position. `{lenient: true}` turns both into warnings.

`readEelvls(buffer)` returns `[{name, level}]` for the zip entries EEO would load (first-dot rule, section 2).

`toSimLevel(p, {id, file})` returns the `eesim-level-1` object of `export_level.gd`: `width, height, gravity_hex`
(little-endian hex of the double), `gravity, fg_b64, bg_b64` (Int32 LE), `drag_hex`, and `extras` built exactly like
`ee_level.gd` builds `EELevel.extra`: layer-0 positions of records with args, keyed by index in **first insertion
order**, value replaced by a later write; exported as `[index, rotation|null, id|null, target|null]` (int kinds
`[i, r, null, null]`, portals `[i, r, id, target]`, world portals `[i, null, null, spawnId]`, sign/label/NPC
`[i, null, null, null]`). `prepareLevel` also reads `spawn_points` (AS3 order, per spawn id), `lookup_int` (the AS3
int lookup) and `portals` (the AS3 `portalLookup`: every entry is an exit, see section 8); it ignores `world_portals`
and `header`.

Verification (script run 2026-09-25):
- `3d33/levels/forgotten_veil.eelvl` (zlib) and `ex_crew_odyssey.eelvl` (headerless) -> `toSimLevel` equals
  `tools/tas/data/forgotten_veil.json` / `odyssey.json` in width, height, gravity, gravity_hex, fg_b64, bg_b64, drag
  values and the full `extras` list in order (306 / 168 entries); `prepareLevel` of both gives identical `fg, bg,
  lookup0, portalSlot, pId, pTarget, pRot, portalsById (order), spawnsX/Y, coin door thresholds, gravityMult`.
  The Downloads originals (raw deflate + full header) give the same.
- `forgotten_veil.eetas` replayed run.js-style on `loadEelvlLevel(...)`: 11539 ticks, complete at tick 11539,
  **run_ticks 11527**, 15 coins, 0 deaths (both the 3d33 and the Downloads file).
- All 35 `Downloads/*.eelvl` parse with no warning (level_survey.md). Synthetic tests cover zlib/gzip/uncompressed,
  headerless, every arg kind, the label fall-through, stale portal lookups, 1582 spawns, odd lengths, bad layers,
  truncation and `.eelvls` (stored and deflated entries, the first-dot filter).

CLI: `node tools/tas/eelvl.js <file.eelvl|.eelvls> [--json=out.json] [--id=name] [--lenient]` prints the header summary
and warnings and can write the eesim JSON (a Godot-free replacement for `export_level.gd`).

## 11. Differences between EEO and ee_level.gd / eesim.js (level data only)

| # | EEO | ee_level.gd / eesim.js | impact |
|---|---|---|---|
| 1 | first spawn = `spawnPoints[0][0]` in **load order**, list includes 1582 tiles with number 0 | scan order of 255 only (`prepareLevel` spawnsX/Y) | wrong start/respawn tile when 1582-0 exists (A Music Extravaganza) or when a non-EEO file lists spawns out of row-major order |
| 2 | portal destination random (`Math.random`) over hash-ordered `portalLookup` incl. stale and background entries | eesim.js: an outcome script (rng.js) or seeded PCG over the insertion order of the same `portalLookup` (toSimLevel `portals`: stale and layer-1 entries are exits; an entry on a coin cell is deleted when the coin is collected, as `setTileComplex` does) | inherent: EEO is not reproducible when a target id has n > 1 portals (14/30 levels); an optimizer must avoid or accept every outcome |
| 3 | raw deflate only | Godot `COMPRESSION_DEFLATE` is zlib-wrapped: EEO's own files fail and fall into the headerless branch (garbage); server.js re-wraps as a workaround | fixed by eelvl.js |
| 4 | gravity used as stored | `level.gravity if > 0 else 1.0` | only for gravity <= 0 |
| 5 | lookups position keyed across layers, never removed at load (stale portal/int entries survive an overwrite) | ee_level.gd: one Dictionary entry per layer-0 index, replaced wholesale; layer-1 args ignored. eesim.js: the AS3 lookups themselves (`lookup_int`, `portals`), the Dictionary only for old JSON without them | none for eesim.js with toSimLevel JSON; ee_level.gd: files with duplicate positions or layer-1 args (none written by EEO, none in samples) |
| 6 | `u16[]` odd length: ceil(L/2) values, skips 2*ceil(L/2); L >= 2^31: 0 values, no skip | floor(L/2) values, skips L; guard stops parsing | corrupt files only |
| 7 | layer not 0/1 -> load fails; truncated record -> load fails | layer != 1 -> foreground; trailing < 8 bytes ignored | corrupt files only |
| 8 | headerless files cannot be opened | headerless heuristic `raw[0] == 0 && raw[1] == 0` (misfires on an uncompressed file with an empty owner), name hard-coded "EX Crew Odyssey" | tooling only |
| 9 | 110/111 in a file become 100/101 at the first `resetPlayer` | kept as 110/111 (never collectible) | files with collected coins only (none in samples) |
| 10 | world portals 374 / reset points 466 need the Y key | not implemented | inert under a TAS: correct to ignore |

## 12. Noticed outside this area (for the owners of those specs)

These are not level-format issues, but they decide whether block ids from the survey behave as in eeo-tas:
- **Keys and time doors use eeo-tas's tick clock, not EE Offline's `World.offset`.** eeo-tas World.as:117-123,
  137-156: `setKey` stores `keysTimer[color] = Global.playState.ticks` (an int) and a key expires when
  `(ticks - keysTimer) / 100 >= 5`, i.e. exactly 500 ticks; the time door state is
  `setTimedoor((Global.playState.ticks / 100) % 10 >= 5)` every update, a global phase (open/closed flips at
  PlayState.ticks = 500, 1000, 1500, ...; `/reset` sets ticks to 0, UI2.as:1703). EE Offline (ee-offline World.as
  :117-160) used `offset += 0.3` with `/30 >= 5` and toggled the time door 150 offset units after the last toggle.
  eesim.js (lines ~528, 626-633, 1529-1532) and ee_sim.gd implement the EE Offline model (500 or 501 ticks, drifting
  time-door period), not eeo-tas's. 15 of the 30 distinct sample levels have keys, 5 have time doors.
- **Zombie gate/door are swapped in ee_sim.gd / eesim.js.** AS3 World.as:734-735: `ZOMBIE_GATE (206): if
  (!pl.zombie) continue` (a non-zombie passes 206) and `ZOMBIE_DOOR (207): if (pl.zombie) continue` (207 blocks a
  non-zombie). eesim `_doorPassable` returns false for 206 and true for 207 (ee_sim.gd:1158-1159). No sample level uses
  them.
- **Gold doors 200/201 depend on a user setting.** `wearsGoldSmiley` comes from the cookie's gold-border option
  (EverybodyEdits.as:499-501 -> PlayState.as:128; toggled by `setGoldBorder`, EverybodyEdits.as:368-380). eesim assumes
  it is off. The optimizer needs this as a run parameter (1 sample level uses 200).
- Timed effects: see the 421/422/1584 row of section 6 (eeo-tas counts PlayState ticks, EE Offline used `Date`).

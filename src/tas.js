'use strict';
// EE Auto TAS command line: inspect and steer optimizer jobs from a terminal (for power users and AI assistants).
// Works with or without the web app running: it reads and writes the same files (src/jobs/<id>/). `node src/tas.js help`
const fs = require('fs');
const path = require('path');
const C = require('./common.js');
const J = require('./jobs.js');
// how to call this CLI: EEAutoTAS.exe sets EEAT_EXE to its own path
const CMD = process.env.EEAT_EXE ? `"${process.env.EEAT_EXE}" tas` : 'node src/tas.js';

const HELP = `EE Auto TAS - command line (${CMD} <command> ...)

  jobs                                   list the jobs (id, state, original -> best time)
  status <job>                           one job in detail: times, odds, stage, inbox, focus, recent improvements, log
  where <job> <time|tick>                the run's state at that moment: position (tiles), velocity, tiles around the
                                         ball, coins/keys/switches, the inputs before/after, next events, ASCII map
  render <job> [from] [to] [out.png]     PNG of the level around the path in that range (path colored by time,
                                         run-time labels, coins/portals/arrows marked, tile coordinates on the edges)
  replay <job|file.eetas> [--level=<job>]  summary + timeline (coins, portals, random exits, deaths) + EEO odds
  probe <job> <time|tick> "<inputs>"     test an idea exactly: play these inputs (format of where's "next 100 ticks",
                                         e.g. "R+J x3, R x20, - x5") from the best run's exact state at that time, then
                                         look for an EXACT rejoin with the best run; writes a verified candidate
                                         (--try hands it to the job right away)
  try <job> <file.eetas>                 verify a candidate run and hand it to the job (running: via its inbox, the
                                         grind decides within seconds; stopped: decided here, best.eetas updated)
  focus <job> <from> <to> [seconds]      search that window harder (explore --exact, shortcuts, mutate, splice) and
                                         hand every faster result to the job (default 120 s per search)
  import <level.eelvl> <run.eetas> [--name=..] [--start=reset|load]   create a job (like the web app's Import);
                                         --start: how the TAS was started in eeo-tas: reset = after /reset (default,
                                         the eeo-tas README workflow), load = /playtas right after loading the level
                                         (only matters on levels with 2+ spawn points or time doors)
  start <job> [--workers=N]              start optimizing in the background (keeps running without the web app)
  stop <job>                             stop optimizing
  finish <job>                           stop and write the final report (report.json)

  <job>   a job id, a unique prefix of it, or part of its name ("jobs" lists them)
  times   m:ss.cc = in-game run time (1:10.25; 1:10 = 1:10.00; 70.25s), a plain number = tick index (7025),
          start / end. Tick = input byte index; run time = the in-game timer (starts at the first input).
  options --json (where, replay, status, jobs, try: machine-readable output), --file=<run.eetas> (where, render,
          replay: another run on the job's level), --wait=<s> (try: wait for a running job's verdict, default 60),
          --source=<text> (try: shown in the job history), --workers=N (focus, start), --scale=<px per tile>,
          --margin=<tiles> (render)

The web app (START.bat / npm start, http://localhost:47823) has the same functions as a JSON API: GET /api.
See CLAUDE.md for the workflow ("the user thinks X is possible at 1:10") and README.md for humans.`;

const a = C.parseArgs(process.argv.slice(2));
const [cmd, ...pos] = a._;
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const json = (o) => out(JSON.stringify(o, null, 1));
const fmt = C.fmt;

function jobRun(id) {
	const file = a.file ? path.resolve(a.file) : path.join(J.jobDir(id), 'best.eetas');
	return { file, masks: C.readEetas(file), level: J.loadJobLevel(id) };
}

async function main() {
	switch (cmd) {
		case undefined: case 'help': case '--help': case '-h': out(HELP); return;
		case 'jobs': {
			const list = J.listJobs();
			if (a.json) return json(list.map((s) => ({ id: s.id, name: s.name, state: s.state, original: s.original, best: s.best, savedTicks: s.savedTicks, chance: s.chance, stage: s.stage })));
			if (!list.length) return out(`no jobs yet: import one with the web app or \`${CMD} import <level.eelvl> <run.eetas>\``);
			for (const s of list) {
				out(`${s.id.padEnd(40)} ${s.state.padEnd(8)} ${s.original.time} -> ${s.best.time}` +
					`${s.savedTicks > 0 ? `  (-${(s.savedTicks / 100).toFixed(2)} s)` : ''}${s.chance < 1 ? `  odds ${J.pct(s.chance)}` : ''}${s.running ? `  now: ${s.stage}` : ''}  "${s.name}"`);
			}
			return;
		}
		case 'status': {
			const s = J.summary(J.resolve(pos[0]));
			return a.json ? json(s) : out(J.formatStatus(s));
		}
		case 'where': {
			if (pos.length < 2) throw new Error('usage: where <job> <time|tick>');
			const id = J.resolve(pos[0]);
			const r = jobRun(id);
			const w = J.where(r.level, r.masks, pos[1]);
			if (a.json) return json(w);
			return out(`${C.readJSON(path.join(J.jobDir(id), 'meta.json'), {}).name} (${id}), run ${path.relative(process.cwd(), r.file)}\n` + J.formatWhere(w));
		}
		case 'render': {
			const id = J.resolve(pos[0]);
			const r = jobRun(id);
			const res = J.renderJob(r.level, C.readJSON(J.levelJsonOf(id), null), r.masks, pos[1], pos[2],
				{ name: C.readJSON(path.join(J.jobDir(id), 'meta.json'), {}).name, scale: +a.scale || undefined, margin: a.margin !== undefined ? +a.margin : undefined });
			const file = pos[3] ? path.resolve(pos[3]) : path.join(J.jobDir(id), 'renders', `${res.fromTime}-${res.toTime}`.replace(/[:.]/g, '_') + '.png');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, res.png);
			return out(`${file}\n${res.width}x${res.height} px, ${res.scale} px per tile, tiles x ${res.region.x0}-${res.region.x1}, y ${res.region.y0}-${res.region.y1}; ` +
				`ticks ${res.from}-${res.to} = run time ${res.fromTime}-${res.toTime}`);
		}
		case 'replay': {
			if (!pos[0]) throw new Error('usage: replay <job|file.eetas> [--level=<job>]');
			let level, masks, name;
			const asJob = !fs.existsSync(pos[0]) && C.findJob(pos[0]);
			if (asJob) { const r = jobRun(asJob); level = r.level; masks = r.masks; name = `${asJob} ${path.basename(r.file)}`; }
			else {
				masks = C.readEetas(pos[0]);
				level = C.E.loadLevel(C.levelData(a.level, pos[0]));
				name = path.basename(pos[0]);
			}
			const r = J.replayInfo(level, masks);
			return a.json ? json(r) : out(J.formatReplay(r, name));
		}
		case 'probe': {
			if (pos.length < 3) throw new Error('usage: probe <job> <time|tick> "<inputs, e.g. R+J x3, R x20>" [--try]');
			const id = J.resolve(pos[0]);
			const r = jobRun(id);
			const inputs = J.parseInputs(pos.slice(2).join(','));
			const st = C.readJSON(path.join(J.jobDir(id), 'status.json'), {});
			const p = J.probe(r.level, r.masks, pos[1], inputs, { nocoins: !!st.coinsOptional, horizon: +a.horizon || undefined, shift: +a.shift || undefined });
			let file = null;
			if (p.candidate) {
				file = a.out ? path.resolve(a.out) : path.join(J.jobDir(id), 'probes', `${J.stamp()}.eetas`);
				C.writeEetas(file, p.candidate.masks);
			}
			if (a.json) { if (p.candidate) delete p.candidate.masks; return json({ ...p, file }); }
			out(`from tick ${p.at} (${p.atTime}) of the best run (${p.reference.time}): played ${p.played} of ${p.inputs} inputs; ` +
				(p.differsAt === null ? 'they are the best run\'s own inputs (only shifted continuations are tried)' : `they differ from the best run's from tick ${p.differsAt}`));
			out(`after them  tick ${p.end.tick}: tile (${(p.end.x / 16).toFixed(3)}, ${(p.end.y / 16).toFixed(3)}), speed (${p.end.vx.toFixed(3)}, ${p.end.vy.toFixed(3)})` +
				`${p.end.dead ? ', DEAD' : ''}${p.finishedDuringInputs ? ', FINISHED the level' : ''}`);
			out(`closest    reference tick ${p.nearest.j} (${p.nearest.time}), distance ${p.nearest.d.toFixed(2)} (px + 3 x px/tick); the inputs ended at tick ${p.end.tick} ` +
				`(${p.nearest.j - p.end.tick >= 0 ? '+' : ''}${p.nearest.j - p.end.tick} vs the best run)`);
			if (p.rejoin) out(`rejoin     EXACT with the best run at tick ${p.rejoin.refTick} via ${p.rejoin.via}: ` +
				(p.rejoin.saved > 0 ? `saves ${p.rejoin.saved} ticks` : p.rejoin.saved === 0 ? 'same time (no gain)' : `loses ${-p.rejoin.saved} ticks`));
			else out('rejoin     none: the inputs never reach a state the best run is in later (try other timings, or `focus` around here)');
			if (p.candidate) {
				out(`candidate  ${p.candidate.time} (${p.candidate.saved >= 0 ? '-' : '+'}${Math.abs(p.candidate.saved)} ticks vs ${p.reference.time}), ${p.candidate.deaths} deaths` +
					`${p.candidate.chance < 1 ? `, works in ${J.pct(p.candidate.chance)} of EEO plays` : ''} -> ${file}`);
				if (a.try && p.candidate.saved > 0) {
					const t = await J.tryCandidate(id, fs.readFileSync(file), { source: a.source || `probe ${p.atTime}`, wait: a.wait !== undefined ? +a.wait : 60 });
					out(`try        ${t.accepted ? 'ACCEPTED by the job' : t.handed === 'inbox' && !t.result ? 'handed to the running job (inbox)' : `not accepted: ${(t.result && t.result.reason) || t.verdict.reason}`}`);
				} else if (p.candidate.saved > 0) out(`hand it in: ${CMD} try ${id} "${file}"`);
			} else if ((p.rejoin && p.rejoin.saved > 0) || p.finishedDuringInputs) out('candidate  the full replay does not finish (e.g. a coin door needs a skipped coin)');
			return;
		}
		case 'try': {
			if (pos.length < 2) throw new Error('usage: try <job> <file.eetas>');
			const id = J.resolve(pos[0]);
			const r = await J.tryCandidate(id, fs.readFileSync(pos[1]), { source: a.source || `try ${path.basename(pos[1])}`, wait: a.wait !== undefined ? +a.wait : 60 });
			if (a.json) return json(r);
			if (!r.candidate) return out(`${pos[1]}: does not finish the level - nothing handed to the job`);
			const c = r.candidate;
			out(`candidate  ${c.time} (${c.runTicks}), ${c.deaths} deaths, ${c.coins} coins${c.chance < 1 ? `, works in ${J.pct(c.chance)} of EEO plays` : ''}`);
			if (r.best) out(`best       ${r.best.time} (${r.best.runTicks})${r.best.chance < 1 ? `, ${J.pct(r.best.chance)}` : ''}`);
			out(`rule       ${r.verdict.accept ? `better (${r.verdict.saved ? '-' + r.verdict.saved + ' ticks' : 'more likely to work'})` : 'not better: ' + r.verdict.reason}`);
			if (r.handed === 'inbox') {
				if (r.result) out(`handed     to the running job: ${r.result.accepted ? `ACCEPTED, best is now ${r.result.bestTime}` : `not accepted (${r.result.reason}); kept for splicing`}`);
				else out(`handed     to the running job's inbox (${r.inboxFile}); it decides between checks - see: ${CMD} status ${id}`);
			} else out(`handed     directly (job not running): ${r.accepted ? 'ACCEPTED, best.eetas updated' : 'not accepted; kept in pieces/ for splicing'}`);
			return;
		}
		case 'focus': {
			if (pos.length < 3) throw new Error('usage: focus <job> <from> <to> [seconds]');
			const id = J.resolve(pos[0]);
			const f = J.focusState(id);
			if (f.running && f.pid !== process.pid) throw new Error(`a focus search is already running for this job (pid ${f.pid}, ${f.fromTime}-${f.toTime})`);
			const r = await J.focus(id, pos[1], pos[2], +pos[3] || 120, { workers: +a.workers || undefined });
			if (a.json) json(r);
			return;
		}
		case 'import': {
			if (pos.length < 2) throw new Error('usage: import <level.eelvl> <run.eetas> [--name=..] [--start=reset|load]');
			const meta = J.importJob({ eelvl: fs.readFileSync(pos[0]), eetas: fs.readFileSync(pos[1]), name: a.name, eelvlName: path.basename(pos[0]),
				eetasName: path.basename(pos[1]), startMode: a.start });
			if (a.json) return json(meta);
			return out(`imported ${meta.id}: "${meta.name}", the TAS finishes in ${meta.tas.time} (${meta.tas.coins} coins, ${meta.tas.deaths} deaths)` +
				`${meta.rng.chance < 1 ? `, works in ${J.pct(meta.rng.chance)} of EEO plays (random portals)` : ''}\n` +
				`start: ${J.START_MODES[meta.startMode]}${meta.startMatters ? '' : ' (makes no difference on this level)'}\nstart it: ${CMD} start ${meta.id}`);
		}
		case 'start': {
			const id = J.resolve(pos[0]);
			if (J.runningPid(id)) return out(`${id} is already running`);
			const ch = J.startJob(id, +a.workers || undefined, { detached: true });
			return out(`started ${id} (pid ${ch.pid}); log: ${path.join(J.jobDir(id), 'grind.log')}; stop: ${CMD} stop ${id}`);
		}
		case 'stop': { const id = J.resolve(pos[0]); J.stopJob(id); return out(`stopped ${id}`); }
		case 'finish': {
			const id = J.resolve(pos[0]);
			J.stopJob(id);
			const r = J.finishReport(id);
			if (a.json) return json(r);
			return out(`final run ${r.time} (saved ${(r.savedTicks / 100).toFixed(2)} s vs ${r.originalTime}), works in ${J.pct(r.chance)} of EEO plays\n` +
				`file: ${path.join(J.jobDir(id), 'best.eetas')}`);
		}
		default: throw new Error(`unknown command "${cmd}" (${CMD} help)`);
	}
}
main().catch((e) => { console.error(`error: ${e && e.message || e}`); process.exit(1); });

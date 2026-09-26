'use strict';
// mkjobs.js <out.json> <level> <spec>...: spec = name:salts (e.g. base:1-5 kany4:0 fine:0-1); prints the job list
const fs = require('fs');
const [out, level, ...specs] = process.argv.slice(2);
const W = { user30s: '496,527.99999,591.5,592.5,-1', shaft: '368,399.99999,207.5,208.5,-1' }[level];
const R = {
	base: [],
	kany2: ['--rule=kany', '--K=2', '--sub=4'],
	kany3: ['--rule=kany', '--K=3', '--sub=4'],
	kany4: ['--rule=kany', '--K=4', '--sub=4'],
	kany8: ['--rule=kany', '--K=8', '--sub=4'],
	kbox4: ['--rule=kbox', '--K=4'],
	kbox2: ['--rule=kbox', '--K=2'],
	fine2: ['--cqx=4', '--cqv=128'],
	fine4: ['--cqx=8', '--cqv=256'],
};
const jobs = [];
for (const sp of specs) {
	const [name, range, pass] = sp.split(':');
	const [a, b] = range.split('-').map(Number);
	for (let s = a; s <= (Number.isFinite(b) ? b : a); s++) {
		jobs.push({ exe: 'xp_b.exe', level, args: [`--pass=${pass || 2}`, `--salt=${s}`, '--threads=6', '--quiet=1', ...R[name], ...(W ? [`--watch=${W}`] : [])] });
	}
}
fs.writeFileSync(out, JSON.stringify(jobs, null, 1));
console.log(jobs.length, 'jobs');

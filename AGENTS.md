# AGENTS.md

All instructions for AI coding assistants are in **[CLAUDE.md](CLAUDE.md)**. Read it first. It covers what the app
does, the ground rules, the step-by-step recipe for testing a user's idea and handing it to the running optimizer,
the physics cheat sheet, the file map, the job files, the CLI and the HTTP API.

Quick start:

```
node src/tas.js jobs                         # find the job
node src/tas.js where <job> 1:10             # state at that run time (+ ASCII map)
node src/tas.js render <job> 1:08 1:14       # PNG of the level around the path; look at it
node src/tas.js probe <job> 1:10.40 "R+J x6, R x40"   # test an idea exactly (exact rejoin = proof)
node src/tas.js try <job> <candidate.eetas>  # hand an improvement to the (running) job
node src/tas.js focus <job> 1:08 1:14 120    # let the machine search that window harder
```
Show the user a moment in the app's viewer (best run + their original as a ghost):
`http://localhost:47823/#watch=<job id>&t=1:10.00`.

Never write `src/jobs/<id>/best.eetas` directly, and never kill processes you did not start.

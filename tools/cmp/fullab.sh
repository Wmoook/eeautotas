#!/bin/bash
# A LONG-BUDGET A/B SIDE BY SIDE with tools/cmp/fullc.js (B8 score900, cycle 3): one fullc.js driver an arm (each arm its
# own environment), the same level list in the same order, the same par, all started together, so the arms' compiles
# share the box's load wave by wave; each arm's RAM controller holds its own compiles' RSS under GBCAP (no new start
# above it: the arm's par drops to its running count); after CUTOFF seconds no compile starts in any arm (one stopfile:
# the run ends with the running compiles). Then tools/cmp/headroom.js on each <out>/f_<arm> and headdiff.js between them.
#   tools/cmp/fullab.sh <out dir> <code dir> <tools dir> <levels dir> <list> <seconds> <par an arm> <cutoff s> <GB cap an arm> <arm> [<arm> ...]
# an arm is name or name:K=V;K=V (quote it); e.g. off 'cr3:EEAT_CRUMB_RANK=3'. Linux (fullc.js --rss=1 reads /proc).
C=$1; CODE=$2; TOOLS=$3; LV=$4; LIST=$5; SEC=$6; MAXPAR=$7; CUTOFF=$8; GBCAP=$9; shift 9
ARMS=("$@")
mkdir -p $C; rm -f $C/stop
T0=$(date +%s)
NAMES=()
for spec in "${ARMS[@]}"; do
	A=${spec%%:*}; ENVS=""; [ "$A" != "$spec" ] && ENVS=${spec#*:}
	NAMES+=($A)
	echo $MAXPAR > $C/par_$A.txt
	( IFS=';'; for kv in $ENVS; do export "$kv"; done
	  exec node $TOOLS/fullc.js $CODE $LV $C/f_$A --list=$LIST --order=list --par=$MAXPAR --parfile=$C/par_$A.txt --stopfile=$C/stop --workers=3 --seconds=$SEC --json=1 --rss=1 --minfree=20 --killfree=6 ) > $C/f_$A.log 2>&1 &
	echo $! > $C/fullc_$A.pid
	echo "$(date -u +%H:%M:%S) arm $A env '$ENVS' pid $!" >> $C/ctl.log
done
echo "$(date -u +%H:%M:%S) start par $MAXPAR an arm, cutoff ${CUTOFF}s, cap ${GBCAP} GB an arm" >> $C/ctl.log
alive() { for A in "${NAMES[@]}"; do kill -0 $(cat $C/fullc_$A.pid) 2>/dev/null && return 0; done; return 1; }
while alive; do
	sleep 20
	if [ ! -f $C/stop ] && [ $(( $(date +%s) - T0 )) -ge $CUTOFF ]; then touch $C/stop; echo "$(date -u +%H:%M:%S) cutoff: no more starts" >> $C/ctl.log; fi
	for A in "${NAMES[@]}"; do
		L=$(tail -1 $C/f_$A/rss.jsonl 2>/dev/null)
		GB=$(echo "$L" | sed -n 's/.*"compilesGB":\([0-9.]*\).*/\1/p'); RUN=$(echo "$L" | sed -n 's/.*"running":\([0-9]*\).*/\1/p')
		[ -z "$GB" ] && continue
		if awk "BEGIN{exit !($GB > $GBCAP)}"; then P=$RUN; [ $P -lt 1 ] && P=1; else P=$MAXPAR; fi
		[ "$(cat $C/par_$A.txt)" != "$P" ] && echo $P > $C/par_$A.txt && echo "$(date -u +%H:%M:%S) $A par $P (compiles $GB GB, running $RUN)" >> $C/ctl.log
	done
done
echo "all arms ended $(date -u +%H:%M:%S)" >> $C/ctl.log

#!/bin/bash
# A/B of two knob sets on ONE code tree, ONE compile at a time (a doctor's run on a shared box): per level side A then
# side B, each only when the box has at least MINFREE GB available (else it waits), nice 19.
#   KNOBA="EEAT_X=1" KNOBB="EEAT_Y=1" tools/cmp/abseq2.sh <code dir> <out dir> <seconds> <workers> <level.eelvl>...
# Writes <out>/<level>_{A,B}.{log,json,eetas} and a line per compile to <out>/ab.jsonl (tools/cmp/absumm.js reads it).
CODE=$1; OUT=$2; SEC=$3; WK=$4; shift 4
MINFREE=${MINFREE:-25}
mkdir -p "$OUT"
for LV in "$@"; do
  N=$(basename "$LV" .eelvl)
  for SIDE in A B; do
    while [ "$(free -g | awk '/^Mem:/{print $7}')" -lt "$MINFREE" ]; do sleep 5; done
    T0=$(date +%s.%N)
    if [ "$SIDE" = B ]; then ENVS="$KNOBB"; else ENVS="$KNOBA"; fi
    ( cd "$CODE" && env $ENVS nice -n 19 node src/compile.js "$LV" --out="$OUT/${N}_$SIDE.eetas" --seconds="$SEC" --workers="$WK" --json --report="$OUT/${N}_$SIDE.json" > "$OUT/${N}_$SIDE.log" 2>&1 < /dev/null )
    RC=$?
    T1=$(date +%s.%N)
    echo "{\"level\":\"$N\",\"side\":\"$SIDE\",\"rc\":$RC,\"wall\":$(echo "$T1 - $T0" | bc)}" >> "$OUT/ab.jsonl"
  done
done
echo done >> "$OUT/ab.jsonl"

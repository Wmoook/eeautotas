#!/bin/sh
# lane.sh <gpu> <parity 0|1> <seconds> <outdir>: the hybrid on every level of race_levels.txt whose index has that parity, one after another
g=$1; p=$2; s=$3; o=$4
i=0
for rel in $(cat /root/hy_race_out/race_levels.txt); do
  if [ $((i % 2)) -eq "$p" ]; then
    id=$(basename "$rel" .eelvl)
    [ -f "$o/$id/hybrid.json" ] && grep -q '"ended"' "$o/$id/hybrid.json" || /root/hy_race_out/hy1.sh "$g" "$rel" "$s" "$o/$id"
  fi
  i=$((i + 1))
done
echo "$(date -u +%H:%M:%S) lane gpu $g done" >> "$o/done.txt"

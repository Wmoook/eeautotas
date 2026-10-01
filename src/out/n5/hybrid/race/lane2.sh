#!/bin/sh
# lane2.sh <gpu> <seconds> <outdir> <rel>...: the hybrid on those levels one after another
g=$1; s=$2; o=$3; shift 3
for rel in "$@"; do
  id=$(basename "$rel" .eelvl)
  /root/hy_race_out/hy1.sh "$g" "$rel" "$s" "$o/$id"
done
echo "$(date -u +%H:%M:%S) lane2 gpu $g done" >> "$o/done.txt"

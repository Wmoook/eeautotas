#!/bin/sh
# hy1.sh <gpu> <rel> <seconds> <outdir> [hybrid.js args]: one hybrid run (n5-hy-race) on box 9
export PATH=/root/.local/node/bin:$PATH CUDA_CACHE_PATH=/root/gpucache9 CUDA_CACHE_MAXSIZE=4294967296
g=$1; rel=$2; s=$3; o=$4; shift 4
mkdir -p "$o" /dev/shm/hy_race_tmp
cd /root/hy_race
TMPDIR=/dev/shm/hy_race_tmp TMP=/dev/shm/hy_race_tmp TEMP=/dev/shm/hy_race_tmp timeout -k 60 $((s + 150)) node tools/hybrid.js "/root/lv/lv230/$rel" --seconds=$s --gpu=$g --out="$o" --quiet=1 "$@" > "$o/stdout.log" 2>&1
echo "$(date -u +%H:%M:%S) $rel gpu $g exit $?" >> "$(dirname "$o")/done.txt"

#!/bin/sh
# tools/gpuproof/build-linux.sh: the native engine built ON a Linux GPU box (g++ and the CUDA toolkit's NVRTC there),
# with tools/build-native.js's flags (the exact IEEE doubles: -ffp-contract=off -fno-fast-math, baseline x86-64: no FMA;
# the kernels by NVRTC --fmad=false through `eegpu ptx`, one PTX per state-tail capacity), plus the exact search's own
# kernel module (native/exactkernels.cu -> eegpu_exact_<tw>.ptx: `eegpu exact`, native/exact.h).
#   sh tools/gpuproof/build-linux.sh [outdir] [--exact-only] [--tw=8,32]
#   outdir: default native/build/linux; CUDA_HOME (default /usr/local/cuda) holds lib64/libnvrtc.so.12
# The PTX is the same as the Windows build's (NVRTC compiles kernels.cu alone; nvrtc 12.8 here vs 12.6 there: a newer
# ISA, which the box's driver loads). Prints the PTX files' sizes; exit != 0 on any failure.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/native/build/linux"
EXACT_ONLY=0
TWS="8 32 128 512"
for a in "$@"; do
	case "$a" in
		--exact-only) EXACT_ONLY=1 ;;
		--tw=*) TWS=$(echo "${a#--tw=}" | tr ',' ' ') ;;
		-*) echo "unknown option $a" >&2; exit 2 ;;
		*) OUT="$a" ;;
	esac
done
CUDA="${CUDA_HOME:-/usr/local/cuda}"
mkdir -p "$OUT"
echo "[build-linux] g++ eegpu -> $OUT/eegpu"
g++ -O2 -std=c++17 -ffp-contract=off -fno-fast-math -Wall -Wno-unused-function -Wno-unused-variable \
	"$ROOT/native/eegpu.cpp" -o "$OUT/eegpu" -ldl -lpthread
pids=""
if [ "$EXACT_ONLY" = 0 ]; then
	for tw in $TWS; do
		"$OUT/eegpu" ptx "$ROOT/native" "$OUT/eegpu_$tw.ptx" --nvrtc="$CUDA/lib64" --tw=$tw > "$OUT/ptx_$tw.log" 2>&1 &
		pids="$pids $!"
	done
fi
for tw in $TWS; do
	"$OUT/eegpu" ptx "$ROOT/native" "$OUT/eegpu_exact_$tw.ptx" --nvrtc="$CUDA/lib64" --tw=$tw --src=exactkernels.cu > "$OUT/ptx_exact_$tw.log" 2>&1 &
	pids="$pids $!"
done
fail=0
for p in $pids; do wait $p || fail=1; done
cat "$OUT"/ptx_*.log
[ "$fail" = 0 ] || { echo "[build-linux] a PTX compile failed" >&2; exit 1; }
ls -la "$OUT"/*.ptx
echo "[build-linux] done"

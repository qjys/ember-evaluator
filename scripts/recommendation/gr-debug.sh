#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
requested_port=${GR_PORT:-}
requested_profile_port=${GR_PROFILE_PORT:-}
if [[ -f $repo/.scratch/gr-debug.env ]]; then source "$repo/.scratch/gr-debug.env"; fi
home_dir=${GR_HOME:-$HOME}
engine=${GR_ENGINE:-$home_dir/SGLang-GR-gr-a2}
export GR_TOKENIZER_DIR=${GR_TOKENIZER_DIR:-$home_dir/Qwen3-0.6B-OneRecVocab}
export GR_PROMPT_DIR=${GR_PROMPT_DIR:-$home_dir/data/prompts}
export GR_PREFIX1_FILE=${GR_PREFIX1_FILE:-$home_dir/data/catalog/prefix1.json}
export GR_PREFIX2_FILE=${GR_PREFIX2_FILE:-$home_dir/data/catalog/prefix2.json}
export GR_PROMPT_FILE="$GR_PROMPT_DIR/prompts_128_batch_4.json"
export MODEL_API_KEY=${MODEL_API_KEY:-EMPTY}
port=${requested_port:-${GR_PORT:-30000}}
profile_port=${requested_profile_port:-${GR_PROFILE_PORT:-30001}}
for number in "$port" "$profile_port"; do
  [[ $number =~ ^[1-9][0-9]{0,4}$ && $number -le 65535 ]] || { echo "Invalid GR port: $number" >&2; exit 2; }
done
if [[ ${1:-} == serve-profile || ${1:-} == run-collections ]]; then
  [[ $port != "$profile_port" ]] || { echo "GR_PORT and GR_PROFILE_PORT must differ" >&2; exit 2; }
fi
export GR_URL=http://127.0.0.1:$port
export GR_PROFILE_URL=http://127.0.0.1:$profile_port
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
py=${GR_PYTHON:-python3}
health() {
  "$py" -c 'import os,urllib.request; r=urllib.request.urlopen(os.environ["GR_URL"]+"/health",timeout=5); print("health", r.status); r.close()'
}
case "${1:-}" in
health) health ;;
serve|serve-profile)
  if [[ $1 == serve-profile ]]; then
    port=$profile_port
    export SGLANG_NPU_PROFILE_AUTO_EXPORT=1
  fi
  case "${2:-}" in
    base) unset SGLANG_NPU_SHARED_PREFIX_DECODE SGLANG_NPU_SHARED_PREFIX_MIN_LEN ;;
    fast) export SGLANG_NPU_SHARED_PREFIX_DECODE=1 SGLANG_NPU_SHARED_PREFIX_MIN_LEN=32 ;;
    *) echo "Usage: serve base|fast" >&2; exit 2 ;;
  esac
  cd "$engine"
  test -d python/sglang
  export PYTHONPATH="$PWD/python${PYTHONPATH:+:$PYTHONPATH}"
  export ASCEND_RT_VISIBLE_DEVICES=${GR_DEVICE:-4}
  [[ $ASCEND_RT_VISIBLE_DEVICES == 4 || $ASCEND_RT_VISIBLE_DEVICES == 0 ]] || { echo "Use physical card 4, or its verified container-local index 0" >&2; exit 2; }
  export SGLANG_NPU_FORCE_NATIVE_SDPA=1 SGLANG_NPU_SDPA_DECODE_BLOCK=128
  test -s "$GR_TOKENIZER_DIR/config.json"
  test -r "$GR_PREFIX1_FILE" && test -r "$GR_PREFIX2_FILE"
  service_py=${GR_SERVICE_PYTHON:-python3}
  "$service_py" -c 'import importlib.util,os,sys; print(sys.executable, importlib.util.find_spec("sglang").origin); print({k:os.getenv(k) for k in ("ASCEND_RT_VISIBLE_DEVICES","SGLANG_NPU_SHARED_PREFIX_DECODE","SGLANG_NPU_SHARED_PREFIX_MIN_LEN","SGLANG_NPU_PROFILE_AUTO_EXPORT")})'
  exec "$service_py" -m sglang.launch_server --model "$GR_TOKENIZER_DIR" --device npu --attention-backend ascend \
    --page-size 1 --disable-decode-cuda-graph --disable-radix-cache --context-length 12288 --max-running-requests 1024 \
    --mem-fraction-static 0.4 --host 127.0.0.1 --port "$port" ;;
dry|run|run-collections)
  action=$1; tag=${2:-}
  case "$action:$tag" in
    run:smoke|dry:smoke) template=custom.yaml; export GR_TAG=base ;;
    run-collections:base|run-collections:fast) template=north-star-collections.yaml; export GR_TAG="$tag" ;;
    run:base|run:fast|dry:base|dry:fast) template=north-star.yaml; export GR_TAG="$tag" ;;
    *) echo "Usage: dry|run smoke|base|fast, or run-collections base|fast" >&2; exit 2 ;;
  esac
  cd "$repo"
  export GR_CLIENT_PYTHON
  GR_CLIENT_PYTHON=$(command -v "$py")
  args=()
  if [[ $action == dry ]]; then args+=(--dry-run); else
    "$GR_CLIENT_PYTHON" -c 'from transformers import AutoTokenizer'
    health
    if [[ $action == run-collections ]]; then GR_URL="$GR_PROFILE_URL" health; fi
  fi
  root=${GR_RESULTS:-$repo/results/recommendation}
  mkdir -p "$root"
  work=$(mktemp -d "$(cd "$root" && pwd -P)/$tag-$action-XXXXXXXX")
  export GR_OUTPUT="$work/results"
  sed -e 's|^    base_url: http://127.0.0.1:30000$|    base_url: ${GR_URL}|' \
      -e 's|^    base_url: http://127.0.0.1:30001$|    base_url: ${GR_PROFILE_URL}|' \
      -e 's|^    tag: [a-z]*$|    tag: ${GR_TAG}|' \
      -e '/^      tokenizerPath:/i\      pythonExecutable: ${GR_CLIENT_PYTHON}' \
      "playbook/recommendation/$template" >"$work/experiment.yaml"
  printf '\noutput:\n  directory: ${GR_OUTPUT}\n' >>"$work/experiment.yaml"
  echo "本次调试目录 $work" >&2
  rc=0
  node dist/cli.js run "$work/experiment.yaml" "${args[@]}" 2>&1 | tee "$work/cli.log" || rc=$?
  if [[ $action == run && -d $GR_OUTPUT ]]; then
    find "$GR_OUTPUT" -name metrics.json -exec "$py" "$repo/scripts/recommendation/gr-summary.py" {} \;
  fi
  if [[ $action == run-collections && -d $GR_OUTPUT ]]; then
    find "$GR_OUTPUT" -mindepth 2 -maxdepth 2 -name report.md -print
  fi
  exit "$rc" ;;
info) cd "$repo"; exec node dist/cli.js benchmark info recommendation ;;
report) exec node "$repo/dist/cli.js" report "${2:?请给出含 manifest.json 的 run 目录}" ;;
*) echo '指令: info | health | serve base|fast | serve-profile base|fast | run-collections base|fast | dry smoke|base|fast | run smoke|base|fast | report RUN_DIR' >&2; exit 2 ;;
esac

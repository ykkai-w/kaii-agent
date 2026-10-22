#!/bin/bash
set -euo pipefail

# 不触发麦克风/语音识别权限框的协议 smoke。所有用例都在参数解析
# 阶段必死，同时验证失败也是单行 JSON，不是普通 stderr 文本。
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
helper="$project_root/resources/bin/kaii-speech"
work="$(mktemp -d "${TMPDIR:-/tmp}/kaii-speech-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [[ ! -x "$helper" ]]; then
  echo "kaii-speech 不存在或不可执行：$helper" >&2
  exit 1
fi

expect_bad_arguments() {
  local label="$1"
  shift
  local output="$work/$label.jsonl"
  if "$helper" "$@" >"$output"; then
    echo "错误参数竟然被接受：$label" >&2
    exit 1
  fi
  test "$(wc -l <"$output" | tr -d ' ')" = "1"
  jq -e '.type == "error" and .code == "bad_arguments" and (.message | type == "string" and length > 0)' "$output" >/dev/null
}

expect_bad_arguments zero-seconds --max-seconds 0
expect_bad_arguments too-long --max-seconds 601
expect_bad_arguments missing-locale --locale
expect_bad_arguments unknown-flag --definitely-not-a-real-flag

printf 'speech-helper argument protocol PASS\n'

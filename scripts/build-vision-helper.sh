#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
source_file="$project_root/native/kaii-vision.swift"
output_dir="$project_root/resources/bin"
output_file="$output_dir/kaii-vision"

if [[ ! -f "$source_file" ]]; then
  echo "Missing source: $source_file" >&2
  exit 1
fi

mkdir -p "$output_dir"

xcrun swiftc \
  -O \
  -whole-module-optimization \
  -target arm64-apple-macos13.0 \
  -framework CoreGraphics \
  -framework Foundation \
  -framework ImageIO \
  -framework Vision \
  "$source_file" \
  -o "$output_file"

chmod 755 "$output_file"
codesign --force --sign - "$output_file" >/dev/null 2>&1

echo "$output_file"

# 本机文档助手：只抽 PDF 文本层，和识图助手分开，各自职责单一。
doc_source="$project_root/native/kaii-doc.swift"
doc_output="$output_dir/kaii-doc"

if [[ -f "$doc_source" ]]; then
  xcrun swiftc \
    -O \
    -whole-module-optimization \
    -target arm64-apple-macos13.0 \
    -framework Foundation \
    -framework PDFKit \
    "$doc_source" \
    -o "$doc_output"

  chmod 755 "$doc_output"
  codesign --force --sign - "$doc_output" >/dev/null 2>&1
  echo "$doc_output"
fi

# 本机听写助手：录音 + 设备上的语音识别，音频不出这台电脑。
speech_source="$project_root/native/kaii-speech.swift"
speech_output="$output_dir/kaii-speech"

if [[ -f "$speech_source" ]]; then
  xcrun swiftc \
    -O \
    -whole-module-optimization \
    -target arm64-apple-macos13.0 \
    -framework AVFoundation \
    -framework Foundation \
    -framework Speech \
    "$speech_source" \
    -o "$speech_output"

  chmod 755 "$speech_output"
  codesign --force --sign - "$speech_output" >/dev/null 2>&1
  echo "$speech_output"
fi

# 桌面图标和应用内 Logo 使用同一份 SVG，避免改了页面标志却忘了更新 .icns。
"$project_root/scripts/build-app-icon.sh"

#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
source_svg="$project_root/public/logos/kaii-k-a.svg"
preview_png="$project_root/public/logos/kaii-k-a.png"
iconset_dir="$project_root/design/kaii.iconset"
output_icns="$project_root/resources/kaii.icns"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/kaii-icon.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

[[ -f "$source_svg" ]] || { echo "Missing logo: $source_svg" >&2; exit 1; }
sips -s format png "$source_svg" --out "$work_dir/logo.png" >/dev/null

[[ -s "$work_dir/logo.png" ]] || { echo "Logo render failed" >&2; exit 1; }
mkdir -p "$iconset_dir" "$(dirname "$output_icns")"
cp "$work_dir/logo.png" "$preview_png"

while read -r file size; do
  sips -z "$size" "$size" "$work_dir/logo.png" --out "$iconset_dir/$file" >/dev/null
done <<'SIZES'
icon_16x16.png 16
icon_16x16@2x.png 32
icon_32x32.png 32
icon_32x32@2x.png 64
icon_128x128.png 128
icon_128x128@2x.png 256
icon_256x256.png 256
icon_256x256@2x.png 512
icon_512x512.png 512
icon_512x512@2x.png 1024
SIZES

iconutil -c icns "$iconset_dir" -o "$output_icns"
echo "$output_icns"

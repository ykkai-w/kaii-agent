#!/bin/bash
# 确定性手工打包：沿用已经能跑的 Electron 壳，只换 app.asar 和外置 helper。
# 本机 electron-builder 在依赖搜索阶段会长时间停滞，所以不用它，也不假装用了它。
#
# 用法：bash scripts/repack-desktop.sh <本轮标签>
# 例：  bash scripts/repack-desktop.sh agent-v1

set -euo pipefail

LABEL="${1:?需要一个本轮标签，例如 agent-v1}"
STAMP="$(date +%Y%m%d)"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PROJECT="${KAII_REPACK_SOURCE_ROOT:-$PROJECT}"
DESKTOP_APP="$HOME/Desktop/kaii-agent.app"
RELEASE="$PROJECT/release"
STAGE="$RELEASE/manual-$LABEL/stage/app"
OUT_APP="$RELEASE/manual-$LABEL/kaii-agent.app"
BACKUP="$RELEASE/previous/kaii-agent-before-$LABEL-$STAMP.app"
SMOKE_ONLY="${KAII_REPACK_SMOKE_ONLY:-0}"

[ -d "$SOURCE_PROJECT" ] || { echo "打包输入根目录不存在：$SOURCE_PROJECT" >&2; exit 1; }
[ -f "$SOURCE_PROJECT/package.json" ] || { echo "打包输入缺少 package.json：$SOURCE_PROJECT" >&2; exit 1; }

assemble_asar() {
  local stage="$1"
  local bundle="$2"
  rm -rf "$stage"
  mkdir -p "$stage" "$bundle"
  cp -R "$SOURCE_PROJECT/dist" "$stage/dist"
  mkdir -p "$stage/electron"
  rsync -a --exclude '/lib/dmr*' "$SOURCE_PROJECT/electron/" "$stage/electron/"
  cp -R "$SOURCE_PROJECT/resources" "$stage/resources"
  cp "$SOURCE_PROJECT/package.json" "$stage/package.json"

  CONTENT_MANIFEST="$bundle/content.sha256"
  (
    cd "$stage"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r item; do
      shasum -a 256 "$item"
    done
  ) > "$CONTENT_MANIFEST"

  ASAR_PATH="$bundle/app.asar"
  ASAR_LIST="$bundle/asar-files.txt"
  node "$SOURCE_PROJECT/node_modules/@electron/asar/bin/asar.js" pack "$stage" "$ASAR_PATH"
  node "$SOURCE_PROJECT/node_modules/@electron/asar/bin/asar.js" list "$ASAR_PATH" > "$ASAR_LIST"
  if grep -Eiq '^/electron/lib/dmr' "$ASAR_LIST"; then
    echo "app.asar 包含私人研究模块，停止打包" >&2
    exit 1
  fi
  for required in /dist/index.html /dist/build-inputs.sha256.json /electron/main.cjs /electron/preload.cjs /resources/bin/kaii-vision /resources/bin/kaii-doc /resources/bin/kaii-speech; do
    grep -Fqx "$required" "$ASAR_LIST" || { echo "app.asar 缺少 $required" >&2; exit 1; }
  done
}

copy_external_helpers() {
  local destination="$1"
  mkdir -p "$destination"
  for helper in kaii-vision kaii-doc kaii-speech; do
    cp "$SOURCE_PROJECT/resources/bin/$helper" "$destination/$helper"
    chmod 755 "$destination/$helper"
    [ -x "$destination/$helper" ] \
      || { echo "外置 helper 不存在或不可执行：$helper" >&2; exit 1; }
  done
}

copy_bundle_icon() {
  local destination="$1"
  mkdir -p "$(dirname "$destination")"
  cp "$SOURCE_PROJECT/resources/kaii.icns" "$destination"
  [ -s "$destination" ] \
    || { echo "应用图标复制失败" >&2; exit 1; }
}

# 产物测试走和手工重打包相同的组装函数，但只在 /tmp 里
# 列表、解包和逐字节比对，绝不读写桌面应用或历史 release。
if [ "$SMOKE_ONLY" = "1" ]; then
  [ -f "$SOURCE_PROJECT/dist/index.html" ] || { echo "找不到 dist/index.html" >&2; exit 1; }
  [ -f "$SOURCE_PROJECT/dist/build-inputs.sha256.json" ] || { echo "找不到构建输入指纹" >&2; exit 1; }
  SMOKE_ROOT="$(mktemp -d /tmp/kaii-repack-smoke-XXXXXX)"
  trap 'rm -rf "$SMOKE_ROOT"' EXIT
  assemble_asar "$SMOKE_ROOT/stage/app" "$SMOKE_ROOT/bundle"
  copy_external_helpers "$SMOKE_ROOT/Contents/Resources/bin"
  copy_bundle_icon "$SMOKE_ROOT/Contents/Resources/icon.icns"
  node "$SOURCE_PROJECT/node_modules/@electron/asar/bin/asar.js" extract "$ASAR_PATH" "$SMOKE_ROOT/unpacked"
  for required in dist/index.html dist/build-inputs.sha256.json electron/main.cjs electron/preload.cjs resources/bin/kaii-vision resources/bin/kaii-doc resources/bin/kaii-speech; do
    cmp -s "$SMOKE_ROOT/stage/app/$required" "$SMOKE_ROOT/unpacked/$required" \
      || { echo "app.asar 解包后不一致：$required" >&2; exit 1; }
  done
  for helper in kaii-vision kaii-doc kaii-speech; do
    cmp -s "$SOURCE_PROJECT/resources/bin/$helper" "$SMOKE_ROOT/Contents/Resources/bin/$helper" \
      || { echo "外置 helper 复制后不一致：$helper" >&2; exit 1; }
  done
  cmp -s "$SOURCE_PROJECT/resources/kaii.icns" "$SMOKE_ROOT/Contents/Resources/icon.icns" \
    || { echo "应用图标复制后不一致" >&2; exit 1; }
  echo "repack smoke PASS"
  exit 0
fi

# 打包不再猜 dist 是不是新的：mtime 会被拷贝、git 和编辑器保留，
# 而且旧实现漏了 public、vite.config 和三个 Swift helper。现在每次直接
# 在这个 set -e/pipefail 脚本里跑完整测试与构建；任何一步非 0 都会在碰桌面包前停下。
echo "==> 跑完整测试、前端构建与原生 helper 校验"
if [ "$SOURCE_PROJECT" != "$PROJECT" ]; then
  echo "==> 使用已物化的隔离输入：$SOURCE_PROJECT"
fi
(cd "$SOURCE_PROJECT" && npm test)
[ -f "$SOURCE_PROJECT/dist/index.html" ] || { echo "构建后仍找不到 dist/index.html" >&2; exit 1; }

if [ ! -d "$DESKTOP_APP" ]; then
  echo "桌面上找不到 kaii-agent.app，无法沿用既有 Electron 壳" >&2
  exit 1
fi

# 每轮会攒下两份 ~280MB（一份回滚备份 + 一份产物）。不清理的话
# 几十轮就是 19GB，磁盘直接满，测试和构建会以看不懂的方式失败——
# 这事真发生过一次。只留最近三轮，够回滚就行。
KEEP=3
echo "==> 清理旧构建，只留最近 $KEEP 轮"
# `set -o pipefail` 下，没有旧产物时 `ls` 的非 0 也会让整个打包中止。
# 先判断 glob 真有命中，首次打包和已经有历史的机器都走同一条路。
if compgen -G "$RELEASE/manual-*" >/dev/null; then
  ls -dt "$RELEASE"/manual-* | tail -n +$((KEEP + 1)) | while read -r stale; do
    [ "$stale" = "$RELEASE/manual-$LABEL" ] && continue
    rm -rf "$stale"
  done
fi
if compgen -G "$RELEASE/previous/*.app" >/dev/null; then
  ls -dt "$RELEASE"/previous/*.app | tail -n +$((KEEP + 1)) | while read -r stale; do
    rm -rf "$stale"
  done
fi

echo "==> 备份当前桌面版本到 $BACKUP"
rm -rf "$BACKUP"
mkdir -p "$RELEASE/previous"
cp -R "$DESKTOP_APP" "$BACKUP"

echo "==> 组装 asar 内容"
rm -rf "$RELEASE/manual-$LABEL"
assemble_asar "$STAGE" "$RELEASE/manual-$LABEL"

# 关键：一定要在非 iCloud 目录里组装并签名。Documents 与 Desktop 上的包会带
# com.apple.FinderInfo 和 com.apple.fileprovider 扩展属性，codesign 会直接拒签
# （报 "resource fork, Finder information, or similar detritus not allowed"），
# 结果是装出一个签名坏掉的 .app。ditto --noextattr 复制到 /tmp 再签就没有这个问题。
WORK="$(mktemp -d /tmp/kaii-pack-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "==> 在 $WORK 组装干净的 Electron 壳"
ditto --norsrc --noextattr --noqtn "$BACKUP" "$WORK/kaii-agent.app"
cp "$ASAR_PATH" "$WORK/kaii-agent.app/Contents/Resources/app.asar"
copy_external_helpers "$WORK/kaii-agent.app/Contents/Resources/bin"
copy_bundle_icon "$WORK/kaii-agent.app/Contents/Resources/icon.icns"
mkdir -p "$WORK/kaii-agent.app/Contents/Resources/tray"
cp "$SOURCE_PROJECT"/resources/tray/*.png "$WORK/kaii-agent.app/Contents/Resources/tray/"

# 语音识别要一条单独的用途说明，Electron 的默认 Info.plist 里没有。
# 顺手把几句英文样板换成人话——这些字是弹权限框时用户唯一看到的解释，
# "This app needs access to the microphone" 等于什么都没说。
PLIST="$WORK/kaii-agent.app/Contents/Info.plist"
set_plist_string() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}
set_plist_string CFBundleDisplayName "kaii-agent"
set_plist_string CFBundleName "kaii-agent"
set_plist_string NSSpeechRecognitionUsageDescription "把你说的话转成文字。识别在这台电脑上完成，声音不会发到网上。"
set_plist_string NSMicrophoneUsageDescription "用来听写。只在你按下说话按钮时录音，松开就停。"

ASAR_SHA="$(shasum -a 256 "$WORK/kaii-agent.app/Contents/Resources/app.asar" | cut -d' ' -f1)"
VISION_SHA="$(shasum -a 256 "$WORK/kaii-agent.app/Contents/Resources/bin/kaii-vision" | cut -d' ' -f1)"
DOC_SHA="$(shasum -a 256 "$WORK/kaii-agent.app/Contents/Resources/bin/kaii-doc" | cut -d' ' -f1)"
SPEECH_SHA="$(shasum -a 256 "$WORK/kaii-agent.app/Contents/Resources/bin/kaii-speech" | cut -d' ' -f1)"
ICON_SHA="$(shasum -a 256 "$WORK/kaii-agent.app/Contents/Resources/icon.icns" | cut -d' ' -f1)"

ASAR_HEADER_SHA="$(node -e 'const crypto = require("node:crypto"); const asar = require(process.argv[1]); process.stdout.write(crypto.createHash("sha256").update(asar.getRawHeader(process.argv[2]).headerString).digest("hex"));' "$SOURCE_PROJECT/node_modules/@electron/asar" "$ASAR_PATH")"
echo "==> 写回 ElectronAsarIntegrity 的归档头 SHA256"
/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $ASAR_HEADER_SHA" "$WORK/kaii-agent.app/Contents/Info.plist"

echo "==> 本机 ad-hoc 签名（未做 Developer ID 签名与公证）"
xattr -rc "$WORK/kaii-agent.app"
codesign --force --deep --sign - "$WORK/kaii-agent.app"
codesign --verify --verbose=2 "$WORK/kaii-agent.app"

echo "==> 留一份可追溯的产物"
rm -rf "$OUT_APP"
ditto --norsrc --noextattr --noqtn "$WORK/kaii-agent.app" "$OUT_APP"
codesign --verify "$OUT_APP"

echo "==> 安装到桌面"
rm -rf "$DESKTOP_APP"
ditto --norsrc --noextattr --noqtn "$WORK/kaii-agent.app" "$DESKTOP_APP"
# 完整的 deep/strict 校验已经在未受 FileProvider 管理的 $WORK 中通过。
# Desktop / Documents 会在复制结束后立刻给 bundle 节点重新附加空 FinderInfo；
# 这不会改签名或应用字节，却会让 deep/strict 把云盘元数据当成 bundle 污染。
# 因此落盘处只验顶层签名，下面再逐项核 app.asar 与三个 helper 的内容哈希。
codesign --verify "$DESKTOP_APP"

DESKTOP_SHA="$(shasum -a 256 "$DESKTOP_APP/Contents/Resources/app.asar" | cut -d' ' -f1)"
if [ "$DESKTOP_SHA" != "$ASAR_SHA" ]; then
  echo "桌面包和构建产物不一致，停止" >&2
  exit 1
fi
for helper in kaii-vision kaii-doc kaii-speech; do
  source_sha="$(shasum -a 256 "$SOURCE_PROJECT/resources/bin/$helper" | cut -d' ' -f1)"
  desktop_sha="$(shasum -a 256 "$DESKTOP_APP/Contents/Resources/bin/$helper" | cut -d' ' -f1)"
  [ "$source_sha" = "$desktop_sha" ] \
    || { echo "桌面包中的 $helper 和构建产物不一致，停止" >&2; exit 1; }
done
DESKTOP_ICON_SHA="$(shasum -a 256 "$DESKTOP_APP/Contents/Resources/icon.icns" | cut -d' ' -f1)"
[ "$DESKTOP_ICON_SHA" = "$ICON_SHA" ] \
  || { echo "桌面包中的应用图标和构建产物不一致，停止" >&2; exit 1; }

echo
echo "完成。"
echo "app.asar   SHA256 = $ASAR_SHA"
echo "kaii-vision SHA256 = $VISION_SHA"
echo "kaii-doc    SHA256 = $DOC_SHA"
echo "kaii-speech SHA256 = $SPEECH_SHA"
echo "icon.icns    SHA256 = $ICON_SHA"
echo "入包内容清单 = $CONTENT_MANIFEST"
echo "旧版本备份 = $BACKUP"

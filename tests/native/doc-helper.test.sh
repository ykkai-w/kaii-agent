#!/bin/bash
set -euo pipefail

# 本机 PDF 取字助手的 smoke：现造一个带文字层的最小 PDF，抽回文字，核对内容对得上。
# PDF 由 Python 标准库手工拼出来，不依赖 PyObjC、cupsfilter 或任何第三方工具。
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
helper="$project_root/resources/bin/kaii-doc"

if [[ ! -x "$helper" ]]; then
  echo "kaii-doc 不存在或不可执行：$helper" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

marker="kaii doc smoke marker 42"

/usr/bin/env python3 - "$work/sample.pdf" "$marker" <<'PYEOF'
import sys

target, marker = sys.argv[1], sys.argv[2]
stream = f"BT /F1 24 Tf 60 700 Td ({marker}) Tj ET".encode("ascii")

objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
    b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
]

out = bytearray(b"%PDF-1.4\n")
offsets = []
for index, body in enumerate(objects, start=1):
    offsets.append(len(out))
    out += f"{index} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

xref_at = len(out)
out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
out += b"0000000000 65535 f \n"
for offset in offsets:
    out += f"{offset:010d} 00000 n \n".encode("ascii")
out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode("ascii")

with open(target, "wb") as handle:
    handle.write(bytes(out))
PYEOF

cat > "$work/check.py" <<'PYCHECK'
import json, sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

if sys.argv[2] == "ok":
    marker = sys.argv[3]
    assert data["ok"] is True, data
    assert data["kind"] == "pdf", data["kind"]
    assert data["page_count"] == 1, data["page_count"]
    assert data["has_text_layer"] is True, "抽不到文本层"
    text = "".join(page["text"] for page in data["pages"])
    assert marker in text, "取回的文字对不上：" + repr(text[:120])
    print("doc-helper smoke PASS: %d 页, %d 字" % (data["page_count"], data["characters"]))
else:
    assert data["ok"] is False, data
    assert data["error"]["code"] == sys.argv[3], data
    print("doc-helper 边界检查 PASS")
PYCHECK

"$helper" "$work/sample.pdf" > "$work/out.json"
/usr/bin/env python3 "$work/check.py" "$work/out.json" ok "$marker"

# 边界：非 PDF、相对路径、不存在的文件都必须干净地失败，且失败也要输出合法 JSON。
if "$helper" "$work/sample.pdf" "多余参数" > "$work/usage.json"; then
  echo "多余参数竟然被接受了" >&2
  exit 1
fi
/usr/bin/env python3 "$work/check.py" "$work/usage.json" fail usage
printf 'not a pdf at all' > "$work/fake.pdf"
if "$helper" "$work/fake.pdf" > "$work/fake.json"; then
  echo "假 PDF 竟然成功了" >&2
  exit 1
fi
/usr/bin/env python3 "$work/check.py" "$work/fake.json" fail unreadable_document
if "$helper" "relative.pdf" >/dev/null 2>&1; then
  echo "相对路径竟然被接受了" >&2
  exit 1
fi
"$helper" "relative.pdf" > "$work/err.json" 2>/dev/null || true
/usr/bin/env python3 "$work/check.py" "$work/err.json" fail path_not_absolute

if "$helper" "$work/missing.pdf" > "$work/missing.json"; then
  echo "不存在的 PDF 竟然成功了" >&2
  exit 1
fi
/usr/bin/env python3 "$work/check.py" "$work/missing.json" fail not_a_file

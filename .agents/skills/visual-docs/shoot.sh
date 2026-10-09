#!/bin/sh
# 渲染图解页并切片：shoot.sh <页面路径> [输出前缀，默认 /tmp/vis-<页面名>]
# 输出 <前缀>-1.png、<前缀>-2.png…，每张 1100×1400，<details> 全部展开。
# 依赖 Chrome / Chromium 与带 Pillow 的 python3；找不到时用 CHROME=… / PYTHON=… 指定。
set -e
dir=$(cd "$(dirname "$1")" && pwd)
name=$(basename "$1" .html)
out="${2:-/tmp/vis-$name}"

chrome="$CHROME"
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
  [ -z "$chrome" ] && [ -n "$c" ] && [ -x "$c" ] && chrome="$c"
done
[ -n "$chrome" ] || { echo "找不到 Chrome，用 CHROME=… 指定" >&2; exit 1; }
py="$PYTHON"
for p in python3 "$HOME/miniforge3/bin/python3"; do
  [ -z "$py" ] && "$p" -c "import PIL" 2>/dev/null && py="$p"
done
[ -n "$py" ] || { echo "找不到带 Pillow 的 python3，用 PYTHON=… 指定" >&2; exit 1; }

# 副本放在 /tmp：<base> 指回原目录（样式与脚本照常加载），<details> 改为展开
tmp="/tmp/vis-$name-open.html"
sed -e "s#<head>#<head><base href=\"file://$dir/\">#" -e 's/<details>/<details open>/g; s/<details /<details open /g' "$dir/$name.html" > "$tmp"
"$chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1100,32000 --screenshot="$out-full.png" "file://$tmp" 2>/dev/null

"$py" - "$out" <<'PY'
import sys
from PIL import Image
out = sys.argv[1]
im = Image.open(out + "-full.png").convert("RGB")
w, h = im.size
px = im.load()
bg = px[5, h - 5]
last = h - 1
while last > 0 and all(px[x, last] == bg for x in range(0, w, 7)):
    last -= 1
if last > h - 40:
    print("警告：页面可能超过 32000px，最后一张被截断")
n = 0
for top in range(0, last + 1, 1400):
    n += 1
    im.crop((0, top, w, min(top + 1400, last + 20))).save(f"{out}-{n}.png")
print(f"{n} 张：{out}-1.png … {out}-{n}.png（页面高约 {last}px）")
PY

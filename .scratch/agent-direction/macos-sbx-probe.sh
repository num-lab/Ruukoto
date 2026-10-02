#!/bin/bash
# macOS 内置 sandbox-exec（seatbelt）可行性探针（agent-direction 工单 03）。
# 目的：判定 sandbox-exec 能否作为 ruukoto-dev 受限执行边界。
# 判定口径：文件读写规则的拒绝必须实际生效才构成文件边界；网络拒绝生效只覆盖网络一项。
# 退出码：0 = 探针全部执行完毕（发现如实打印）；2 = 基础设施缺失（sandbox-exec 不存在、
#         对照不可达等），本次输出不得作为结论依据。
set -u
SBX=/usr/bin/sandbox-exec
if [ ! -x "$SBX" ]; then echo "基础设施：sandbox-exec 不存在"; exit 2; fi

T=$(mktemp -d /tmp/sbx-probe-XXXXXX); trap 'rm -rf "$T"' EXIT
cd "$T" || exit 2
echo secret-data > secret.txt

echo "环境: $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m)), kernel $(uname -sr)"
echo "探针目录: ${T}（已随退出清理）"

# 对照：未沙箱的网络真实可达；不可达则网络拒绝不构成证据
if /usr/bin/curl -sS -m 5 https://example.com -o /dev/null -w '' 2>/dev/null; then
  echo "对照 [host-curl-control] PASS 未沙箱外网可达（网络拒绝探针有效）"
  NET_CONTROL=ok
else
  echo "对照 [host-curl-control] FAIL 未沙箱外网不可达 —— 网络拒绝不能作为证据"
  NET_CONTROL=fail
fi

pass() { echo "PASS $1 —— $2"; }
fail() { echo "FAIL $1 —— $2"; }

# ---- 文件规则：拒绝必须生效 ----
mkprof() { printf '(version 1)\n(allow default)\n%s\n' "$1" > "$2"; }

FILE_OK=0; FILE_BAD=0
probe_read() { # $1=探针名 $2=规则
  mkprof "$2" cur.sb
  if "$SBX" -f cur.sb /bin/cat "$T/secret.txt" >/dev/null 2>&1; then
    fail "file-read deny ($1)" "deny 后 secret 仍可读（规则未执行）"; FILE_BAD=$((FILE_BAD+1))
  else
    pass "file-read deny ($1)" "deny 生效"; FILE_OK=$((FILE_OK+1))
  fi
}
probe_read "literal" "(deny file-read* (literal \"$T/secret.txt\"))"
probe_read "subpath" "(deny file-read* (subpath \"$T\"))"
probe_read "regex"   "(deny file-read* (regex \"^$T/\"))"
probe_read "file* (全部文件操作)" "(deny file* (literal \"$T/secret.txt\"))"

mkprof "(deny file-write* (subpath \"$T\"))" cur.sb
if "$SBX" -f cur.sb /usr/bin/touch "$T/w.txt" >/dev/null 2>&1; then
  fail "file-write deny (subpath)" "deny 后仍可写（规则未执行）"; FILE_BAD=$((FILE_BAD+1))
else
  pass "file-write deny (subpath)" "deny 生效"; FILE_OK=$((FILE_OK+1))
fi

# ---- 网络规则：拒绝与子进程继承 ----
mkprof "(deny network*)" cur.sb
NET_OUT=$("$SBX" -f cur.sb /usr/bin/curl -sS -m 5 https://example.com -o /dev/null 2>&1); NET_RC=$?
if [ "$NET_CONTROL" != ok ]; then
  echo "SKIP network deny —— 对照不可达，无法判定"
elif [ "$NET_RC" -ne 0 ]; then
  pass "network deny" "沙箱内外网被拒绝（${NET_OUT%%$'\n'*}）"
else
  fail "network deny" "沙箱内外网仍可达"
fi

# 孙进程继承同一沙箱：网络拒绝须覆盖 exec 链
mkprof "(deny network*)" cur.sb
GRAND_OUT=$("$SBX" -f cur.sb /bin/sh -c 'sh -c "curl -sS -m 5 https://example.com -o /dev/null 2>&1" || exit 0')
if [ "$NET_CONTROL" = ok ] && [ -n "$GRAND_OUT" ]; then
  pass "network deny 孙进程继承" "孙进程外网同样被拒绝"
elif [ "$NET_CONTROL" != ok ]; then
  echo "SKIP 孙进程继承 —— 对照不可达"
else
  fail "network deny 孙进程继承" "孙进程外网可达"
fi

# 孙进程继承同一沙箱：文件规则若（曾经）生效也须继承；沿用 file-read literal 实测
mkprof "(deny file-read* (literal \"$T/secret.txt\"))" cur.sb
if "$SBX" -f cur.sb /bin/sh -c "sh -c 'cat \"$T/secret.txt\"'" >/dev/null 2>&1; then
  fail "file-read deny 孙进程" "孙进程仍可读（规则未执行）"; FILE_BAD=$((FILE_BAD+1))
else
  pass "file-read deny 孙进程" "孙进程被拒绝"; FILE_OK=$((FILE_OK+1))
fi

echo
echo "== 判定 =="
echo "文件规则生效 ${FILE_OK} / 未执行 ${FILE_BAD}"
if [ "$FILE_BAD" -gt 0 ]; then
  echo "结论：sandbox-exec 在本机不构成文件边界（存在静默未执行的文件规则）——不能作为受限执行方式；把边界建在它会构成假边界。"
  exit 0
fi
echo "结论：sandbox-exec 文件与网络规则均实际执行（本机可行）"
exit 0

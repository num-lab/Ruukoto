#!/usr/bin/env bash
set -u
task_root=/tmp/ruukoto-pi-mcp.r0wcnE
export PATH="$task_root/tools/ripgrep/usr/bin:$PATH"
export TMPDIR="$task_root/tmp"
export npm_config_cache="$task_root/npm-cache"
export RUN_MODEL_CHECK=0
cd "$task_root/source" || exit 1
node --version >"$task_root/logs/environment.txt"
uname -a >>"$task_root/logs/environment.txt"
rg --version >>"$task_root/logs/environment.txt"
systemctl --user is-active default.target >>"$task_root/logs/environment.txt"
failed=0
./node_modules/.bin/tsx --test --test-concurrency=2 test/mcp-response-observer.test.ts test/mcp-transport.test.ts test/24-mcp.test.ts test/25-mcp-write.test.ts test/cua-mcp.test.ts test/cua-code.test.ts test/personal-cua.test.ts test/personal-mcp.test.ts test/personal-mcp-recovery.test.ts test/personal-mcp-config.test.ts test/personal-mcp-publication.test.ts test/personal-mcp-updates.test.ts test/native-linux-identity.test.ts test/101-native-linux-scope.test.ts test/101-native-execution.test.ts >"$task_root/logs/mcp-native-tests.log" 2>&1
result=$?
printf 'mcp-native-tests exit=%s\n' "$result"
test "$result" -eq 0 || failed=1
./node_modules/.bin/tsx --test --test-name-pattern=真实Linux test/personal-background-processes.test.ts >"$task_root/logs/personal-background-real-linux.log" 2>&1
result=$?
printf 'personal-background-real-linux exit=%s\n' "$result"
test "$result" -eq 0 || failed=1
./node_modules/.bin/tsx verification/foundation/scripts/native-isolation/linux-scope-probe.mts "$task_root/logs" >"$task_root/logs/linux-scope-probe.log" 2>&1
result=$?
printf 'linux-scope-probe exit=%s\n' "$result"
test "$result" -eq 0 || failed=1
./node_modules/.bin/tsx native-cua-scope-probe.mts >"$task_root/logs/native-cua-scope-probe.log" 2>&1
result=$?
printf 'native-cua-scope-probe exit=%s\n' "$result"
test "$result" -eq 0 || failed=1
exit "$failed"

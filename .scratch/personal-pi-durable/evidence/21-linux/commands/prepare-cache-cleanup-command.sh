set -e
run_dir=/tmp/rk-linux-verify.CohhCfz7
cache_dir=/dev/shm/rk-linux-deps.H6A9ny4b/npm-cache
{
  date -u +%Y-%m-%dT%H:%M:%SZ
  du -sh "$cache_dir/_cacache"
  rm -rf -- "$cache_dir/_cacache"
  df -h /tmp /dev/shm
} > "$run_dir/logs/prepare-cache-cleanup.log"
cat "$run_dir/logs/prepare-cache-cleanup.log"

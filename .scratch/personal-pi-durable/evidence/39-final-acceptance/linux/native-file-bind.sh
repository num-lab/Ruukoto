set -eu
repo=/home/ubuntu/.local/ruukoto39/current
root=$(mktemp -d /tmp/ruukoto39-file-bind-XXXXXX)
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then umount "$root/safe/alias"; fi
  rm -rf -- "$root"
}
trap cleanup EXIT
mount --make-rprivate /
mkdir -p "$root/private/nested" "$root/safe"
printf private > "$root/private/nested/source"
printf safe > "$root/safe/alias"
printf other > "$root/safe/other"
mount --bind "$root/private/nested/source" "$root/safe/alias"
mounted=true
cd "$repo"
/usr/local/bin/node --import tsx /tmp/ruukoto39-native-file-bind.mjs "$repo" "$root" mounted
umount "$root/safe/alias"
mounted=false
/usr/local/bin/node --import tsx /tmp/ruukoto39-native-file-bind.mjs "$repo" "$root" unmounted

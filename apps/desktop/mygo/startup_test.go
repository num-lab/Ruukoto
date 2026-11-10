package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func signedStartupFixture(t *testing.T) (string, string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(root, "ruukoto.app")
	executable := filepath.Join(bundle, "Contents", "MacOS", "ruukoto")
	resources := filepath.Join(bundle, "Contents", "Resources")
	for _, dir := range []string{filepath.Dir(executable), resources} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	program, err := os.ReadFile("/usr/bin/true")
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{executable, filepath.Join(root, "node")} {
		if err := os.WriteFile(target, program, 0700); err != nil {
			t.Fatal(err)
		}
	}
	node := filepath.Join(root, "node")
	digest := sha256.Sum256(program)
	launch, _ := json.Marshal(sidecarLaunch{Node: node, NodeSHA256: hex.EncodeToString(digest[:]), Mode: "production", Name: "ruukoto", Identifier: "dev.ruukoto.desktop.mygo"})
	for target, data := range map[string][]byte{
		filepath.Join(resources, "launch.json"):         launch,
		filepath.Join(resources, "sidecar.mjs"):         []byte("// fixture"),
		filepath.Join(bundle, "Contents", "Info.plist"): []byte(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.ruukoto.desktop.mygo</string><key>CFBundleExecutable</key><string>ruukoto</string></dict></plist>`),
	} {
		if err := os.WriteFile(target, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if out, err := exec.Command("/usr/bin/codesign", "--force", "--sign", "-", bundle).CombinedOutput(); err != nil {
		t.Fatalf("codesign: %v %s", err, out)
	}
	return executable, resources, node
}

func TestTrustedSidecarRejectsChangedResourcesAndNode(t *testing.T) {
	for _, target := range []string{"sidecar", "node"} {
		t.Run(target, func(t *testing.T) {
			executable, resources, node := signedStartupFixture(t)
			inherited := []string{"PATH=/usr/bin", "NODE_OPTIONS=--import=/untrusted", "NODE_TLS_REJECT_UNAUTHORIZED=0", "DYLD_INSERT_LIBRARIES=/untrusted", "ELECTRON_RENDERER_URL=https://untrusted", "RUUKOTO_DATA_DIR=/original"}
			cmd, err := trustedSidecar(executable, resources, "/original-user", inherited)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(cmd.Args, []string{node, "--disable-sigusr1", "--no-global-search-paths", filepath.Join(resources, "sidecar.mjs"), "/original-user"}) {
				t.Fatalf("unexpected args: %v", cmd.Args)
			}
			if !reflect.DeepEqual(cmd.Env, []string{"PATH=/usr/bin", "RUUKOTO_DATA_DIR=/original"}) {
				t.Fatalf("unsafe env: %v", cmd.Env)
			}
			changed := filepath.Join(resources, "sidecar.mjs")
			if target == "node" {
				changed = node
			}
			if err := os.WriteFile(changed, []byte("replaced"), 0700); err != nil {
				t.Fatal(err)
			}
			if _, err := trustedSidecar(executable, resources, "/original-user", inherited); err == nil {
				t.Fatal("changed program accepted")
			}
		})
	}
}

func TestDevelopmentNamespaceComesFromSignedLaunch(t *testing.T) {
	executable, resources, _ := signedStartupFixture(t)
	file := filepath.Join(resources, "launch.json")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var launch sidecarLaunch
	if err := json.Unmarshal(data, &launch); err != nil {
		t.Fatal(err)
	}
	launch.Mode = "development"
	launch.Name = "ruukoto Development abcdef0123456789"
	launch.Identifier = "dev.ruukoto.desktop.mygo.development.abcdef0123456789"
	launch.ProfileEnv = map[string]string{"RUUKOTO_DATA_DIR": "/dev/data", "RUUKOTO_AGENT_DIR": "/dev/agent", "RUUKOTO_CONTROL_DIR": "/dev/control", "RUUKOTO_PENDING_DIR": "/dev/pending"}
	renamed := filepath.Join(filepath.Dir(executable), launch.Name)
	if err := os.Rename(executable, renamed); err != nil { t.Fatal(err) }
	executable = renamed
	plist := []byte(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>` + launch.Identifier + `</string><key>CFBundleExecutable</key><string>` + launch.Name + `</string></dict></plist>`)
	if err := os.WriteFile(filepath.Join(filepath.Dir(resources), "Info.plist"), plist, 0600); err != nil { t.Fatal(err) }
	data, err = json.Marshal(launch)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	if out, err := exec.Command("/usr/bin/codesign", "--force", "--sign", "-", bundle).CombinedOutput(); err != nil {
		t.Fatalf("sign: %v %s", err, out)
	}
	cmd, err := trustedSidecar(executable, resources, "/isolated-native", []string{"RUUKOTO_DATA_DIR=/daily", "RUUKOTO_DEV_MANAGED=0", "RUUKOTO_OWNER_TOKEN=daily-secret", "RUUKOTO_OWNER_TOKEN_FILE=/daily/token"})
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Args[len(cmd.Args)-1] != "/isolated-native" { t.Fatal("native identity changed") }
	for key, value := range launch.ProfileEnv {
		if !slices.Contains(cmd.Env, key+"="+value) { t.Fatal("raw selection missing", key) }
	}
	if !slices.Contains(cmd.Env, "RUUKOTO_DEV_MANAGED=1") || slices.Contains(cmd.Env, "RUUKOTO_DATA_DIR=/daily") { t.Fatal("signed development selection not authoritative") }
	for _, entry := range cmd.Env {
		key, _, _ := strings.Cut(entry, "=")
		if key == "RUUKOTO_OWNER_TOKEN" || key == "RUUKOTO_OWNER_TOKEN_FILE" { t.Fatal("daily authentication entered development", key) }
	}
}
func TestSignedNativeIdentityCannotDisagreeWithBundle(t *testing.T) {
	executable, resources, _ := signedStartupFixture(t)
	file := filepath.Join(resources, "launch.json")
	data, err := os.ReadFile(file)
	if err != nil { t.Fatal(err) }
	var launch sidecarLaunch
	if err := json.Unmarshal(data, &launch); err != nil { t.Fatal(err) }
	launch.Identifier = "dev.ruukoto.desktop.mygo.development.abcdef0123456789"
	data, err = json.Marshal(launch)
	if err != nil { t.Fatal(err) }
	if err := os.WriteFile(file, data, 0600); err != nil { t.Fatal(err) }
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	if out, err := exec.Command("/usr/bin/codesign", "--force", "--sign", "-", bundle).CombinedOutput(); err != nil { t.Fatalf("sign: %v %s", err, out) }
	if _, err := trustedSidecar(executable, resources, "/unused", nil); err == nil { t.Fatal("mismatched native identity accepted") }
}

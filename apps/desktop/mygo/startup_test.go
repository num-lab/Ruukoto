package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func signedStartupFixture(t *testing.T) (string, string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(root, "Fixture.app")
	executable := filepath.Join(bundle, "Contents", "MacOS", "Fixture")
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
	launch, _ := json.Marshal(sidecarLaunch{Node: node, NodeSHA256: hex.EncodeToString(digest[:]), CredentialNamespace: "production"})
	for target, data := range map[string][]byte{
		filepath.Join(resources, "launch.json"):         launch,
		filepath.Join(resources, "sidecar.mjs"):         []byte("// fixture"),
		filepath.Join(bundle, "Contents", "Info.plist"): []byte(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.ruukoto.mygo.startup.fixture</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>`),
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
			inherited := []string{"PATH=/usr/bin", "NODE_OPTIONS=--import=/untrusted", "NODE_TLS_REJECT_UNAUTHORIZED=0", "DYLD_INSERT_LIBRARIES=/untrusted", "ELECTRON_RENDERER_URL=https://untrusted", "RUUKOTO_CODE_DATA_DIR=/original"}
			cmd, namespace, err := trustedSidecar(executable, resources, "/original-user", inherited)
			if err != nil {
				t.Fatal(err)
			}
			if namespace != "production" {
				t.Fatal("namespace changed")
			}
			if !reflect.DeepEqual(cmd.Args, []string{node, "--disable-sigusr1", "--no-global-search-paths", filepath.Join(resources, "sidecar.mjs"), "/original-user"}) {
				t.Fatalf("unexpected args: %v", cmd.Args)
			}
			if !reflect.DeepEqual(cmd.Env, []string{"PATH=/usr/bin", "RUUKOTO_CODE_DATA_DIR=/original"}) {
				t.Fatalf("unsafe env: %v", cmd.Env)
			}
			changed := filepath.Join(resources, "sidecar.mjs")
			if target == "node" {
				changed = node
			}
			if err := os.WriteFile(changed, []byte("replaced"), 0700); err != nil {
				t.Fatal(err)
			}
			if _, _, err := trustedSidecar(executable, resources, "/original-user", inherited); err == nil {
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
	launch.CredentialNamespace = "development"
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
	cmd, namespace, err := trustedSidecar(executable, resources, "/original-user", []string{"RUUKOTO_MYGO_CREDENTIAL_NAMESPACE=production"})
	if err != nil {
		t.Fatal(err)
	}
	if namespace != "development" || cmd.Args[len(cmd.Args)-1] != "/original-user/development" {
		t.Fatal("development credentials share production namespace")
	}
}

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type sidecarLaunch struct {
	Node       string `json:"node"`
	NodeSHA256 string `json:"nodeSha256"`
	Mode       string `json:"mode"`
	Name       string `json:"name"`
	Identifier string `json:"identifier"`
	ProfileEnv map[string]string `json:"profileEnv,omitempty"`
}

func hostEnvironment(inherited []string) []string {
	clean := make([]string, 0, len(inherited))
	for _, entry := range inherited {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "NODE_") || strings.HasPrefix(key, "DYLD_") || strings.HasPrefix(key, "LD_") {
			continue
		}
		switch key {
		case "ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RUUKOTO_DESKTOP_DEV_NONCE", "RUUKOTO_DESKTOP_MYGO_USER_DATA", "RUUKOTO_DEV_MANAGED", "OPENSSL_CONF", "OPENSSL_MODULES", "SSL_CERT_FILE", "SSL_CERT_DIR", "SSLKEYLOGFILE", "CODESIGN_ALLOCATE":
			continue
		}
		clean = append(clean, entry)
	}
	return clean
}

// The signed bundle binds the Node executable and installation mode before any sidecar state is opened.
func trustedSidecar(executable, resources, userData string, inherited []string) (*exec.Cmd, error) {
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	resources, err = filepath.EvalSymlinks(resources)
	if err != nil || !strings.HasSuffix(bundle, ".app") || resources != filepath.Join(bundle, "Contents", "Resources") {
		return nil, errors.New("invalid app resource location")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	verify := exec.CommandContext(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", bundle)
	verify.Env = hostEnvironment(inherited)
	if err := verify.Run(); err != nil {
		return nil, errors.New("app signature or resource verification failed")
	}
	var launch sidecarLaunch
	data, err := os.ReadFile(filepath.Join(resources, "launch.json"))
	if err != nil || json.Unmarshal(data, &launch) != nil || !filepath.IsAbs(launch.Node) || len(launch.NodeSHA256) != 64 || launch.Mode != "production" && launch.Mode != "development" {
		return nil, errors.New("invalid pinned Node configuration")
	}
	node, err := filepath.EvalSymlinks(launch.Node)
	if err != nil || node != launch.Node {
		return nil, errors.New("pinned Node path changed")
	}
	info, err := os.Stat(node)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return nil, errors.New("pinned Node not executable")
	}
	data, err = os.ReadFile(node)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != launch.NodeSHA256 {
		return nil, errors.New("pinned Node contents changed")
	}
	sidecar := filepath.Join(resources, "sidecar.mjs")
	actual, err := filepath.EvalSymlinks(sidecar)
	if err != nil || actual != sidecar {
		return nil, errors.New("invalid host script path")
	}
	info, err = os.Stat(sidecar)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("host script unavailable")
	}
	metadata := exec.CommandContext(ctx, "/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", filepath.Join(bundle, "Contents", "Info.plist"))
	metadata.Env = hostEnvironment(inherited)
	identifier, err := metadata.Output()
	if err != nil || strings.TrimSpace(string(identifier)) != launch.Identifier || filepath.Base(executable) != launch.Name {
		return nil, errors.New("signed application identity mismatch")
	}
	if launch.Mode == "development" {
		identity := strings.TrimPrefix(launch.Name, "ruukoto Development ")
		decoded, identityErr := hex.DecodeString(identity)
		if identityErr != nil || len(decoded) != 8 || hex.EncodeToString(decoded) != identity || launch.Identifier != "dev.ruukoto.desktop.mygo.development."+identity || len(launch.ProfileEnv) != 4 {
			return nil, errors.New("invalid development identity")
		}
		for _, key := range []string{"RUUKOTO_DATA_DIR", "RUUKOTO_AGENT_DIR", "RUUKOTO_CONTROL_DIR", "RUUKOTO_PENDING_DIR"} {
			if !filepath.IsAbs(launch.ProfileEnv[key]) { return nil, errors.New("incomplete development profile") }
		}
	} else if launch.Name != "ruukoto" || launch.Identifier != "dev.ruukoto.desktop.mygo" || len(launch.ProfileEnv) != 0 {
		return nil, errors.New("invalid production identity")
	}
	cmd := exec.Command(node, "--disable-sigusr1", "--no-global-search-paths", sidecar, userData)
	cmd.Env = hostEnvironment(inherited)
	if launch.Mode == "development" {
		clean := cmd.Env[:0]
		for _, entry := range cmd.Env {
			key, _, _ := strings.Cut(entry, "=")
			if key != "RUUKOTO_OWNER_TOKEN" && key != "RUUKOTO_OWNER_TOKEN_FILE" {
				clean = append(clean, entry)
			}
		}
		cmd.Env = clean
		for key, value := range launch.ProfileEnv {
			prefix := key + "="
			clean := cmd.Env[:0]
			for _, entry := range cmd.Env { if !strings.HasPrefix(entry, prefix) { clean = append(clean, entry) } }
			cmd.Env = append(clean, prefix + value)
		}
		cmd.Env = append(cmd.Env, "RUUKOTO_DEV_MANAGED=1")
	}
	return cmd, nil
}

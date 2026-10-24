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
	Node                string `json:"node"`
	NodeSHA256          string `json:"nodeSha256"`
	CredentialNamespace string `json:"credentialNamespace"`
}

func hostEnvironment(inherited []string) []string {
	clean := make([]string, 0, len(inherited))
	for _, entry := range inherited {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "NODE_") || strings.HasPrefix(key, "DYLD_") || strings.HasPrefix(key, "LD_") {
			continue
		}
		switch key {
		case "ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RUUKOTO_DESKTOP_DEV_NONCE", "RUUKOTO_DESKTOP_MYGO_USER_DATA", "OPENSSL_CONF", "OPENSSL_MODULES", "SSL_CERT_FILE", "SSL_CERT_DIR", "SSLKEYLOGFILE", "CODESIGN_ALLOCATE":
			continue
		}
		clean = append(clean, entry)
	}
	return clean
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
func trustedSidecar(executable, resources, userData string, inherited []string) (*exec.Cmd, string, error) {
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, "", err
	}
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	resources, err = filepath.EvalSymlinks(resources)
	if err != nil || !strings.HasSuffix(bundle, ".app") || resources != filepath.Join(bundle, "Contents", "Resources") {
		return nil, "", errors.New("应用资源位置无效")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	verify := exec.CommandContext(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", bundle)
	verify.Env = hostEnvironment(inherited)
	if err := verify.Run(); err != nil {
		return nil, "", errors.New("应用签名或资源校验失败")
	}
	var launch sidecarLaunch
	data, err := os.ReadFile(filepath.Join(resources, "launch.json"))
	if err != nil || json.Unmarshal(data, &launch) != nil || !filepath.IsAbs(launch.Node) || len(launch.NodeSHA256) != 64 || launch.CredentialNamespace != "production" && launch.CredentialNamespace != "development" {
		return nil, "", errors.New("固定 Node 配置无效")
	}
	node, err := filepath.EvalSymlinks(launch.Node)
	if err != nil || node != launch.Node {
		return nil, "", errors.New("固定 Node 路径已改变")
	}
	info, err := os.Stat(node)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return nil, "", errors.New("固定 Node 不可执行")
	}
	data, err = os.ReadFile(node)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != launch.NodeSHA256 {
		return nil, "", errors.New("固定 Node 内容已改变")
	}
	sidecar := filepath.Join(resources, "sidecar.mjs")
	actual, err := filepath.EvalSymlinks(sidecar)
	if err != nil || actual != sidecar {
		return nil, "", errors.New("宿主脚本路径无效")
	}
	info, err = os.Stat(sidecar)
	if err != nil || !info.Mode().IsRegular() {
		return nil, "", errors.New("宿主脚本不可用")
	}
	if launch.CredentialNamespace == "development" {
		userData = filepath.Join(userData, "development")
	}
	cmd := exec.Command(node, "--disable-sigusr1", "--no-global-search-paths", sidecar, userData)
	cmd.Env = hostEnvironment(inherited)
	return cmd, launch.CredentialNamespace, nil
}

package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

type outputPreviews struct {
	mu   sync.Mutex
	next uint64
	id   uint64
	cmd  *exec.Cmd
	done chan struct{}
}

func outputName(name string) bool {
	return name != "" && len([]rune(name)) <= 128 && strings.TrimSpace(name) != "" && name != "." && name != ".." && !strings.ContainsAny(name, "/\\") && !strings.ContainsFunc(name, func(r rune) bool { return r < 32 || r == 127 })
}

func outputPreviewPath(filename, name string) bool {
	if !outputName(name) || !filepath.IsAbs(filename) || filepath.Clean(filename) != filename || filepath.Base(filename) != name {
		return false
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(filepath.Dir(filename)))
	temporary, tempErr := filepath.EvalSymlinks(os.TempDir())
	return err == nil && tempErr == nil && parent == temporary && strings.HasPrefix(filepath.Base(filepath.Dir(filename)), "ruukoto-output-")
}

func (p *outputPreviews) stop(id uint64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd == nil || id != 0 && id != p.id {
		return nil
	}
	if err := p.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	<-p.done
	p.cmd = nil
	p.done = nil
	return nil
}

func (p *outputPreviews) open(filename, name string) (uint64, error) {
	if !outputPreviewPath(filename, name) {
		return 0, errors.New("invalid preview file")
	}
	if err := p.stop(0); err != nil {
		return 0, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	cmd := exec.Command("/usr/bin/qlmanage", "-p", filename)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	p.next++
	p.id, p.cmd, p.done = p.next, cmd, make(chan struct{})
	done := p.done
	go func() { cmd.Wait(); close(done) }()
	return p.id, nil
}

func outputValue(value any) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"ok": true, "value": value})
	return data
}

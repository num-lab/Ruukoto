package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
)

func readAppearanceFile(t *testing.T, dir string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, appearanceFile))
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("parse preferences: %v", err)
	}
	return stored
}

func TestLoadAppearanceMissingCorruptUnknown(t *testing.T) {
	dir := t.TempDir()
	if got := loadAppearance(dir); got != mygo.ThemeSystem {
		t.Fatalf("missing file: got %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, appearanceFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadAppearance(dir); got != mygo.ThemeSystem {
		t.Fatalf("corrupt file: got %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, appearanceFile), []byte(`{"v":1,"appearance":"sepia"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadAppearance(dir); got != mygo.ThemeSystem {
		t.Fatalf("unknown value: got %q", got)
	}
}

func TestAppearanceDirectoryAtPreferencePath(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, appearanceFile), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if got := loadAppearance(dir); got != mygo.ThemeSystem {
		t.Fatalf("directory at preference path: got %q", got)
	}
}

func TestAppearanceRoundTripAndAtomicWrite(t *testing.T) {
	dir := t.TempDir()
	if err := saveAppearance(dir, mygo.ThemeDark); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := loadAppearance(dir); got != mygo.ThemeDark {
		t.Fatalf("round trip: got %q", got)
	}
	stored := readAppearanceFile(t, dir)
	if stored["v"] != float64(1) || stored["appearance"] != "dark" {
		t.Fatalf("stored shape: %v", stored)
	}
	matches, err := filepath.Glob(filepath.Join(dir, appearanceFile+".*.tmp"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("temporary files left: %v", matches)
	}
}

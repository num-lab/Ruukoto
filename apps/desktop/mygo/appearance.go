package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"fmt"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

const appearanceFile = "desktop-preferences.json"

var appearanceSources = map[string]mygo.ThemeSource{
	"system": mygo.ThemeSystem,
	"light":  mygo.ThemeLight,
	"dark":   mygo.ThemeDark,
}

// Missing, corrupt or unknown values resolve to "system"; a corrupt file is
// reported once so a lost preference cannot disappear silently.
func loadAppearance(dir string) mygo.ThemeSource {
	raw, err := os.ReadFile(filepath.Join(dir, appearanceFile))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			os.Stderr.WriteString(fmt.Sprintf("[ruukoto:desktop] desktop-preferences.json 无法读取（%s），已回退到跟随系统；请检查应用数据目录。\n", err))
		}
		return mygo.ThemeSystem
	}
	var stored struct {
		Appearance string `json:"appearance"`
	}
	if err := json.Unmarshal(raw, &stored); err == nil {
		if source, ok := appearanceSources[stored.Appearance]; ok {
			return source
		}
	}
	os.Stderr.WriteString("[ruukoto:desktop] desktop-preferences.json 无法读取，已回退到跟随系统；请检查应用数据目录。\n")
	return mygo.ThemeSystem
}

func saveAppearance(dir string, source mygo.ThemeSource) error {
	data, err := json.Marshal(map[string]any{"v": 1, "appearance": string(source)})
	if err != nil {
		return err
	}
	target := filepath.Join(dir, appearanceFile)
	temporary, err := os.CreateTemp(dir, appearanceFile+".*.tmp")
	if err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		os.Remove(temporary.Name())
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		os.Remove(temporary.Name())
		return err
	}
	if err := temporary.Close(); err != nil {
		os.Remove(temporary.Name())
		return err
	}
	if err := os.Rename(temporary.Name(), target); err != nil {
		os.Remove(temporary.Name())
		return err
	}
	return nil
}

func appearanceDir() (string, error) {
	return mygo.App.Path(mygo.PathUserData)
}

func (d *Desktop) Appearance(ctx context.Context) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "桌面请求来源不可用；请重新打开应用。")
	}
	dir, err := appearanceDir()
	if err != nil {
		return failure("preferences_unavailable", "failed", "外观记录目录不可用；请重新打开应用。")
	}
	data, _ := json.Marshal(map[string]any{"ok": true, "value": string(loadAppearance(dir))})
	return data
}

func (d *Desktop) SetAppearance(ctx context.Context, value string) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "桌面请求来源不可用；请重新打开应用。")
	}
	source, ok := appearanceSources[value]
	if !ok {
		return failure("invalid_params", "not_sent", "外观取值无效，请重新选择。")
	}
	dir, err := appearanceDir()
	if err != nil {
		return failure("preferences_unavailable", "failed", "外观记录目录不可用；请重新打开应用。")
	}
	if err := saveAppearance(dir, source); err != nil {
		return failure("preferences_write", "failed", fmt.Sprintf("外观记录写入失败：%v", err))
	}
	mygo.Theme.SetSource(source)
	data, _ := json.Marshal(map[string]any{"ok": true, "value": nil})
	return data
}

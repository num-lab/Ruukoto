package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/egoist/mygo"
)

//go:embed preload.js
var preload string

var updates = mygo.NewEvent[json.RawMessage]("desktop:update")

const documentURL = "mygo://localhost/"

type Desktop struct {
	window *mygo.Window
	child  *sidecar
	error  json.RawMessage
}

func (d *Desktop) trusted(ctx context.Context) bool {
	page := mygo.CallerPage(ctx)
	return page != nil && mygo.CallerWindow(ctx) == d.window && page.URL() == documentURL
}

func (d *Desktop) call(ctx context.Context, method string, args ...any) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "桌面请求来源不可用；请重新打开应用。")
	}
	if d.child == nil {
		return d.error
	}
	return d.child.call(ctx, method, args...)
}

func (d *Desktop) Subscribe(ctx context.Context, target string) json.RawMessage {
	return d.call(ctx, "subscribe", target)
}

func (d *Desktop) Request(ctx context.Context, target, op string, params json.RawMessage) json.RawMessage {
	return d.call(ctx, "request", target, op, params)
}

func (d *Desktop) PickFolder(ctx context.Context) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "桌面请求来源不可用；请重新打开应用。")
	}
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: d.window, Directory: true, Title: "选择工作区"})
	if err != nil {
		return failure("dialog_failed", "not_sent", "无法打开文件夹选择器；请重新选择。")
	}
	var folder any
	if len(files) > 0 {
		folder = files[0]
	}
	data, _ := json.Marshal(map[string]any{"ok": true, "value": folder})
	return data
}

func (d *Desktop) PickAttachments(ctx context.Context, sessionID, target string) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "桌面请求来源不可用；请重新打开应用。")
	}
	prepared := d.call(ctx, "attachment_instance", target)
	var selection struct {
		OK       bool   `json:"ok"`
		Instance string `json:"value"`
	}
	if json.Unmarshal(prepared, &selection) != nil || !selection.OK {
		return prepared
	}
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: d.window, Multiple: true, Title: "选择附件"})
	if err != nil {
		return failure("dialog_failed", "not_sent", "无法打开附件选择器；请重新选择。")
	}
	if files == nil {
		files = []string{}
	}
	return d.call(ctx, "attachments", sessionID, files, selection.Instance, target)
}

func (d *Desktop) PickDraftAttachments(ctx context.Context) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "桌面请求来源不可用；请重新打开应用。")
	}
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: d.window, Multiple: true, Title: "选择附件"})
	if err != nil {
		return failure("dialog_failed", "not_sent", "无法打开附件选择器；请重新选择。")
	}
	if files == nil {
		files = []string{}
	}
	return d.call(ctx, "draft_pick", files)
}

func (d *Desktop) UploadDraftAttachments(ctx context.Context, sessionID string, tokens []string, target string) json.RawMessage {
	return d.call(ctx, "draft_upload", sessionID, tokens, target)
}

func (d *Desktop) Reveal(ctx context.Context, path string) json.RawMessage {
	if !d.trusted(ctx) || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		return failure("invalid_path", "not_sent", "请选择有效的本机绝对路径。")
	}
	mygo.Shell.ShowItemInFolder(path)
	return json.RawMessage(`{"ok":true}`)
}

func externalURL(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return u.String()
}

func (d *Desktop) OpenExternal(ctx context.Context, value string) json.RawMessage {
	if !d.trusted(ctx) || externalURL(value) == "" {
		return failure("invalid_url", "not_sent", "请选择有效的 HTTP(S) 链接。")
	}
	if err := mygo.Shell.OpenExternal(value); err != nil {
		return failure("external_failed", "not_sent", "无法打开系统浏览器；请检查默认浏览器设置。")
	}
	return json.RawMessage(`{"ok":true}`)
}

func (d *Desktop) event(data json.RawMessage) {
	var event struct {
		Kind   string          `json:"kind"`
		Notice json.RawMessage `json:"notice"`
		Count  int             `json:"count"`
	}
	if json.Unmarshal(data, &event) != nil {
		return
	}
	switch event.Kind {
	case "update":
		if err := updates.Emit(d.window, data); err != nil {
			os.Stderr.WriteString("[ruukoto:desktop] MyGo 更新未送达窗口；请重新打开应用核实当前状态。\n")
		}
	case "badge":
		mygo.App.SetBadgeCount(event.Count)
	case "notice":
		var notice struct{ Title, Body string }
		if json.Unmarshal(event.Notice, &notice) != nil {
			return
		}
		n := mygo.NewNotification(mygo.NotificationOptions{Title: notice.Title, Body: notice.Body})
		n.OnClick(func() {
			d.window.Show()
			d.window.Focus()
			go d.child.call(context.Background(), "navigate", event.Notice)
		})
		go func() {
			if err := n.Show(); err != nil {
				os.Stderr.WriteString("[ruukoto:desktop] 系统通知未送达；请检查系统通知设置。\n")
			}
		}()
	}
}

func (d *Desktop) ready() {
	d.window = mygo.NewWindow(mygo.WindowOptions{Title: "Ruukoto MyGo", Width: 1160, Height: 780, MinWidth: 760, MinHeight: 500, TitleBarStyle: mygo.TitleBarHiddenInset, Vibrancy: mygo.VibrancySidebar, Page: mygo.PageOptions{PreloadScript: preload}})
	page := d.window.Page()
	page.OnPageTitleUpdated(func(event *mygo.TitleEvent) { event.PreventDefault() })
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	page.OnWillDownload(func(event *mygo.DownloadEvent) { event.PreventDefault() })
	page.OnWillNavigate(func(event *mygo.NavigateEvent) { event.PreventDefault() })
	page.SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
	d.error = failure("node_unavailable", "not_sent", "MyGo 子进程启动失败；请确认构建时的 Node 与仓库仍存在，再运行 npm run desktop:mygo:build。")
	resources, err := mygo.App.Path(mygo.PathResources)
	if err == nil {
		var launch struct{ Node string }
		data, readErr := os.ReadFile(filepath.Join(resources, "launch.json"))
		if readErr == nil && json.Unmarshal(data, &launch) == nil && filepath.IsAbs(launch.Node) {
			userData, pathErr := mygo.App.Path(mygo.PathUserData)
			if pathErr == nil {
				d.child, err = startSidecar(exec.Command(launch.Node, filepath.Join(resources, "sidecar.mjs"), userData), d.event)
			}
		}
	}
	if d.child == nil {
		os.Stderr.WriteString("[ruukoto:desktop] MyGo 子进程启动失败；请确认构建时的 Node 与仓库仍存在后重新构建。\n")
	}
	focus := func(value bool) {
		if d.child != nil {
			go d.child.call(context.Background(), "focus", value)
		}
	}
	d.window.OnFocus(func() { focus(true) })
	d.window.OnBlur(func() { focus(false) })
	focus(d.window.IsFocused())
	if err := page.LoadURL("/"); err != nil {
		os.Stderr.WriteString("[ruukoto:desktop] MyGo 窗口加载失败；请重新构建应用。\n")
		mygo.App.Quit()
	}
}

func main() {
	if userData := os.Getenv("RUUKOTO_DESKTOP_MYGO_USER_DATA"); userData != "" {
		mygo.App.SetPath(mygo.PathUserData, userData)
	}
	desktop := &Desktop{}
	mygo.Bind(desktop)
	var quitting, quitReady atomic.Bool
	mygo.App.OnBeforeQuit(func(event *mygo.QuitEvent) {
		if quitReady.Load() {
			return
		}
		event.PreventDefault()
		if quitting.Swap(true) {
			return
		}
		go func() {
			if desktop.child != nil {
				desktop.child.close()
			}
			quitReady.Store(true)
			mygo.App.Quit()
		}()
	})
	mygo.App.WhenReady(desktop.ready)
	if err := mygo.App.Run(); err != nil {
		os.Stderr.WriteString("[ruukoto:desktop] MyGo 启动失败；请检查 macOS 环境并重新构建。\n")
		os.Exit(1)
	}
}

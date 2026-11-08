package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"ruukoto-desktop-mygo/browser"
)

//go:embed preload.js
var preload string

var updates = mygo.NewEvent[json.RawMessage]("desktop:update")

const documentURL = "mygo://localhost/"

type Desktop struct {
	window         *mygo.Window
	frontend       *mygo.WebView
	browser        *browser.Manager
	browserTail    <-chan struct{} // Main-thread event order, including rapid takeover/return.
	child          *sidecar
	error          json.RawMessage
	instanceLock   *os.File
	failed         bool
	outputPreviews outputPreviews
}

// Note: See .agents/notes/implemented/feature/2026-10-29-mygo-agent-browser.md
// A trusted caller must match the front-end Page object, the host window and the exact front-end URL:
// another WebView at the same URL can't impersonate the front end.
func (d *Desktop) trusted(ctx context.Context) bool {
	page := mygo.CallerPage(ctx)
	return page != nil && d.frontend != nil && page == d.frontend.Page() && mygo.CallerWindow(ctx) == d.window && page.URL() == documentURL
}

func (d *Desktop) call(ctx context.Context, method string, args ...any) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "The desktop request source is unavailable; reopen the app.")
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
		return failure("ipc_sender", "not_sent", "The desktop request source is unavailable; reopen the app.")
	}
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: d.window, Directory: true, Title: "Choose workspace"})
	if err != nil {
		return failure("dialog_failed", "not_sent", "Couldn't open the folder picker; choose again.")
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
		return failure("ipc_sender", "not_sent", "The desktop request source is unavailable; reopen the app.")
	}
	prepared := d.call(ctx, "attachment_instance", target, sessionID)
	var selection struct {
		OK       bool   `json:"ok"`
		Instance string `json:"value"`
	}
	if json.Unmarshal(prepared, &selection) != nil || !selection.OK {
		return prepared
	}
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: d.window, Multiple: true, Title: "Choose attachments"})
	if err != nil {
		if target == "personal" {
			d.call(ctx, "attachments", sessionID, []string{}, selection.Instance, target)
		}
		return failure("dialog_failed", "not_sent", "Couldn't open the attachment picker; choose again.")
	}
	if files == nil {
		files = []string{}
	}
	return d.call(ctx, "attachments", sessionID, files, selection.Instance, target)
}

func (d *Desktop) PickDraftAttachments(ctx context.Context) json.RawMessage {
	if !d.trusted(ctx) {
		return failure("ipc_sender", "not_sent", "The desktop request source is unavailable; reopen the app.")
	}
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: d.window, Multiple: true, Title: "Choose attachments"})
	if err != nil {
		return failure("dialog_failed", "not_sent", "Couldn't open the attachment picker; choose again.")
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
		return failure("invalid_path", "not_sent", "Choose a valid local absolute path.")
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
		return failure("invalid_url", "not_sent", "Choose a valid HTTP(S) link.")
	}
	if err := mygo.Shell.OpenExternal(value); err != nil {
		return failure("external_failed", "not_sent", "Couldn't open the system browser; check the default browser settings.")
	}
	return json.RawMessage(`{"ok":true}`)
}

// browserRequest captures the browser transport before asynchronous dispatch.
func (d *Desktop) browserRequest(method string, args json.RawMessage) func() json.RawMessage {
	if strings.HasPrefix(method, "output_") {
		return func() json.RawMessage { return d.outputRequest(method, args) }
	}
	if method != "browser_command" || d.browser == nil {
		return func() json.RawMessage { return failure("unknown_method", "not_sent", "未知的子进程请求。") }
	}
	var raw []json.RawMessage
	var call struct {
		Op string `json:"op"`
		browser.CommandIn
	}
	if json.Unmarshal(args, &raw) != nil || len(raw) != 1 || json.Unmarshal(raw[0], &call) != nil || call.Op == "" {
		return func() json.RawMessage {
			return failure("invalid_params", "not_sent", "浏览器命令缺少操作或输入。")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	run := d.browser.Prepare(ctx, call.Op, call.CommandIn)
	return func() json.RawMessage { defer cancel(); return run() }
}

func (d *Desktop) outputRequest(method string, args json.RawMessage) json.RawMessage {
	if strings.HasPrefix(method, "output_") {
		var raw []json.RawMessage
		if json.Unmarshal(args, &raw) != nil {
			return failure("invalid_params", "not_sent", "Invalid file-window parameters.")
		}
		switch method {
		case "output_choose":
			var name string
			if len(raw) != 1 || json.Unmarshal(raw[0], &name) != nil || !outputName(name) {
				return failure("invalid_params", "not_sent", "Invalid final file name.")
			}
			destination, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: d.window, Title: "Save final file", DefaultPath: name, CreateDirectories: true})
			if err != nil {
				return failure("personal_output_dialog", "not_sent", "The save dialog couldn't open; choose again.")
			}
			if destination == "" {
				return outputValue(nil)
			}
			return outputValue(destination)
		case "output_preview":
			var filename, name string
			if len(raw) != 2 || json.Unmarshal(raw[0], &filename) != nil || json.Unmarshal(raw[1], &name) != nil {
				return failure("invalid_params", "not_sent", "Invalid file-preview parameters.")
			}
			id, err := d.outputPreviews.open(filename, name)
			if err != nil {
				return failure("personal_output_preview", "not_sent", "The file preview couldn't open; download the original file again.")
			}
			return outputValue(id)
		case "output_close_preview":
			var id uint64
			if len(raw) != 1 || json.Unmarshal(raw[0], &id) != nil || id == 0 {
				return failure("invalid_params", "not_sent", "The original preview identity is invalid.")
			}
			if err := d.outputPreviews.stop(id); err != nil {
				return failure("personal_output_stop", "unknown", "The original file preview's stop is unverified; close the preview window.")
			}
			return outputValue(nil)
		default:
			return failure("unknown_method", "not_sent", "Unknown file-window operation.")
		}
	}
	return failure("unknown_method", "not_sent", "Unknown file-window operation.")
}

// browserEvent reports page facts to the subprocess; the gate already took effect natively, so delivery failure only logs a diagnostic.
func (d *Desktop) browserEvent(e browser.Event) {
	if d.child == nil {
		return
	}
	previous, done := d.browserTail, make(chan struct{})
	d.browserTail = done
	go func() {
		defer close(done)
		if previous != nil {
			<-previous
		}
		res := d.child.call(context.Background(), "browser_event", e)
		var v struct {
			OK bool `json:"ok"`
		}
		if json.Unmarshal(res, &v) != nil || !v.OK {
			os.Stderr.WriteString("[ruukoto:desktop] Browser event not delivered to the subprocess; check the backend session state.\n")
		}
	}()
}

func (d *Desktop) event(data json.RawMessage) {
	var event struct {
		Kind   string `json:"kind"`
		Target string `json:"target"`
		Update struct {
			Type  string `json:"type"`
			State string `json:"state"`
		} `json:"update"`
		Notice json.RawMessage `json:"notice"`
		Count  int             `json:"count"`
	}
	if json.Unmarshal(data, &event) != nil {
		return
	}
	switch event.Kind {
	case "update":
		if event.Target == "code" && event.Update.Type == "state" && event.Update.State != "online" && d.browser != nil {
			d.browser.ReleaseAll()
		}
		if d.frontend == nil {
			return
		}
		if err := updates.EmitPage(d.frontend.Page(), data); err != nil {
			os.Stderr.WriteString("[ruukoto:desktop] MyGo update not delivered to the window; reopen the app to verify the current state.\n")
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
				os.Stderr.WriteString("[ruukoto:desktop] System notification not delivered; check system notification settings.\n")
			}
		}()
	}
}

// The frontend fills the window; browser pages overlay their reported rectangles.
func (d *Desktop) view(c *ui.Context) {
	if c.Vibrancy() {
		c.Root().Background(ui.Transparent)
	}
	ui.Column(c).Fill().Children(func() {
		if d.frontend != nil {
			ui.WebView(c, d.frontend).Fill()
		}
		if d.browser != nil {
			d.browser.View(c)
		}
	})
}

func (d *Desktop) ready() {
	// Applied before the window so the vibrancy material and the page's
	// prefers-color-scheme already match the saved preference on first paint.
	if dir, err := appearanceDir(); err == nil {
		mygo.Theme.SetSource(loadAppearance(dir))
	} else {
		os.Stderr.WriteString("[ruukoto:desktop] Couldn't locate the preferences directory; appearance follows system.\n")
	}
	d.window = mygo.NewWindow(mygo.WindowOptions{Title: "Ruukoto MyGo", Width: 1160, Height: 780, MinWidth: 760, MinHeight: 500, TitleBarStyle: mygo.TitleBarHiddenInset, TrafficLightPosition: &mygo.Point{X: 18, Y: 17}, Vibrancy: mygo.VibrancySidebar, Content: ui.View(d.view)})
	frontend, err := d.window.NewWebView(mygo.WebViewOptions{URL: "/", Transparent: true, Page: mygo.PageOptions{PreloadScript: preload}})
	if err != nil {
		os.Stderr.WriteString("[ruukoto:desktop] MyGo front-end view creation failed; rebuild the app.\n")
		d.failed = true
		mygo.App.Quit()
		return
	}
	d.frontend = frontend
	page := frontend.Page()
	page.OnRenderProcessGone(func(string) {
		if d.child != nil {
			go d.child.call(context.Background(), "terminal_reset")
		}
	})
	page.OnPageTitleUpdated(func(event *mygo.TitleEvent) { event.PreventDefault() })
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	page.OnWillDownload(func(event *mygo.DownloadEvent) { event.PreventDefault() })
	page.OnWillNavigate(func(event *mygo.NavigateEvent) { event.PreventDefault() })
	page.SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
	d.error = failure("node_unavailable", "not_sent", "The MyGo subprocess failed to start; make sure the build-time Node and repo still exist, then run npm run desktop:mygo:build.")
	resources, err := mygo.App.Path(mygo.PathResources)
	if err == nil {
		executable, executableErr := os.Executable()
		userData, pathErr := mygo.App.Path(mygo.PathUserData)
		if executableErr == nil && pathErr == nil {
			command, namespace, verifyErr := trustedSidecar(executable, resources, userData, os.Environ())
			if verifyErr == nil {
				d.instanceLock, err = acquireInstanceLock(command.Args[len(command.Args)-1])
				if err != nil {
					os.Stderr.WriteString("[ruukoto:desktop] This installation is already running or the private instance lock is unavailable; close the original app and try again.\n")
					d.failed = true
					mygo.App.Quit()
					return
				}
				credentials, credentialErr := newNativeCredentials(namespace)
				if credentialErr == nil {
					d.child, err = startSidecar(command, d.event, d.browserRequest, credentials)
					if err == nil {
						d.child.mu.Lock()
						d.child.onFail = func() {
							d.browser.ReleaseAll()
							if err := d.outputPreviews.stop(0); err != nil {
								os.Stderr.WriteString("[ruukoto:desktop] Failed to stop the original file preview; close its window.\n")
							}
						}
						d.child.mu.Unlock()
					}
				}
			} else {
				d.error = failure("desktop_integrity", "not_sent", "App signature, resource or pinned-Node verification failed; rebuild the app.")
			}
		}
	}
	if d.child == nil {
		d.failed = true
		os.Stderr.WriteString("[ruukoto:desktop] The MyGo subprocess failed to start; confirm the build-time Node and repo still exist and rebuild.\n")
	}
	focus := func(value bool) {
		if d.child != nil {
			go d.child.call(context.Background(), "focus", value)
		}
	}
	d.window.OnFocus(func() { focus(true) })
	d.window.OnBlur(func() { focus(false) })
	focus(d.window.IsFocused())
	d.window.Invalidate()
}

func runDesktop() int {
	if len(os.Args) != 1 || os.Getenv("RUUKOTO_DESKTOP_MYGO_USER_DATA") != "" || os.Getenv("RUUKOTO_DESKTOP_MANAGED") != "" {
		os.Stderr.WriteString("[ruukoto:desktop] The production app doesn't accept dev paths or launch arguments; reopen it from the app directory.\n")
		return 1
	}
	desktop := &Desktop{}
	desktop.browser = browser.New(browser.Deps{
		Identity:   desktop.trusted,
		Update:     func(fn func()) { desktop.window.Update(fn) },
		Invalidate: func() { desktop.window.Invalidate() },
		Focus: func() {
			if desktop.frontend != nil {
				desktop.frontend.Focus()
			}
		},
		NewView: func(o mygo.WebViewOptions) (*mygo.WebView, error) { return desktop.window.NewWebView(o) },
		Content: func() (float32, float32) {
			w, h := desktop.window.ContentSize()
			return float32(w), float32(h)
		},
		Emit:  desktop.browserEvent,
		Alive: func() bool { return desktop.window != nil && !desktop.window.IsDestroyed() },
	})
	defer func() {
		if err := desktop.outputPreviews.stop(0); err != nil {
			os.Stderr.WriteString("[ruukoto:desktop] Failed to stop the original file preview; close its window.\n")
		}
		if desktop.child != nil {
			desktop.child.close()
		}
		if desktop.instanceLock != nil {
			desktop.instanceLock.Close()
		}
	}()
	mygo.Bind(desktop)
	mygo.BindAs("Browser", desktop.browser.Frontend())
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
		os.Stderr.WriteString("[ruukoto:desktop] MyGo launch failed; check the macOS environment and rebuild.\n")
		return 1
	}
	if desktop.failed {
		return 1
	}
	return 0
}

func main() { os.Exit(runDesktop()) }

//go:build darwin

// MyGo 右栏浏览器原生探针：工单 01-integrate-browser 步骤 1 的隔离 fixture。
// 一个 Content 窗口内放前端 WebView 与两个浏览器 WebView，自驱动执行编号检查并写 JSON 报告。
// 浏览器页面只经 http(s) 加载，不安装应用 preload、不授予 TrustedOrigins。
// Note: 见 .agents/notes/proposed/feature/2026-10-29-mygo-agent-browser.md
package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

//go:embed web
var webFS embed.FS

var markEvent = mygo.NewEvent[map[string]any]("probe:mark")

// a 是包级探针实例，供普通探针与宿主探针（hostprobe.go）两条驱动线共用。
var a *app

// rect 是前端上报的浏览器页占位矩形，CSS px（= DIP），相对窗口内容区。
type rect struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	W float32 `json:"w"`
	H float32 `json:"h"`
}

type app struct {
	win      *mygo.Window
	frontend *mygo.WebView
	browsers map[string]*mygo.WebView
	base     string

	reportPath string
	shotsDir   string
	keep       bool
	persist    bool
	host       bool

	// 视图状态只在主线程读写：绑定方法与 runner 经 win.Update 变更。
	shown string
	rect  rect
	modal bool

	readyCh chan struct{}
	rectCh  chan rect

	secretCalls  atomic.Int64
	secretDenied atomic.Int64
	rectRejects  atomic.Int64
	markReports  atomic.Int64

	exitCode atomic.Int32
}

// Probe 模拟宿主受信服务：前端 Page 对象、宿主窗口与精确前端 URL 三者同时匹配才放行。
type Probe struct{ a *app }

func (p *Probe) identity(ctx context.Context) bool {
	pg := mygo.CallerPage(ctx)
	return pg != nil && pg == p.a.frontend.Page() && mygo.CallerWindow(ctx) == p.a.win && pg.URL() == "mygo://localhost/"
}

func (p *Probe) SetRect(ctx context.Context, r rect) map[string]any {
	if !p.identity(ctx) {
		p.a.rectRejects.Add(1)
		return map[string]any{"ok": false, "reason": "page-identity"}
	}
	p.a.win.Update(func() { p.a.rect = r })
	select {
	case p.a.rectCh <- r:
	default:
	}
	return map[string]any{"ok": true}
}

func (p *Probe) Report(ctx context.Context, kind string, data any) map[string]any {
	if !p.identity(ctx) {
		return map[string]any{"ok": false, "reason": "page-identity"}
	}
	if kind == "mark" {
		p.a.markReports.Add(1)
	}
	return map[string]any{"ok": true}
}

// Secret 是金丝雀方法：任何非前端页面的调用都必须被页身份拒绝。
func (p *Probe) Secret(ctx context.Context) map[string]any {
	p.a.secretCalls.Add(1)
	if !p.identity(ctx) {
		p.a.secretDenied.Add(1)
		return map[string]any{"ok": false, "reason": "page-identity"}
	}
	return map[string]any{"ok": true}
}

func (a *app) view(c *ui.Context) {
	ui.Column(c).Fill().Children(func() {
		ui.WebView(c, a.frontend).Fill()
		if v := a.browsers[a.shown]; v != nil && a.rect.W > 0 && a.rect.H > 0 {
			r := a.rect
			ui.WebView(c, v).Absolute().Left(r.X).Top(r.Y).Width(r.W).Height(r.H)
		}
	})
	ui.Modal(c, &a.modal, func() {
		ui.Text(c, "探针模态：原生绘制的遮挡层")
	})
}

func (a *app) ready() {
	a.win = mygo.NewWindow(mygo.WindowOptions{
		Title: "MyGo 浏览器探针", Width: 1100, Height: 720,
		Content: ui.View(a.view),
	})
	fe, err := a.win.NewWebView(mygo.WebViewOptions{URL: "/"})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[probe] 前端 WebView 创建失败: %v\n", err)
		mygo.App.Quit()
		return
	}
	a.frontend = fe
	var once sync.Once
	a.frontend.Page().OnDOMReady(func() { once.Do(func() { close(a.readyCh) }) })
	a.frontend.Page().OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
	for name, path := range map[string]string{"a": "/counter", "b": "/form"} {
		v, err := a.win.NewWebView(mygo.WebViewOptions{URL: a.base + path})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[probe] 浏览器 WebView %s 创建失败: %v\n", name, err)
			continue
		}
		a.browsers[name] = v
		pg := v.Page()
		pg.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
		pg.SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
		pg.OnWillDownload(func(e *mygo.DownloadEvent) { e.PreventDefault() })
		pg.OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
	}
	if a.keep {
		a.win.OnClosed(func() { mygo.App.Quit() })
	}
	a.win.Invalidate()
	go a.run()
}

func main() {
	reportPath := flag.String("report", "probe-report.json", "检查报告输出路径")
	shots := flag.String("shots", "", "截图保存目录")
	keep := flag.Bool("keep", false, "检查完成后保留窗口供人工项核验")
	persist := flag.Bool("persist", false, "只做跨启动持久 Cookie 检查后退出")
	host := flag.Bool("host", false, "跑步骤 2 宿主探针（生产 browser.Manager）")
	timeout := flag.Duration("timeout", 4*time.Minute, "看门狗超时")
	flag.Parse()

	a = &app{
		browsers:   map[string]*mygo.WebView{},
		reportPath: *reportPath,
		shotsDir:   *shots,
		keep:       *keep,
		persist:    *persist,
		host:       *host,
		readyCh:    make(chan struct{}),
		rectCh:     make(chan rect, 64),
	}
	base, err := fixtureServer(webFS)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[probe] fixture 服务启动失败: %v\n", err)
		os.Exit(1)
	}
	a.base = base
	frontendDir := "web/frontend"
	if a.host {
		frontendDir = "web/host"
	}
	frontend, err := fs.Sub(webFS, frontendDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[probe] 前端资源缺失: %v\n", err)
		os.Exit(1)
	}
	mygo.SetFrontend(frontend)
	readyCh := make(chan struct{})
	if a.host {
		h := &hostApp{}
		mygo.App.WhenReady(func() { h.ready(readyCh) })
		time.AfterFunc(*timeout, func() {
			fmt.Fprintln(os.Stderr, "[host] 看门狗超时，退出")
			os.Exit(2)
		})
		go h.runHost(readyCh, strings.TrimSuffix(a.reportPath, ".json")+"-host.json")
	} else {
		mygo.Bind(&Probe{a})
		mygo.App.WhenReady(a.ready)
	}
	time.AfterFunc(*timeout, func() {
		fmt.Fprintln(os.Stderr, "[probe] 看门狗超时，退出")
		os.Exit(2)
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "[probe] MyGo 启动失败: %v\n", err)
		os.Exit(1)
	}
	os.Exit(int(a.exitCode.Load()))
}

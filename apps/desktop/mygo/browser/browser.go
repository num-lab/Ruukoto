// Package browser 是 MyGo 右栏浏览器页面宿主：每主会话一个独立 WebView。
// 可信前端上报占位矩形、可见性与遮挡，原生按矩形放置当前会话页；
// owned=true 表示 Agent 持有页面，原生盖挡住人工输入，交还/接管由可信前端发起。
// Note: 见 .agents/notes/proposed/feature/2026-10-29-mygo-agent-browser.md
package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// Rect 是前端上报的浏览器占位矩形，CSS px（= DIP），相对窗口内容区左上。
type Rect struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	W float32 `json:"w"`
	H float32 `json:"h"`
}

// State 是前端上报的展示状态：展示的会话、右栏是否展示浏览器占位、是否被弹层遮挡。
type State struct {
	Session string `json:"session"`
	Shown   bool   `json:"shown"`
	Covered bool   `json:"covered"`
}

// Event 是页面事实上报：闸门翻转、导航、标题、渲染失效与关闭。
type Event struct {
	Session    string `json:"session"`
	Kind       string `json:"kind"` // gate | nav | title | gone | closed
	URL        string `json:"url,omitempty"`
	Title      string `json:"title,omitempty"`
	Owned      *bool  `json:"owned,omitempty"`
	Source     string `json:"source,omitempty"` // owner = 可信前端按钮，host = 后台命令
	Generation uint64 `json:"generation"`
}

// Deps 注入宿主能力，全部允许跨窗口生命周期晚绑定（闭包在调用时求值）。
type Deps struct {
	Identity   func(context.Context) bool                       // 可信前端判定：前端 Page 对象、宿主窗口与精确 URL
	Update     func(func())                                     // = Window.Update：主线程改状态并触发重绘
	Invalidate func()                                           // = Window.Invalidate：请求一帧
	Focus      func()                                           // 把键盘收回前端页
	NewView    func(mygo.WebViewOptions) (*mygo.WebView, error) // = Window.NewWebView，仅主线程
	Content    func() (float32, float32)                        // 内容区 DIP 尺寸，矩形钳制
	Emit       func(Event)                                      // 页面事实上报（sidecar）
	Alive      func() bool                                      // 窗口存活
}

// handle 抽象页面对象的可调用面，便于脱离原生窗口的单测。
type handle interface {
	load(url string) error
	eval(ctx context.Context, code string) (any, error)
	shot() ([]byte, error)
	back()
	forward()
	reload()
	destroy()
}

type liveHandle struct{ v *mygo.WebView }

func (l liveHandle) load(u string) error { return l.v.Page().LoadURL(u) }
func (l liveHandle) eval(ctx context.Context, c string) (any, error) {
	return l.v.Page().EvalContext(ctx, c)
}
func (l liveHandle) shot() ([]byte, error) { return l.v.CapturePage() }
func (l liveHandle) back()                 { l.v.Page().GoBack() }
func (l liveHandle) forward()              { l.v.Page().GoForward() }
func (l liveHandle) reload()               { l.v.Page().Reload() }
func (l liveHandle) destroy()              { l.v.Destroy() }

type page struct {
	session string
	view    *mygo.WebView // 单测中为 nil
	handle  handle

	gen   atomic.Uint64 // 每次导航请求/提交、闸门翻转、页销毁均推进；动作按代次拒绝
	owned atomic.Bool   // true = Agent 持有：原生盖遮挡人工输入
	gone  atomic.Bool   // 渲染进程消失或页已销毁

	infoMu     sync.RWMutex
	url, title string
}

// Manager 持有页面池、展示状态与闸门。绑定方法、页回调与 View 运行在主线程，
// 直接读写视图字段；Command 与 ReleaseAll 由非主线程调用，经 Update 进主线程。
type Manager struct {
	deps Deps

	// newHandle 只由同包测试替换，把页面适配换成 fake。
	newHandle func(*mygo.WebView) handle

	mu    sync.RWMutex
	pages map[string]*page

	shown      string
	panelShown bool
	covered    bool
	rect       Rect
}

func New(deps Deps) *Manager {
	return &Manager{deps: deps, pages: map[string]*page{}}
}

// Frontend 返回只含可信前端方法的绑定对象；Manager 自身不绑定。
func (m *Manager) Frontend() *Frontend { return &Frontend{m: m} }

func failure(code, outcome, message string) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]string{"code": code, "outcome": outcome, "message": message}})
	return data
}

func succeed(value any) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"ok": true, "value": value})
	return data
}

func (m *Manager) emit(e Event) {
	if m.deps.Emit != nil {
		m.deps.Emit(e)
	}
}

func (m *Manager) pageOf(session string) *page {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.pages[session]
}

// placedPage 返回当前应放置的页面；主线程。
func (m *Manager) placedPage() *page {
	if !m.panelShown || m.covered || m.shown == "" || m.rect.W < 1 || m.rect.H < 1 {
		return nil
	}
	return m.pageOf(m.shown)
}

// View 构建浏览器部分的原生视图：页面按上报矩形放置，Agent 持有时加透明输入盖。
// 指针命中测试把盖之后的内容判为覆盖，事件落到原生层而不进页面。
func (m *Manager) View(c *ui.Context) {
	p := m.placedPage()
	if p == nil || p.view == nil {
		return
	}
	r := m.rect
	ui.WebView(c, p.view).Absolute().Left(r.X).Top(r.Y).Width(r.W).Height(r.H)
	if p.owned.Load() {
		ui.Box(c).Absolute().Left(r.X).Top(r.Y).Width(r.W).Height(r.H)
	}
}

func finiteRect(r Rect) bool {
	return !(math.IsNaN(float64(r.X)) || math.IsNaN(float64(r.Y)) || math.IsNaN(float64(r.W)) || math.IsNaN(float64(r.H)) ||
		math.IsInf(float64(r.X), 0) || math.IsInf(float64(r.Y), 0) || math.IsInf(float64(r.W), 0) || math.IsInf(float64(r.H), 0))
}

// clampRect 把上报矩形钳制进内容区；越界部分裁掉，退化时返回空矩形（不放置）。
func clampRect(r Rect, cw, ch float32) Rect {
	x := min(max(r.X, 0), cw)
	y := min(max(r.Y, 0), ch)
	w := min(max(r.W, 0), cw-x)
	h := min(max(r.H, 0), ch-y)
	return Rect{X: x, Y: y, W: w, H: h}
}

var errBadURL = errors.New("无效的 HTTP(S) 地址")

// validURL 限定导航目标为无凭据的 http(s)，与应用协议、file 等其余方案隔离。
func validURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errBadURL
	}
	return u.String(), nil
}

// ensurePage 创建或返回会话页面；仅主线程（绑定方法与 Update 闭包内）。
func (m *Manager) ensurePage(session string) (*page, error) {
	if p := m.pageOf(session); p != nil {
		return p, nil
	}
	v, err := m.deps.NewView(mygo.WebViewOptions{})
	if err != nil {
		return nil, err
	}
	h := handle(liveHandle{v})
	if m.newHandle != nil {
		h = m.newHandle(v)
	}
	p := &page{session: session, view: v, handle: h}
	m.mu.Lock()
	m.pages[session] = p
	m.mu.Unlock()
	if v != nil {
		m.bindPage(p, v.Page())
	}
	return p, nil
}

// bindPage 给浏览器页装上锁定的处理器：权限/弹窗/下载全拒，非 HTTP(S) 导航拦截。
func (m *Manager) bindPage(p *page, pg *mygo.Page) {
	pg.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	pg.SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
	pg.OnWillDownload(func(e *mygo.DownloadEvent) { e.PreventDefault() })
	pg.OnPageTitleUpdated(func(e *mygo.TitleEvent) {
		e.PreventDefault()
		m.titleUpdated(p, e.Title)
	})
	pg.OnWillNavigate(func(e *mygo.NavigateEvent) {
		if _, err := validURL(e.URL); err != nil {
			e.PreventDefault()
		}
	})
	pg.OnDidNavigate(func(u string) { m.didNavigate(p, u) })
	pg.OnRenderProcessGone(func(string) { m.renderGone(p) })
}

func (m *Manager) didNavigate(p *page, u string) {
	gen := p.gen.Add(1)
	p.infoMu.Lock()
	p.url = u
	p.infoMu.Unlock()
	m.emit(Event{Session: p.session, Kind: "nav", URL: u, Generation: gen})
}

func (m *Manager) titleUpdated(p *page, title string) {
	p.infoMu.Lock()
	p.title = title
	p.infoMu.Unlock()
	m.emit(Event{Session: p.session, Kind: "title", Title: title, Generation: p.gen.Load()})
}

func (m *Manager) renderGone(p *page) {
	p.gone.Store(true)
	gen := p.gen.Add(1)
	m.emit(Event{Session: p.session, Kind: "gone", Generation: gen})
}

// closePage 销毁会话页并解除展示；仅主线程。关闭始终允许，不查闸门。
func (m *Manager) closePage(session string) bool {
	m.mu.Lock()
	p := m.pages[session]
	delete(m.pages, session)
	m.mu.Unlock()
	if p == nil {
		return false
	}
	p.gone.Store(true)
	gen := p.gen.Add(1)
	if m.shown == session {
		m.shown = ""
	}
	p.handle.destroy()
	m.emit(Event{Session: session, Kind: "closed", Generation: gen})
	m.deps.Invalidate()
	return true
}

// setOwned 主线程翻转闸门并推进代次；Agent 持有时把键盘收回前端。
func (m *Manager) setOwned(p *page, owned bool, source string) {
	if !p.owned.CompareAndSwap(!owned, owned) {
		return
	}
	gen := p.gen.Add(1)
	if owned && m.placedPage() == p {
		m.deps.Focus()
	}
	m.emit(Event{Session: p.session, Kind: "gate", Owned: &owned, Source: source, Generation: gen})
	m.deps.Invalidate()
}

func (m *Manager) snapshot(p *page) map[string]any {
	p.infoMu.RLock()
	defer p.infoMu.RUnlock()
	return map[string]any{
		"exists": true, "url": p.url, "title": p.title,
		"generation": p.gen.Load(), "owned": p.owned.Load(), "gone": p.gone.Load(),
	}
}

// check 校验后台动作前置：页在、渲染存活、持有权与代次吻合；gen=0 表示不绑代次。
func check(p *page, gen uint64, needOwned bool) (code, message string) {
	switch {
	case p == nil:
		return "no_page", "该会话没有浏览器页面。"
	case p.gone.Load():
		return "page_gone", "页面渲染已失效；请重新打开。"
	case needOwned && !p.owned.Load():
		return "not_owned", "页面未由 Agent 持有。"
	case gen != 0 && gen != p.gen.Load():
		return "stale_generation", "页面代次已过期，请重新观察。"
	}
	return "", ""
}

// ReleaseAll 在传输失效后放开全部页面的人工输入并推进代次；迟到命令按代次拒绝。
// 非主线程调用。
func (m *Manager) ReleaseAll() {
	m.mu.RLock()
	var owned []*page
	for _, p := range m.pages {
		if p.owned.Load() {
			owned = append(owned, p)
		}
	}
	m.mu.RUnlock()
	if len(owned) == 0 {
		return
	}
	m.deps.Update(func() {
		for _, p := range owned {
			if p.owned.CompareAndSwap(true, false) {
				p.gen.Add(1)
			}
		}
	})
}

// CommandIn 是后台经控制通路转发的浏览器命令参数；传输由后续步骤接通。
type CommandIn struct {
	Session    string `json:"session"`
	Generation uint64 `json:"generation,omitempty"`
	URL        string `json:"url,omitempty"`
	Script     string `json:"script,omitempty"`
}

// Command 执行后台浏览器命令；只允许在窗口存活的非主线程上下文调用，
// 变更类操作经 Update 入主线程，读类操作（eval/screenshot/status）原地执行。
func (m *Manager) Command(ctx context.Context, op string, in CommandIn) json.RawMessage {
	if m.deps.Alive != nil && !m.deps.Alive() {
		return failure("window_closed", "not_sent", "桌面窗口已关闭。")
	}
	p := m.pageOf(in.Session)
	switch op {
	case "status":
		if p == nil {
			return succeed(map[string]any{"exists": false})
		}
		return succeed(m.snapshot(p))
	case "open":
		return m.syncMain(ctx, func() json.RawMessage {
			return m.open(in.Session, in.URL)
		})
	case "navigate":
		url, err := validURL(in.URL)
		if err != nil {
			return failure("invalid_url", "not_sent", "导航目标必须是 HTTP(S) 地址。")
		}
		return m.syncMain(ctx, func() json.RawMessage {
			// 与绑定方法同线程复核持有权与代次，压缩检查到发出的窗口。
			if code, msg := check(p, in.Generation, true); code != "" {
				return failure(code, "not_sent", msg)
			}
			p.gen.Add(1)
			if err := p.handle.load(url); err != nil {
				return failure("navigate_failed", "not_sent", err.Error())
			}
			return succeed(m.snapshot(p))
		})
	case "eval":
		if code, msg := check(p, in.Generation, true); code != "" {
			return failure(code, "not_sent", msg)
		}
		v, err := p.handle.eval(ctx, in.Script)
		if err != nil {
			return failure("eval_failed", "unknown", err.Error())
		}
		return succeed(map[string]any{"value": v, "generation": p.gen.Load()})
	case "screenshot":
		if code, msg := check(p, in.Generation, true); code != "" {
			return failure(code, "not_sent", msg)
		}
		png, err := p.handle.shot()
		if err != nil {
			return failure("capture_failed", "unknown", err.Error())
		}
		return succeed(map[string]any{"png": base64.StdEncoding.EncodeToString(png), "generation": p.gen.Load()})
	case "own":
		return m.syncMain(ctx, func() json.RawMessage {
			if p == nil {
				return failure("no_page", "not_sent", "该会话没有浏览器页面。")
			}
			m.setOwned(p, true, "host")
			return succeed(m.snapshot(p))
		})
	case "release":
		if p == nil {
			return succeed(map[string]any{"released": false})
		}
		return m.syncMain(ctx, func() json.RawMessage {
			m.setOwned(p, false, "host")
			return succeed(m.snapshot(p))
		})
	case "close":
		return m.syncMain(ctx, func() json.RawMessage {
			return succeed(map[string]any{"closed": m.closePage(in.Session)})
		})
	}
	return failure("unknown_op", "not_sent", "未知的浏览器命令。")
}

func (m *Manager) syncMain(ctx context.Context, fn func() json.RawMessage) json.RawMessage {
	done := make(chan json.RawMessage, 1)
	m.deps.Update(func() { done <- fn() })
	select {
	case r := <-done:
		return r
	case <-ctx.Done():
		return failure("window_busy", "unknown", "桌面窗口未应答；请核实原操作。")
	}
}

// open 建立或复用会话页，授予 Agent 持有并导航；主线程。
func (m *Manager) open(session, rawURL string) json.RawMessage {
	p, err := m.ensurePage(session)
	if err != nil {
		return failure("open_failed", "not_sent", err.Error())
	}
	m.setOwned(p, true, "host")
	if rawURL == "" {
		return succeed(m.snapshot(p))
	}
	url, err := validURL(rawURL)
	if err != nil {
		return failure("invalid_url", "not_sent", "导航目标必须是 HTTP(S) 地址。")
	}
	p.gen.Add(1)
	if err := p.handle.load(url); err != nil {
		return failure("navigate_failed", "not_sent", err.Error())
	}
	return succeed(m.snapshot(p))
}

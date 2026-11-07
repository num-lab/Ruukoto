// Package browser 是 MyGo 右栏浏览器页面宿主：每主会话一个独立 WebView。
// 可信前端上报占位矩形、可见性与遮挡，原生按矩形放置当前会话页；
// owned=true 表示 Agent 持有页面，原生盖挡住人工输入，交还/接管由可信前端发起。
// Note: 见 .agents/notes/implemented/feature/2026-10-29-mygo-agent-browser.md
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
	Session          string `json:"session"`
	Kind             string `json:"kind"` // gate | nav | title | gone | closed
	URL              string `json:"url,omitempty"`
	Title            string `json:"title,omitempty"`
	Owned            *bool  `json:"owned,omitempty"`
	OwnerHeld        *bool  `json:"ownerHeld,omitempty"`
	ReturnGeneration uint64 `json:"returnGeneration"`
	Source           string `json:"source,omitempty"` // owner = 可信前端按钮，host = 后台命令
	Generation       uint64 `json:"generation"`
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

	gen       atomic.Uint64 // 每次导航请求/提交、闸门翻转、页销毁均推进；动作按代次拒绝
	returned  atomic.Uint64 // Latest explicit return requiring an Agent observation.
	owned     atomic.Bool   // true = Agent 持有：原生盖遮挡人工输入
	ownerHeld atomic.Bool   // An explicit takeover blocks Agent acquisition until return.
	gone      atomic.Bool   // 渲染进程消失或页已销毁
	task      atomic.Value  // Task ID of the current Agent claim.

	infoMu     sync.RWMutex
	url, title string
}

// Manager 持有页面池、展示状态与闸门。绑定方法、页回调与 View 运行在主线程，
// 直接读写视图字段；Command 与 ReleaseAll 由非主线程调用，经 Update 进主线程。
type Manager struct {
	deps Deps

	// newHandle 只由同包测试替换，把页面适配换成 fake。
	newHandle func(*mygo.WebView) handle

	mu            sync.RWMutex
	pages         map[string]*page
	generation    atomic.Uint64
	transport     atomic.Uint64
	releasedTasks map[string]bool // Fences commands whose response outlived task cleanup.

	shown      string
	panelShown bool
	covered    bool
	rect       Rect
}

func New(deps Deps) *Manager {
	return &Manager{deps: deps, pages: map[string]*page{}, releasedTasks: map[string]bool{}}
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
		// Every event carries ownership so a newer navigation can subsume an older gate.
		owned, held := false, false
		if p := m.pageOf(e.Session); p != nil && !p.gone.Load() {
			owned, held = p.owned.Load(), p.ownerHeld.Load()
			e.ReturnGeneration = p.returned.Load()
		}
		e.Owned, e.OwnerHeld = &owned, &held
		m.deps.Emit(e)
	}
}

func (m *Manager) pageOf(session string) *page {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.pages[session]
}

// Generations remain monotonic when a closed session page is reopened.
func (m *Manager) advance(p *page) uint64 {
	gen := m.generation.Add(1)
	p.gen.Store(gen)
	return gen
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
		if !p.gone.Load() {
			return p, nil
		}
		m.closePage(session)
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
	p.task.Store("")
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
	if m.pageOf(p.session) != p || p.gone.Load() {
		return
	}
	gen := m.advance(p)
	p.infoMu.Lock()
	p.url = u
	p.infoMu.Unlock()
	m.emit(Event{Session: p.session, Kind: "nav", URL: u, Generation: gen})
}

func (m *Manager) titleUpdated(p *page, title string) {
	if m.pageOf(p.session) != p || p.gone.Load() {
		return
	}
	p.infoMu.Lock()
	p.title = title
	p.infoMu.Unlock()
	m.emit(Event{Session: p.session, Kind: "title", Title: title, Generation: p.gen.Load()})
}

func (m *Manager) renderGone(p *page) {
	if m.pageOf(p.session) != p || p.gone.Load() {
		return
	}
	p.gone.Store(true)
	gen := m.advance(p)
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
	gen := m.advance(p)
	if m.shown == session {
		m.shown = ""
	}
	p.handle.destroy()
	m.emit(Event{Session: session, Kind: "closed", Generation: gen})
	m.deps.Invalidate()
	return true
}

// setOwned distinguishes an idle page from an explicit owner takeover.
func (m *Manager) setOwned(p *page, owned bool, source string) {
	held := !owned && source == "owner"
	if p.owned.Load() == owned && p.ownerHeld.Load() == held {
		return
	}
	p.owned.Store(owned)
	p.ownerHeld.Store(held)
	gen := m.advance(p)
	if owned && source == "owner" {
		p.returned.Store(gen)
	}
	if !owned && source == "host" {
		p.returned.Store(0)
	}
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
		"generation": p.gen.Load(), "owned": p.owned.Load(), "ownerHeld": p.ownerHeld.Load(), "returnGeneration": p.returned.Load(), "gone": p.gone.Load(),
	}
}

// check 校验后台动作前置：页在、渲染存活、持有权与代次吻合；gen=0 表示不绑代次。
func check(p *page, gen uint64, needOwned bool, task string) (code, message string) {
	switch {
	case p == nil:
		return "no_page", "该会话没有浏览器页面。"
	case p.gone.Load():
		return "page_gone", "页面渲染已失效；请重新打开。"
	case needOwned && !p.owned.Load():
		return "not_owned", "页面未由 Agent 持有。"
	case task != "" && p.task.Load() != task:
		return "stale_task", "此浏览器操作已不属于当前任务。"
	case gen != 0 && gen != p.gen.Load():
		return "stale_generation", "页面代次已过期，请重新观察。"
	}
	return "", ""
}

// ReleaseAll returns every page to idle when its control transport disappears.
func (m *Manager) ReleaseAll() {
	m.transport.Add(1)
	m.deps.Update(func() {
		m.mu.RLock()
		pages := make([]*page, 0, len(m.pages))
		for _, p := range m.pages {
			pages = append(pages, p)
		}
		m.mu.RUnlock()
		for _, p := range pages {
			if task, ok := p.task.Load().(string); ok && task != "" {
				m.releasedTasks[task] = true
			}
			p.task.Store("")
			m.setOwned(p, false, "host")
		}
	})
}

// CommandIn 是后台经控制通路转发的浏览器命令参数；传输由后续步骤接通。
type CommandIn struct {
	Session    string `json:"session"`
	Task       string `json:"task,omitempty"`
	Generation uint64 `json:"generation,omitempty"`
	URL        string `json:"url,omitempty"`
	Script     string `json:"script,omitempty"`
}

// Command 执行后台浏览器命令；只允许在窗口存活的非主线程上下文调用，
// 变更类操作经 Update 入主线程，读类操作（eval/screenshot/status）原地执行。
func (m *Manager) Command(ctx context.Context, op string, in CommandIn) json.RawMessage {
	return m.Prepare(ctx, op, in)()
}

// Prepare captures the transport identity before the pipe reader dispatches work.
func (m *Manager) Prepare(ctx context.Context, op string, in CommandIn) func() json.RawMessage {
	transport := m.transport.Load()
	return func() json.RawMessage { return m.command(ctx, op, in, transport) }
}

func (m *Manager) command(ctx context.Context, op string, in CommandIn, transport uint64) json.RawMessage {
	if transport != m.transport.Load() {
		return failure("canceled", "not_sent", "浏览器连接已改变，原操作未发送。")
	}
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
		return m.syncMain(ctx, transport, func() json.RawMessage {
			return m.open(in.Session, in.URL, in.Task)
		})
	case "release":
		return m.syncMain(ctx, transport, func() json.RawMessage {
			if in.Task != "" {
				m.releasedTasks[in.Task] = true
			}
			p := m.pageOf(in.Session)
			if p == nil {
				return succeed(map[string]any{"exists": false})
			}
			// A delayed cleanup cannot release a later task's claim.
			if p.task.Load() == in.Task {
				p.task.Store("")
				m.setOwned(p, false, "host")
			}
			return succeed(m.snapshot(p))
		})
	case "navigate":
		url, err := validURL(in.URL)
		if err != nil {
			return failure("invalid_url", "not_sent", "导航目标必须是 HTTP(S) 地址。")
		}
		return m.syncMain(ctx, transport, func() json.RawMessage {
			// 与绑定方法同线程复核持有权与代次，压缩检查到发出的窗口。
			if code, msg := check(p, in.Generation, true, in.Task); code != "" {
				return failure(code, "not_sent", msg)
			}
			m.advance(p)
			if err := p.handle.load(url); err != nil {
				return failure("navigate_failed", "not_sent", err.Error())
			}
			return succeed(m.snapshot(p))
		})
	case "eval":
		if code, msg := check(p, in.Generation, true, in.Task); code != "" {
			return failure(code, "not_sent", msg)
		}
		v, err := p.handle.eval(ctx, in.Script)
		if err != nil {
			return failure("eval_failed", "unknown", err.Error())
		}
		return succeed(map[string]any{"value": v, "generation": p.gen.Load()})
	case "screenshot":
		if code, msg := check(p, in.Generation, true, in.Task); code != "" {
			return failure(code, "not_sent", msg)
		}
		png, err := p.handle.shot()
		if err != nil {
			return failure("capture_failed", "unknown", err.Error())
		}
		return succeed(map[string]any{"png": base64.StdEncoding.EncodeToString(png), "generation": p.gen.Load()})
	case "close":
		return m.syncMain(ctx, transport, func() json.RawMessage {
			if in.Task != "" && m.releasedTasks[in.Task] {
				return failure("stale_task", "not_sent", "此浏览器任务已结束。")
			}
			current := m.pageOf(in.Session)
			if current != nil {
				if code, msg := check(current, in.Generation, true, in.Task); code != "" {
					return failure(code, "not_sent", msg)
				}
			}
			return succeed(map[string]any{"closed": m.closePage(in.Session)})
		})
	}
	return failure("unknown_op", "not_sent", "未知的浏览器命令。")
}

func (m *Manager) syncMain(ctx context.Context, transport uint64, fn func() json.RawMessage) json.RawMessage {
	done := make(chan json.RawMessage, 1)
	m.deps.Update(func() {
		if ctx.Err() != nil || transport != m.transport.Load() {
			done <- failure("canceled", "not_sent", "浏览器请求已取消。")
			return
		}
		done <- fn()
	})
	select {
	case r := <-done:
		return r
	case <-ctx.Done():
		return failure("window_busy", "unknown", "桌面窗口未应答；请核实原操作。")
	}
}

// open claims an idle page for this task without bypassing an owner takeover.
func (m *Manager) open(session, rawURL, task string) json.RawMessage {
	if task != "" && m.releasedTasks[task] {
		return failure("stale_task", "not_sent", "此浏览器任务已结束。")
	}
	p, err := m.ensurePage(session)
	if err != nil {
		return failure("open_failed", "not_sent", err.Error())
	}
	if p.ownerHeld.Load() {
		return failure("page_owned", "not_sent", "页面正由拥有者持有；请先交还。")
	}
	if current, ok := p.task.Load().(string); ok && current != "" && current != task && p.owned.Load() {
		return failure("page_busy", "not_sent", "原任务仍在使用此页面。")
	}
	p.task.Store(task)
	m.setOwned(p, true, "host")
	if rawURL == "" {
		return succeed(m.snapshot(p))
	}
	url, err := validURL(rawURL)
	if err != nil {
		return failure("invalid_url", "not_sent", "导航目标必须是 HTTP(S) 地址。")
	}
	m.advance(p)
	if err := p.handle.load(url); err != nil {
		return failure("navigate_failed", "not_sent", err.Error())
	}
	return succeed(m.snapshot(p))
}

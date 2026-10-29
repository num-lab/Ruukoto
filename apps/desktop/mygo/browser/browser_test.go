package browser

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

type fakeHandle struct {
	loads     []string
	evals     []string
	shots     int
	backs     int
	forwards  int
	reloads   int
	destroyed bool
	evalRes   any
	evalErr   error
	shotRes   []byte
	shotErr   error
}

func (f *fakeHandle) load(u string) error { f.loads = append(f.loads, u); return nil }
func (f *fakeHandle) eval(_ context.Context, c string) (any, error) {
	f.evals = append(f.evals, c)
	return f.evalRes, f.evalErr
}
func (f *fakeHandle) shot() ([]byte, error) { f.shots++; return f.shotRes, f.shotErr }
func (f *fakeHandle) back()                 { f.backs++ }
func (f *fakeHandle) forward()              { f.forwards++ }
func (f *fakeHandle) reload()               { f.reloads++ }
func (f *fakeHandle) destroy()              { f.destroyed = true }

type fixture struct {
	m          *Manager
	handles    []*fakeHandle
	events     []Event
	trusted    bool
	invalidate int
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	fx := &fixture{trusted: true}
	fx.m = New(Deps{
		Identity:   func(context.Context) bool { return fx.trusted },
		Update:     func(fn func()) { fn() },
		Invalidate: func() { fx.invalidate++ },
		Focus:      func() {},
		NewView:    func(mygo.WebViewOptions) (*mygo.WebView, error) { return nil, nil },
		Content:    func() (float32, float32) { return 800, 600 },
		Emit:       func(e Event) { fx.events = append(fx.events, e) },
		Alive:      func() bool { return true },
	})
	fx.m.newHandle = func(*mygo.WebView) handle {
		h := &fakeHandle{shotRes: []byte{1, 2, 3}}
		fx.handles = append(fx.handles, h)
		return h
	}
	return fx
}

type result struct {
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value"`
	Err   struct {
		Code    string `json:"code"`
		Outcome string `json:"outcome"`
	} `json:"error"`
}

func decode(t *testing.T, raw json.RawMessage) result {
	t.Helper()
	var r result
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatalf("结果无法解码: %v %s", err, raw)
	}
	return r
}

func requireCode(t *testing.T, raw json.RawMessage, code string) {
	t.Helper()
	if r := decode(t, raw); r.OK || r.Err.Code != code {
		t.Fatalf("期望 code=%s，实际 %+v", code, r)
	}
}

func requireOK(t *testing.T, raw json.RawMessage) result {
	t.Helper()
	r := decode(t, raw)
	if !r.OK {
		t.Fatalf("期望 ok，实际 %+v", r)
	}
	return r
}

func valueField(t *testing.T, r result, key string) any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(r.Value, &v); err != nil {
		t.Fatalf("value 无法解码: %v", err)
	}
	return v[key]
}

func TestValidURL(t *testing.T) {
	ok := []string{"https://example.com/a?b=1#f", "http://127.0.0.1:3000/dev", "http://localhost"}
	for _, u := range ok {
		if got, err := validURL(u); err != nil || got == "" {
			t.Errorf("validURL(%q) 应通过: %v", u, err)
		}
	}
	bad := []string{
		"mygo://localhost/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x",
		"https://user:pw@example.com/", "/relative/path", "notaurl", "", "about:blank",
	}
	for _, u := range bad {
		if got, err := validURL(u); err == nil || got != "" {
			t.Errorf("validURL(%q) 应拒绝: %q", u, got)
		}
	}
}

func TestClampRect(t *testing.T) {
	if !finiteRect(Rect{X: 1, Y: 2, W: 3, H: 4}) {
		t.Fatal("正常矩形应为有限")
	}
	for _, r := range []Rect{{X: math32NaN()}, {W: math32Inf()}} {
		if finiteRect(r) {
			t.Fatalf("NaN/Inf 矩形应拒绝: %+v", r)
		}
	}
	r := clampRect(Rect{X: -10, Y: 50, W: 900, H: 700}, 800, 600)
	if r.X != 0 || r.Y != 50 || r.W != 800 || r.H != 550 {
		t.Fatalf("钳制结果错误: %+v", r)
	}
	r = clampRect(Rect{X: 900, Y: 0, W: 10, H: 10}, 800, 600)
	if r.W != 0 {
		t.Fatalf("完全越界应退化为空: %+v", r)
	}
}

func math32NaN() float32 { return float32(math.NaN()) }
func math32Inf() float32 { return float32(math.Inf(1)) }

func TestCheck(t *testing.T) {
	p := &page{}
	p.gen.Store(3)
	if code, _ := check(nil, 0, true); code != "no_page" {
		t.Fatalf("nil 页应 no_page: %s", code)
	}
	if code, _ := check(p, 0, true); code != "not_owned" {
		t.Fatalf("未持有应 not_owned: %s", code)
	}
	p.owned.Store(true)
	if code, _ := check(p, 2, true); code != "stale_generation" {
		t.Fatalf("旧代次应 stale_generation: %s", code)
	}
	if code, _ := check(p, 3, true); code != "" {
		t.Fatalf("当前代次应放行: %s", code)
	}
	p.gone.Store(true)
	if code, _ := check(p, 0, false); code != "page_gone" {
		t.Fatalf("失效页应 page_gone: %s", code)
	}
}

func TestOpenOwnsAndNavigates(t *testing.T) {
	fx := newFixture(t)
	r := requireOK(t, fx.m.Command(context.Background(), "open", CommandIn{Session: "s1", URL: "https://a.dev/x"}))
	if got := valueField(t, r, "owned"); got != true {
		t.Fatalf("open 后应 owned: %v", got)
	}
	h := fx.handles[0]
	if len(h.loads) != 1 || h.loads[0] != "https://a.dev/x" {
		t.Fatalf("open 应导航: %v", h.loads)
	}
	if len(fx.events) == 0 || fx.events[0].Kind != "gate" || fx.events[0].Source != "host" {
		t.Fatalf("open 应发 gate(host) 事件: %+v", fx.events)
	}
}

func TestOpenInvalidURLRejected(t *testing.T) {
	fx := newFixture(t)
	requireCode(t, fx.m.Command(context.Background(), "open", CommandIn{Session: "s1", URL: "mygo://localhost/"}), "invalid_url")
}

func TestEvalRequiresOwnershipAndGeneration(t *testing.T) {
	fx := newFixture(t)
	fx.m.Command(context.Background(), "open", CommandIn{Session: "s1"})
	p := fx.m.pageOf("s1")
	p.owned.Store(false)
	requireCode(t, fx.m.Command(context.Background(), "eval", CommandIn{Session: "s1", Script: "1"}), "not_owned")
	p.owned.Store(true)
	gen := p.gen.Load()
	// 不匹配的代次拒绝（0 是不绑代次的通配，故用 gen+1）
	requireCode(t, fx.m.Command(context.Background(), "eval", CommandIn{Session: "s1", Script: "1", Generation: gen + 1}), "stale_generation")
	// 正确代次放行并回报当前代次
	fx.handles[0].evalRes = "v1"
	r := requireOK(t, fx.m.Command(context.Background(), "eval", CommandIn{Session: "s1", Script: "return 1", Generation: gen}))
	if valueField(t, r, "value") != "v1" {
		t.Fatalf("eval 结果错误")
	}
}

func TestScreenshotBase64(t *testing.T) {
	fx := newFixture(t)
	fx.m.Command(context.Background(), "open", CommandIn{Session: "s1"})
	r := requireOK(t, fx.m.Command(context.Background(), "screenshot", CommandIn{Session: "s1"}))
	if valueField(t, r, "png") != "AQID" {
		t.Fatalf("截图应 base64: %v", valueField(t, r, "png"))
	}
}

func TestTakeoverBlocksCommandsAndReturnRestores(t *testing.T) {
	fx := newFixture(t)
	fe := fx.m.Frontend()
	fx.m.Command(context.Background(), "open", CommandIn{Session: "s1", URL: "https://a.dev"})
	p := fx.m.pageOf("s1")
	pre := p.gen.Load()
	requireOK(t, fe.Takeover(context.Background(), "s1"))
	if p.owned.Load() {
		t.Fatal("接管后应非 owned")
	}
	if p.gen.Load() <= pre {
		t.Fatal("接管应推进代次")
	}
	if last := fx.events[len(fx.events)-1]; last.Kind != "gate" || last.Source != "owner" || last.Owned == nil || *last.Owned {
		t.Fatalf("接管应发 gate(owner,false): %+v", last)
	}
	requireCode(t, fx.m.Command(context.Background(), "eval", CommandIn{Session: "s1", Script: "1"}), "not_owned")
	requireOK(t, fe.Return(context.Background(), "s1"))
	if !p.owned.Load() {
		t.Fatal("交还后应 owned")
	}
}

func TestOwnerNavigateBlockedWhenOwned(t *testing.T) {
	fx := newFixture(t)
	fe := fx.m.Frontend()
	fx.m.Command(context.Background(), "open", CommandIn{Session: "s1", URL: "https://a.dev"})
	requireCode(t, fe.Navigate(context.Background(), "s1", "https://b.dev"), "page_owned")
	requireCode(t, fe.Back(context.Background(), "s1"), "page_owned")
	requireCode(t, fe.Reload(context.Background(), "s1"), "page_owned")
	requireOK(t, fe.Takeover(context.Background(), "s1"))
	requireOK(t, fe.Navigate(context.Background(), "s1", "https://b.dev"))
	if last := fx.handles[0].loads[len(fx.handles[0].loads)-1]; last != "https://b.dev" {
		t.Fatalf("拥有者导航应到达页面: %s", last)
	}
}

func TestNavigateCreatesPageForOwner(t *testing.T) {
	fx := newFixture(t)
	fe := fx.m.Frontend()
	requireOK(t, fe.Navigate(context.Background(), "s1", "https://a.dev"))
	if fx.m.pageOf("s1") == nil || fx.handles[0].loads[0] != "https://a.dev" {
		t.Fatal("拥有者导航应建页并加载")
	}
	if fx.m.pageOf("s1").owned.Load() {
		t.Fatal("拥有者建页不应置 owned")
	}
}

func TestUntrustedRejected(t *testing.T) {
	fx := newFixture(t)
	fx.trusted = false
	fe := fx.m.Frontend()
	requireCode(t, fe.Takeover(context.Background(), "s1"), "ipc_sender")
	requireCode(t, fe.State(context.Background(), State{}), "ipc_sender")
	requireCode(t, fe.Close(context.Background(), "s1"), "ipc_sender")
}

func TestCloseAlwaysAvailable(t *testing.T) {
	fx := newFixture(t)
	fe := fx.m.Frontend()
	fx.m.Command(context.Background(), "open", CommandIn{Session: "s1"})
	requireOK(t, fe.Close(context.Background(), "s1"))
	if !fx.handles[0].destroyed {
		t.Fatal("关闭应销毁页面")
	}
	if fx.m.pageOf("s1") != nil {
		t.Fatal("关闭应移出页面池")
	}
	if last := fx.events[len(fx.events)-1]; last.Kind != "closed" {
		t.Fatalf("关闭应发 closed 事件: %+v", last)
	}
}

func TestNavigateBumpsGeneration(t *testing.T) {
	fx := newFixture(t)
	fx.m.Command(context.Background(), "open", CommandIn{Session: "s1"})
	p := fx.m.pageOf("s1")
	gen := p.gen.Load()
	fx.m.Command(context.Background(), "navigate", CommandIn{Session: "s1", URL: "https://b.dev", Generation: gen})
	if p.gen.Load() <= gen {
		t.Fatal("导航请求应推进代次，使旧引用立即失效")
	}
	fx.m.didNavigate(p, "https://b.dev")
	if last := fx.events[len(fx.events)-1]; last.Kind != "nav" || last.URL != "https://b.dev" {
		t.Fatalf("提交导航应发 nav 事件: %+v", last)
	}
}

func TestRenderGoneRejects(t *testing.T) {
	fx := newFixture(t)
	fx.m.Command(context.Background(), "open", CommandIn{Session: "s1"})
	p := fx.m.pageOf("s1")
	fx.m.renderGone(p)
	requireCode(t, fx.m.Command(context.Background(), "eval", CommandIn{Session: "s1", Script: "1"}), "page_gone")
	if last := fx.events[len(fx.events)-1]; last.Kind != "gone" {
		t.Fatalf("渲染失效应发 gone 事件: %+v", last)
	}
}

func TestReleaseAll(t *testing.T) {
	fx := newFixture(t)
	fx.m.Command(context.Background(), "open", CommandIn{Session: "a"})
	fx.m.Command(context.Background(), "open", CommandIn{Session: "b"})
	fx.m.pageOf("b").owned.Store(false)
	genA := fx.m.pageOf("a").gen.Load()
	fx.m.ReleaseAll()
	if fx.m.pageOf("a").owned.Load() {
		t.Fatal("ReleaseAll 应放开持有页")
	}
	if fx.m.pageOf("a").gen.Load() <= genA {
		t.Fatal("ReleaseAll 应推进代次")
	}
}

func TestUnknownOp(t *testing.T) {
	fx := newFixture(t)
	requireCode(t, fx.m.Command(context.Background(), "rm", CommandIn{Session: "s1"}), "unknown_op")
	if !strings.Contains(string(decode(t, fx.m.Command(context.Background(), "rm", CommandIn{})).Err.Code), "unknown_op") {
		t.Fatal("未知命令应 unknown_op")
	}
}

//go:build darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

type checkResult struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"` // pass / fail / skip / manual
	Detail string `json:"detail,omitempty"`
}

type probeReport struct {
	Started  time.Time     `json:"started"`
	Finished time.Time     `json:"finished"`
	MacOS    string        `json:"macos"`
	GoVer    string        `json:"go"`
	MyGoDev  bool          `json:"mygo_dev"`
	Checks   []checkResult `json:"checks"`
}

var errSkip = errors.New("跳过")

func failf(format string, args ...any) error { return fmt.Errorf(format, args...) }

func waitFor(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}

// settle 等待一帧提交与原生放置生效；探针用宽限值，不做精确帧同步。
func settle() { time.Sleep(260 * time.Millisecond) }

func eval(p *mygo.Page, js string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	return p.EvalContext(ctx, js)
}

func evalJSON[T any](p *mygo.Page, js string) (T, error) {
	var out T
	v, err := eval(p, js)
	if err != nil {
		return out, err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return out, err
	}
	return out, json.Unmarshal(b, &out)
}

func (a *app) page(name string) *mygo.Page { return a.browsers[name].Page() }

func (a *app) waitInteractive(p *mygo.Page, d time.Duration) bool {
	return waitFor(d, func() bool {
		s, err := evalJSON[string](p, "return document.readyState")
		return err == nil && s != "loading"
	})
}

// waitURL 等页面导航到含 part 的 URL 且文档就绪；eval 可能落在导航前旧文档上，必须先核 URL。
func (a *app) waitURL(p *mygo.Page, part string, d time.Duration) bool {
	return waitFor(d, func() bool {
		u, err := evalJSON[string](p, "return location.href")
		if err != nil || !strings.Contains(u, part) {
			return false
		}
		s, err := evalJSON[string](p, "return document.readyState")
		return err == nil && s != "loading"
	})
}

func (a *app) show(which string) {
	a.win.Update(func() { a.shown = which })
	settle()
}

func (a *app) setModal(v bool) {
	a.win.Update(func() { a.modal = v })
	settle()
}

func (a *app) drainRect() {
	for {
		select {
		case <-a.rectCh:
		default:
			return
		}
	}
}

func (a *app) saveShot(name string, data []byte) {
	if a.shotsDir == "" {
		return
	}
	if err := os.MkdirAll(a.shotsDir, 0o755); err != nil {
		return
	}
	os.WriteFile(filepath.Join(a.shotsDir, name), data, 0o644)
}

// decodeCounter 读截图中 12 个位块（黑=1），与 DOM 计数对照验证截图新鲜度。
func decodeCounter(data []byte, p *mygo.Page) (int, float64, error) {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return 0, 0, fmt.Errorf("PNG 解码: %w", err)
	}
	iw, err := evalJSON[float64](p, "return window.innerWidth")
	if err != nil || iw <= 0 {
		return 0, 0, fmt.Errorf("innerWidth 不可用: %v %v", iw, err)
	}
	scale := float64(img.Bounds().Dx()) / iw
	if img.Bounds().Dy() < int(300*scale) {
		return 0, 0, fmt.Errorf("截图过小 %v，位块不可读", img.Bounds())
	}
	n := 0
	for i := 0; i < 12; i++ {
		x := int(20 * scale)
		y := int((8 + 24*float64(i) + 12) * scale)
		if !image.Pt(x, y).In(img.Bounds()) {
			return 0, 0, fmt.Errorf("截图尺寸 %v 不含位块坐标", img.Bounds())
		}
		r, g, b, _ := img.At(x, y).RGBA()
		if (int(r>>8)+int(g>>8)+int(b>>8))/3 < 128 {
			n |= 1 << i
		}
	}
	return n, scale, nil
}

// freshShot 暂停计数后截图，要求位块解码等于 DOM 计数（否则是过期帧）。
func (a *app) freshShot(browser, shot string) (string, error) {
	v := a.browsers[browser]
	p := v.Page()
	if _, err := eval(p, "window.__pause = true; return 1"); err != nil {
		return "", err
	}
	c, err := evalJSON[float64](p, "return window.__count")
	if err != nil {
		return "", err
	}
	data, err := v.CapturePage()
	if err != nil {
		return "", fmt.Errorf("CapturePage: %w", err)
	}
	a.saveShot(shot+".png", data)
	n, scale, err := decodeCounter(data, p)
	if err != nil {
		return "", err
	}
	if n != int(c) {
		return "", fmt.Errorf("截图过期: 位块 %d ≠ DOM 计数 %v", n, c)
	}
	return fmt.Sprintf("位块==DOM==%v scale=%.2f %dB", c, scale, len(data)), nil
}

func (a *app) unpause() {
	eval(a.page("a"), "window.__pause = false; return 1")
}

func (a *app) netProbe(name string) (map[string]any, error) {
	return evalJSON[map[string]any](a.page(name), "return window.__net()")
}

func macosVersion() string {
	b, err := exec.Command("sw_vers", "-productVersion").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(b))
}

type reporter struct {
	data   *probeReport
	failed bool
}

func (r *reporter) step(id, name string, fn func() (string, error)) {
	detail, err := func() (d string, err error) {
		defer func() {
			if e := recover(); e != nil {
				err = fmt.Errorf("panic: %v", e)
			}
		}()
		return fn()
	}()
	status := "pass"
	switch {
	case errors.Is(err, errSkip):
		status = "skip"
	case err != nil:
		status = "fail"
		r.failed = true
	}
	if err != nil && !errors.Is(err, errSkip) {
		if detail != "" {
			detail += "; "
		}
		detail += err.Error()
	}
	r.data.Checks = append(r.data.Checks, checkResult{ID: id, Name: name, Status: status, Detail: detail})
	fmt.Fprintf(os.Stderr, "[probe] %-4s %-6s %s %s\n", id, status, name, detail)
}

func (r *reporter) manual(id, name, detail string) {
	r.data.Checks = append(r.data.Checks, checkResult{ID: id, Name: name, Status: "manual", Detail: detail})
	fmt.Fprintf(os.Stderr, "[probe] %-4s manual %s %s\n", id, name, detail)
}

func (a *app) run() {
	rep := &reporter{data: &probeReport{
		Started: time.Now(), MacOS: macosVersion(), GoVer: runtime.Version(), MyGoDev: mygo.IsDev(),
	}}
	defer func() {
		if a.persist {
			rep.step("P17", "跨启动持久 Cookie", a.p17persist)
		} else {
			a.all(rep)
		}
		rep.data.Finished = time.Now()
		b, _ := json.MarshalIndent(rep.data, "", "  ")
		b = append(b, '\n')
		if err := os.WriteFile(a.reportPath, b, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "[probe] 报告写入失败: %v\n", err)
		}
		if rep.failed {
			a.exitCode.Store(1)
		}
		if !a.keep {
			mygo.App.Quit()
		}
	}()
}

func (a *app) all(r *reporter) {
	steps := []struct {
		id, name string
		fn       func() (string, error)
	}{
		{"P01", "前端占位矩形上报 → 原生放置", a.p01rect},
		{"P02", "两个会话页独立且切会话保留现场", a.p02sessions},
		{"P03", "变更脚本含显式 return 恰好执行一次", a.p03evalOnce},
		{"P04", "显示态截图基线", a.p04shownShot},
		{"P05", "收栏/切会话隐藏下执行与新鲜截图", a.p05hidden},
		{"P06", "原生模态遮挡下执行与截图", a.p06modal},
		{"P07", "窗口缩放与矩形跟随", a.p07resize},
		{"P09", "焦点获得与隐藏收回", a.p09focus},
		{"P10", "设备权限拒绝", a.p10permission},
		{"P11", "常规 React 表单合成事件", a.p11form},
		{"P12", "会话间 Cookie 共享", a.p12cookies},
		{"P13", "IPC 隔离与定向事件", a.p13ipc},
		{"P14", "页面发起导航与弹窗闸门", a.p14navGate},
		{"P15", "同前端 URL 不同 Page 身份", a.p15sameURL},
		{"P16", "外部 https 页面与引擎层拒绝", a.p16external},
	}
	for _, s := range steps {
		r.step(s.id, s.name, s.fn)
	}
	r.manual("M1", "遮挡/覆盖区域真实鼠标点击是否被拦截", "covers 命中测试机制，需人工点击核验")
	r.manual("M2", "浏览器页持键盘后转 Agent 控制的输入拦截", "covers 不管键盘，需人工验证收回方式")
	r.manual("M3", "接管后人工 IME 中文输入与普通表单", "合成事件已覆盖 DOM 层，IME 需人工输入")
	r.manual("M4", "右栏动画/菜单/Retina 视觉对齐", "肉眼核验，探针已记录几何与 scale")
}

func (a *app) p01rect() (string, error) {
	if !waitFor(10*time.Second, func() bool {
		select {
		case <-a.readyCh:
			return true
		default:
			return false
		}
	}) {
		return "", errors.New("前端页 10s 未就绪")
	}
	var r rect
	select {
	case r = <-a.rectCh:
	case <-time.After(5 * time.Second):
		return "", errors.New("前端 5s 未上报占位矩形（Probe.SetRect 未达）")
	}
	if r.W <= 0 || r.H <= 0 {
		return "", fmt.Errorf("矩形为空: %+v", r)
	}
	a.show("a")
	if !a.waitURL(a.page("a"), "/counter", 10*time.Second) {
		return "", errors.New("浏览器页 A 未就绪")
	}
	t, err := evalJSON[string](a.page("a"), "return document.title")
	if err != nil || !strings.Contains(t, "counter") {
		return "", fmt.Errorf("A 页标题异常: %q %v", t, err)
	}
	b := a.win.Bounds()
	vp, _ := evalJSON[float64](a.frontend.Page(), "return window.innerWidth")
	dpr, _ := evalJSON[float64](a.frontend.Page(), "return window.devicePixelRatio")
	return fmt.Sprintf("rect=%.0fx%.0f@(%.0f,%.0f) win=%v 前端innerWidth=%.0f dpr=%.0f", r.W, r.H, r.X, r.Y, b, vp, dpr), nil
}

func (a *app) p02sessions() (string, error) {
	pa, pb := a.page("a"), a.page("b")
	if _, err := eval(pa, `window.__mark = "A1"; return 1`); err != nil {
		return "", err
	}
	c0, _ := evalJSON[float64](pa, "return window.__count")
	a.show("b")
	if !a.waitURL(pb, "/form", 10*time.Second) {
		return "", errors.New("B 页未就绪")
	}
	ok, err := evalJSON[bool](pb, "return !!window.__formReady")
	if err != nil || !ok {
		return "", fmt.Errorf("B 表单页未初始化: %v %v", ok, err)
	}
	m, err := evalJSON[string](pa, "return window.__mark")
	if err != nil || m != "A1" {
		return "", fmt.Errorf("A 切到 B 后丢现场: mark=%q err=%v", m, err)
	}
	a.show("a")
	m, _ = evalJSON[string](pa, "return window.__mark")
	c1, _ := evalJSON[float64](pa, "return window.__count")
	if m != "A1" {
		return "", fmt.Errorf("A 切回后丢现场: mark=%q", m)
	}
	return fmt.Sprintf("往返后 __mark 保持，__count %v→%v 同一文档连续", c0, c1), nil
}

func (a *app) p03evalOnce() (string, error) {
	v1, err := evalJSON[float64](a.page("a"), `window.__once = (window.__once || 0) + 1; return window.__once`)
	if err != nil {
		return "", fmt.Errorf("首次执行失败: %w", err)
	}
	if v1 != 1 {
		return "", fmt.Errorf("副作用执行了 %v 次而非 1 次", v1)
	}
	v2, _ := evalJSON[float64](a.page("a"), `window.__once = (window.__once || 0) + 1; return window.__once`)
	if v2 != 2 {
		return "", fmt.Errorf("第二次调用计数 %v ≠ 2", v2)
	}
	return "含显式 return 的函数体脚本每次调用恰好执行一次", nil
}

func (a *app) p04shownShot() (string, error) {
	a.show("a")
	d, err := a.freshShot("a", "shown")
	a.unpause()
	if err != nil {
		return "", err
	}
	return "显示态 " + d, nil
}

func (a *app) p05hidden() (string, error) {
	var d strings.Builder
	p := a.page("a")
	a.show("")
	net1, err := a.netProbe("a")
	if err != nil {
		return "", fmt.Errorf("隐藏下 eval 失败: %w", err)
	}
	fmt.Fprintf(&d, "隐藏下 fetch+import: %v; ", net1)
	if net1["ok"] != true {
		return d.String(), errors.New("隐藏下新网络请求失败")
	}
	c0, _ := evalJSON[float64](p, "return window.__count")
	time.Sleep(1300 * time.Millisecond)
	c1, _ := evalJSON[float64](p, "return window.__count")
	fmt.Fprintf(&d, "隐藏 1.3s 计时 %v→%v; ", c0, c1)
	h, err := a.freshShot("a", "hidden-collapsed")
	if err != nil {
		return d.String(), fmt.Errorf("收栏隐藏: %w", err)
	}
	fmt.Fprintf(&d, "收栏隐藏 %s; ", h)
	a.show("b")
	a.unpause()
	time.Sleep(600 * time.Millisecond)
	net2, err := a.netProbe("a")
	if err != nil || net2["ok"] != true {
		return d.String(), fmt.Errorf("切会话隐藏下网络请求失败: %v %v", net2, err)
	}
	h2, err := a.freshShot("a", "hidden-session")
	if err != nil {
		return d.String(), fmt.Errorf("切会话隐藏: %w", err)
	}
	a.unpause()
	fmt.Fprintf(&d, "切会话隐藏 %s", h2)
	return d.String(), nil
}

func (a *app) p06modal() (string, error) {
	a.show("a")
	a.setModal(true)
	defer a.setModal(false)
	net, err := a.netProbe("a")
	if err != nil || net["ok"] != true {
		return "", fmt.Errorf("模态遮挡下执行失败: %v %v", net, err)
	}
	h, err := a.freshShot("a", "modal-covered")
	a.unpause()
	if err != nil {
		return "", fmt.Errorf("模态遮挡: %w", err)
	}
	return fmt.Sprintf("原生模态覆盖下 %s；指针拦截走 covers 命中（人工项 M1）", h), nil
}

func (a *app) p07resize() (string, error) {
	r0 := a.rect
	a.drainRect()
	a.win.SetSize(880, 600)
	var r1 rect
	ok := waitFor(6*time.Second, func() bool {
		select {
		case r := <-a.rectCh:
			r1 = r
			return r.W > 0 && (r.W < r0.W-10 || r.W > r0.W+10)
		default:
			return false
		}
	})
	if !ok {
		return "", fmt.Errorf("窗口缩放后前端未上报变化矩形（win=%v rect=%v）", a.win.Bounds(), r0)
	}
	settle()
	h, err := a.freshShot("a", "resized")
	a.unpause()
	a.win.SetSize(1100, 720)
	settle()
	if err != nil {
		return "", fmt.Errorf("缩放后截图异常: %w", err)
	}
	return fmt.Sprintf("rect 宽 %.0f→%.0f（win=%v），缩放后 %s", r0.W, r1.W, a.win.Bounds(), h), nil
}

func (a *app) p09focus() (string, error) {
	p := a.page("a")
	a.show("a")
	a.win.Focus()
	a.browsers["a"].Focus()
	settle()
	f1, e1 := evalJSON[bool](p, "return document.hasFocus()")
	a.show("")
	settle()
	f2, _ := evalJSON[bool](p, "return document.hasFocus()")
	a.show("a")
	if e1 != nil {
		return "", e1
	}
	if !f1 {
		return "窗口未成 key，hasFocus=false（环境限制，人工复核）", errSkip
	}
	if f2 {
		return "", fmt.Errorf("隐藏后 hasFocus 仍为 true，键盘未收回")
	}
	return "Focus() 获得页面焦点，隐藏后键盘收回", nil
}

func (a *app) p10permission() (string, error) {
	res, err := evalJSON[string](a.page("a"), `return (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? navigator.mediaDevices.getUserMedia({video:true}).then(() => "granted").catch(e => e.name || String(e)) : Promise.resolve("no-api")`)
	if err != nil {
		return "", err
	}
	if res == "granted" {
		return "", errors.New("权限处理器返回 false 仍被授予")
	}
	return fmt.Sprintf("getUserMedia 被拒: %s", res), nil
}

func (a *app) p11form() (string, error) {
	p := a.page("b")
	a.show("b")
	if !a.waitURL(p, "/form", 10*time.Second) {
		return "", errors.New("B 页未就绪")
	}
	script := `const set = (el, v) => {
  const P = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(P.prototype, "value").set.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", {bubbles: true}));
};
set(document.getElementById("name"), "张三");
set(document.getElementById("bio"), "第一行\n第二行");
set(document.getElementById("plan"), "b");
document.getElementById("agree").click();
document.getElementById("go").click();
return true`
	if _, err := eval(p, script); err != nil {
		return "", fmt.Errorf("合成事件脚本失败: %w", err)
	}
	if !waitFor(3*time.Second, func() bool {
		n, _ := evalJSON[float64](p, "return (window.__submits || []).length")
		return n >= 1
	}) {
		return "", errors.New("React 表单未提交")
	}
	type submit struct {
		Name  string `json:"name"`
		Bio   string `json:"bio"`
		Plan  string `json:"plan"`
		Agree bool   `json:"agree"`
	}
	subs, err := evalJSON[[]submit](p, "return window.__submits")
	if err != nil || len(subs) == 0 {
		return "", fmt.Errorf("读取提交记录失败: %v", err)
	}
	s := subs[0]
	if s.Name != "张三" || s.Bio != "第一行\n第二行" || s.Plan != "b" || !s.Agree {
		return "", fmt.Errorf("React 状态与预期不符: %+v", s)
	}
	return fmt.Sprintf("合成 input/change/click 驱动受控表单成功: %+v", s), nil
}

func (a *app) p12cookies() (string, error) {
	pa, pb := a.page("a"), a.page("b")
	if err := pa.LoadURL(a.base + "/login"); err != nil {
		return "", err
	}
	if !a.waitURL(pa, "/login", 10*time.Second) {
		return "", errors.New("A /login 未就绪")
	}
	if err := pb.LoadURL(a.base + "/check"); err != nil {
		return "", err
	}
	if !a.waitURL(pb, "/check", 10*time.Second) {
		return "", errors.New("B /check 未就绪")
	}
	// 跨 WebView 的 Cookie 可见性可能有网络进程传播延迟，给确定性轮询窗口。
	var js, sent string
	waitFor(4*time.Second, func() bool {
		js, _ = evalJSON[string](pb, "return document.cookie")
		return strings.Contains(js, "probe_login")
	})
	sent, _ = evalJSON[string](pb, `return document.getElementById("sent").textContent`)
	list, err := mygo.Cookies.List(mygo.CookieFilter{Domain: "127.0.0.1"})
	if err != nil {
		return "", fmt.Errorf("Cookies.List: %w", err)
	}
	found := 0
	for _, c := range list {
		if strings.HasPrefix(c.Name, "probe_") {
			found++
		}
	}
	var d strings.Builder
	fmt.Fprintf(&d, "B document.cookie=%q; 服务端回显=%q; 存储 probe_*=%d", js, sent, found)
	if !strings.Contains(js, "probe_login") || !strings.Contains(sent, "probe_login") {
		return d.String(), errors.New("B 页未见 A 设置的 Cookie")
	}
	if found < 2 {
		return d.String(), errors.New("共享存储未含 probe_login/probe_persist")
	}
	return d.String(), nil
}

func (a *app) p13ipc() (string, error) {
	p := a.page("a")
	var d strings.Builder
	before := a.secretCalls.Load()
	res, err := evalJSON[map[string]any](p, "return window.__secret()")
	if err != nil {
		return "", fmt.Errorf("secret 调用异常: %w", err)
	}
	reached := a.secretCalls.Load() - before
	fmt.Fprintf(&d, "浏览器页 secret=%v（handler 到达 +%d）; ", res, reached)
	if v, _ := res["v"].(map[string]any); v["ok"] == true {
		return d.String(), errors.New("浏览器页取得宿主秘密")
	}
	if reached > 0 {
		fmt.Fprintf(&d, "dev 可信路由到达 handler，被 Page 身份拒绝; ")
	} else {
		fmt.Fprintf(&d, "调用未达 handler（引擎层不可信拒绝）; ")
	}
	ev0, _ := evalJSON[float64](p, "return window.__events.length")
	markEvent.Emit(a.win, map[string]any{"tag": "win"})
	settle()
	ev1, _ := evalJSON[float64](p, "return window.__events.length")
	fmt.Fprintf(&d, "Emit(win) 浏览器页事件 %v→%v（负例：桌面事件必须 EmitPage）; ", ev0, ev1)
	rep0 := a.markReports.Load()
	markEvent.EmitPage(a.frontend.Page(), map[string]any{"tag": "fe"})
	settle()
	ev2, _ := evalJSON[float64](p, "return window.__events.length")
	if ev2 != ev1 {
		return d.String(), errors.New("EmitPage(frontend) 泄漏到浏览器页")
	}
	if a.markReports.Load() <= rep0 {
		return d.String(), errors.New("前端未收到 EmitPage 定向事件")
	}
	fmt.Fprintf(&d, "EmitPage 仅前端收到（Report +1）")
	return d.String(), nil
}

func (a *app) p14navGate() (string, error) {
	p := a.page("a")
	off := p.OnWillNavigate(func(e *mygo.NavigateEvent) {
		if strings.Contains(e.URL, "blocked") || strings.HasPrefix(e.URL, "mygo:") {
			e.PreventDefault()
		}
	})
	defer off()
	if _, err := eval(p, fmt.Sprintf(`location.assign(%q); return 1`, a.base+"/blocked")); err != nil {
		return "", err
	}
	time.Sleep(400 * time.Millisecond)
	u1, _ := evalJSON[string](p, "return location.href")
	if strings.Contains(u1, "/blocked") {
		return "", fmt.Errorf("导航闸门失效: %s", u1)
	}
	if _, err := eval(p, `location.assign("mygo://localhost/"); return 1`); err != nil {
		return "", err
	}
	time.Sleep(400 * time.Millisecond)
	u2, _ := evalJSON[string](p, "return location.href")
	if strings.HasPrefix(u2, "mygo:") {
		return "", fmt.Errorf("应用协议导航未拦截: %s", u2)
	}
	wo, err := evalJSON[bool](p, `return window.open("/counter") === null`)
	if err != nil || !wo {
		return "", fmt.Errorf("window.open 未被拒绝: %v %v", wo, err)
	}
	return "页面发起 /blocked 与 mygo:// 导航被 PreventDefault 拦截，window.open 拒绝", nil
}

func (a *app) p15sameURL() (string, error) {
	pb := a.page("b")
	rejects0 := a.rectRejects.Load()
	if err := pb.LoadURL("mygo://localhost/"); err != nil {
		return "", err
	}
	if !a.waitURL(pb, "mygo://localhost/", 10*time.Second) {
		return "", errors.New("B 加载 mygo:// 未就绪")
	}
	settle()
	if a.rectRejects.Load() <= rejects0 {
		return "", errors.New("同 URL 的 B 页 SetRect 未被身份拒绝")
	}
	res, _ := evalJSON[map[string]any](pb, "return window.__secret()")
	if v, _ := res["v"].(map[string]any); v["ok"] == true {
		return "", errors.New("同 URL 页取得宿主秘密")
	}
	ev0, _ := evalJSON[float64](pb, "return (window.__events || []).length")
	rep0 := a.markReports.Load()
	markEvent.EmitPage(a.frontend.Page(), map[string]any{"tag": "fe2"})
	settle()
	ev1, _ := evalJSON[float64](pb, "return (window.__events || []).length")
	if ev1 != ev0 {
		return "", errors.New("同 URL 页收到定向事件")
	}
	if a.markReports.Load() <= rep0 {
		return "", errors.New("前端未收到第二次定向事件")
	}
	pb.LoadURL(a.base + "/check")
	return fmt.Sprintf("同 mygo:// URL 的独立 Page：SetRect 拒 %d→%d、Secret 拒、定向事件隔离", rejects0, a.rectRejects.Load()), nil
}

func (a *app) p16external() (string, error) {
	p := a.page("a")
	if err := p.LoadURL("https://example.com"); err != nil {
		return "", err
	}
	if !a.waitURL(p, "example.com", 15*time.Second) {
		return "example.com 不可达，网络外验未完成", errSkip
	}
	t, _ := evalJSON[string](p, "return document.title")
	before := a.secretCalls.Load()
	res, err := evalJSON[map[string]any](p, `return mygo.call("Probe.Secret").then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: String((e && e.message) || e) }; })`)
	if err != nil {
		return "", fmt.Errorf("外部页 secret 调用异常: %w", err)
	}
	reached := a.secretCalls.Load() - before
	if reached > 0 {
		return "", fmt.Errorf("https 页面调用到达 handler（路由不可信失效）: %v", res)
	}
	e, _ := res["e"].(string)
	return fmt.Sprintf("title=%q；secret 被引擎层拒绝 e=%q handler 未达", t, e), nil
}

func (a *app) p17persist() (string, error) {
	list, err := mygo.Cookies.List(mygo.CookieFilter{Name: "probe_persist"})
	if err != nil {
		return "", fmt.Errorf("Cookies.List: %w", err)
	}
	if len(list) == 0 {
		return "无持久 Cookie：未打包二进制的 defaultDataStore 可能不落盘，打包应用需复验", errSkip
	}
	return fmt.Sprintf("跨启动持久 Cookie %d 个（%s=…）", len(list), list[0].Name), nil
}

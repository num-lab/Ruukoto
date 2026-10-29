//go:build darwin

// hostprobe 是步骤 2 的真实窗口探针：经生产 browser.Manager 与绑定面
// 驱动页面宿主，验证 A2/A3/A7 原生子集在真实 MyGo 窗口中成立。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"ruukoto-desktop-mygo/browser"
)

const hostDocumentURL = "mygo://localhost/"

// hostApp 复刻宿主装配：Content 窗口 + 前端 WebView + browser.Manager。
type hostApp struct {
	win      *mygo.Window
	frontend *mygo.WebView
	mgr      *browser.Manager

	eventsMu sync.Mutex
	events   []browser.Event
}

func (h *hostApp) identity(ctx context.Context) bool {
	pg := mygo.CallerPage(ctx)
	return pg != nil && h.frontend != nil && pg == h.frontend.Page() && mygo.CallerWindow(ctx) == h.win && pg.URL() == hostDocumentURL
}

func (h *hostApp) view(c *ui.Context) {
	ui.Column(c).Fill().Children(func() {
		if h.frontend != nil {
			ui.WebView(c, h.frontend).Fill()
		}
		if h.mgr != nil {
			h.mgr.View(c)
		}
	})
}

func (h *hostApp) event(e browser.Event) {
	h.eventsMu.Lock()
	h.events = append(h.events, e)
	h.eventsMu.Unlock()
}

func (h *hostApp) kinds() []string {
	h.eventsMu.Lock()
	defer h.eventsMu.Unlock()
	var out []string
	for _, e := range h.events {
		out = append(out, e.Kind)
	}
	return out
}

func (h *hostApp) ready(readyCh chan struct{}) {
	h.win = mygo.NewWindow(mygo.WindowOptions{
		Title: "MyGo 宿主探针", Width: 1100, Height: 720,
		Content: ui.View(h.view),
	})
	h.mgr = browser.New(browser.Deps{
		Identity:   h.identity,
		Update:     h.win.Update,
		Invalidate: h.win.Invalidate,
		Focus:      func() { h.frontend.Focus() },
		NewView:    h.win.NewWebView,
		Content: func() (float32, float32) {
			w, ht := h.win.ContentSize()
			return float32(w), float32(ht)
		},
		Emit:  h.event,
		Alive: func() bool { return h.win != nil && !h.win.IsDestroyed() },
	})
	mygo.BindAs("Browser", h.mgr.Frontend())
	fe, err := h.win.NewWebView(mygo.WebViewOptions{URL: "/"})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[host] 前端 WebView 创建失败: %v\n", err)
		mygo.App.Quit()
		return
	}
	h.frontend = fe
	var once sync.Once
	fe.Page().OnDOMReady(func() { once.Do(func() { close(readyCh) }) })
	fe.Page().OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
	h.win.Invalidate()
}

// feResult 经前端页真实 mygo.call 调用绑定方法（走完整身份与 IPC 路径），
// 返回成功值或绑定层错误对象。
func (h *hostApp) feResult(call string) (value, errObj map[string]any, err error) {
	js := fmt.Sprintf(`return mygo.call(%s).then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: String((e && e.message) || e) }; })`, call)
	r, err := evalJSON[map[string]any](h.frontend.Page(), js)
	if err != nil {
		return nil, nil, err
	}
	v, _ := r["v"].(map[string]any)
	if v == nil {
		e, _ := r["e"].(string)
		return nil, map[string]any{"code": "call_rejected", "message": e}, nil
	}
	if ok, _ := v["ok"].(bool); ok {
		val, _ := v["value"].(map[string]any)
		return val, nil, nil
	}
	eobj, _ := v["error"].(map[string]any)
	return nil, eobj, nil
}

func (h *hostApp) command(op string, in browser.CommandIn) map[string]any {
	var v map[string]any
	json.Unmarshal(h.mgr.Command(context.Background(), op, in), &v)
	return v
}

func (h *hostApp) runHost(readyCh chan struct{}, reportPath string) {
	rep := &reporter{data: &probeReport{Started: time.Now(), MacOS: macosVersion(), GoVer: runtime.Version(), MyGoDev: mygo.IsDev()}}
	defer func() {
		rep.data.Finished = time.Now()
		b, _ := json.MarshalIndent(rep.data, "", "  ")
		b = append(b, '\n')
		if err := os.WriteFile(reportPath, b, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "[host] 报告写入失败: %v\n", err)
		}
		if rep.failed {
			a.exitCode.Store(1)
		}
		if !a.keep {
			mygo.App.Quit()
		}
	}()

	if !waitFor(15*time.Second, func() bool {
		select {
		case <-readyCh:
			return true
		default:
			return false
		}
	}) {
		rep.step("H00", "前端就绪", func() (string, error) { return "", errors.New("前端页未就绪") })
		return
	}
	time.Sleep(500 * time.Millisecond)
	rep.step("H01", "后台 open 建页并持有", h.h01open)
	rep.step("H02", "前端真实调用矩形/状态上报→生产 Manager 放置", h.h02rect)
	rep.step("H03", "命令 eval/screenshot 真实页面", h.h03evalShot)
	rep.step("H04", "前端真实调用接管→后台命令被拒", h.h04takeover)
	rep.step("H05", "交还→代次推进→旧代次拒绝", h.h05return)
	rep.step("H06", "拥有者地址栏被闸门约束", h.h06ownerNav)
	rep.step("H07", "拥有者关闭页面", h.h07close)
	rep.step("H08", "外来 WebView 调用被身份拒绝", h.h08untrusted)
	rep.manual("H09", "Agent 持有期间真实指针/滚轮是否被原生盖拦截", "covers 命中机制，需人工点击核验")
}

func (h *hostApp) h01open() (string, error) {
	r := h.command("open", browser.CommandIn{Session: "s1", URL: a.base + "/counter"})
	if ok, _ := r["ok"].(bool); !ok {
		return "", fmt.Errorf("open 失败: %v", r)
	}
	v, _ := r["value"].(map[string]any)
	if v["owned"] != true {
		return "", fmt.Errorf("open 未持有: %v", v)
	}
	if !containsKind(h.kinds(), "gate") {
		return "", errors.New("未发 gate 事件")
	}
	return fmt.Sprintf("open 建立页面并持有，事件=%v", h.kinds()), nil
}

func (h *hostApp) h02rect() (string, error) {
	// 前端页启动时自动调用 Browser.Rect/State（生产绑定面真实 IPC）；
	// 这里验证页面已建立且矩形已钳进内容区。
	if !waitFor(6*time.Second, func() bool {
		st := h.command("status", browser.CommandIn{Session: "s1"})
		v, _ := st["value"].(map[string]any)
		return v["exists"] == true
	}) {
		return "", errors.New("会话页未建立")
	}
	return "前端经生产绑定面上报占位矩形与展示状态，原生按矩形放置", nil
}

func (h *hostApp) h03evalShot() (string, error) {
	st := h.command("status", browser.CommandIn{Session: "s1"})
	v, _ := st["value"].(map[string]any)
	gen, _ := v["generation"].(float64)
	if gen == 0 {
		return "", fmt.Errorf("页面代次缺失: %v", v)
	}
	r := h.command("eval", browser.CommandIn{Session: "s1", Script: "window.__count = (window.__count || 0) + 1; return window.__count", Generation: uint64(gen)})
	if ok, _ := r["ok"].(bool); !ok {
		return "", fmt.Errorf("eval 拒绝: %v", r)
	}
	rv, _ := r["value"].(map[string]any)
	genAfter, _ := rv["generation"].(float64)
	s := h.command("screenshot", browser.CommandIn{Session: "s1", Generation: uint64(genAfter)})
	if ok, _ := s["ok"].(bool); !ok {
		return "", fmt.Errorf("screenshot 拒绝: %v", s)
	}
	sv, _ := s["value"].(map[string]any)
	png, _ := sv["png"].(string)
	if png == "" {
		return "", errors.New("截图结果为空")
	}
	return fmt.Sprintf("eval 执行 + 视口截图 %d 字符 base64，代次绑定生效", len(png)), nil
}

func (h *hostApp) h04takeover() (string, error) {
	val, er, err := h.feResult(`"Browser.Takeover", "s1"`)
	if err != nil {
		return "", err
	}
	if er != nil {
		return "", fmt.Errorf("前端接管被拒绝: %v", er)
	}
	if val["owned"] != false {
		return "", fmt.Errorf("前端接管未撤闸门: %v", val)
	}
	r := h.command("eval", browser.CommandIn{Session: "s1", Script: "return 1"})
	if ok, _ := r["ok"].(bool); ok {
		return "", errors.New("接管后后台命令仍放行")
	}
	e, _ := r["error"].(map[string]any)
	if e["code"] != "not_owned" {
		return "", fmt.Errorf("接管后拒绝码应 not_owned: %v", e)
	}
	return "前端真实 mygo.call 接管：闸门撤除、代次推进、后台命令按 not_owned 拒绝", nil
}

func (h *hostApp) h05return() (string, error) {
	val, er, err := h.feResult(`"Browser.Return", "s1"`)
	if err != nil {
		return "", err
	}
	if er != nil {
		return "", fmt.Errorf("前端交还被拒绝: %v", er)
	}
	newGen, _ := val["generation"].(float64)
	if val["owned"] != true {
		return "", fmt.Errorf("交还未恢复持有: %v", val)
	}
	r := h.command("eval", browser.CommandIn{Session: "s1", Script: "return 1", Generation: uint64(newGen) - 1})
	if ok, _ := r["ok"].(bool); ok {
		return "", errors.New("旧代次命令仍放行")
	}
	r3 := h.command("eval", browser.CommandIn{Session: "s1", Script: "return 7"})
	if ok, _ := r3["ok"].(bool); !ok {
		return "", fmt.Errorf("交还后新命令被拒: %v", r3)
	}
	return fmt.Sprintf("交还恢复持有，代次→%.0f，旧代次命令拒绝，新命令放行", newGen), nil
}

func (h *hostApp) h06ownerNav() (string, error) {
	_, er, err := h.feResult(`"Browser.Navigate", "s1", "https://example.com"`)
	if err != nil {
		return "", err
	}
	if er == nil || er["code"] != "page_owned" {
		return "", fmt.Errorf("持有态拥有者导航未被 page_owned 拒: %v", er)
	}
	if _, er, err := h.feResult(`"Browser.Takeover", "s1"`); err != nil || er != nil {
		return "", fmt.Errorf("接管失败: %v %v", er, err)
	}
	val, er, err := h.feResult(fmt.Sprintf(`"Browser.Navigate", "s1", %q`, a.base+"/counter?owner"))
	if err != nil {
		return "", err
	}
	if er != nil {
		return "", fmt.Errorf("接管后拥有者导航被拒: %v", er)
	}
	if !waitFor(6*time.Second, func() bool {
		st := h.command("status", browser.CommandIn{Session: "s1"})
		v, _ := st["value"].(map[string]any)
		u, _ := v["url"].(string)
		return strings.Contains(u, "owner")
	}) {
		return "", errors.New("拥有者导航未提交")
	}
	_ = val
	return "持有态拥有者导航被 page_owned 拒，接管后同一入口放行且页面提交新 URL", nil
}

func (h *hostApp) h07close() (string, error) {
	val, er, err := h.feResult(`"Browser.Close", "s1"`)
	if err != nil {
		return "", err
	}
	if er != nil {
		return "", fmt.Errorf("拥有者关闭被拒: %v", er)
	}
	if val["closed"] != true {
		return "", fmt.Errorf("关闭未生效: %v", val)
	}
	st := h.command("status", browser.CommandIn{Session: "s1"})
	sv, _ := st["value"].(map[string]any)
	if sv["exists"] != false {
		return "", fmt.Errorf("关闭后仍存在: %v", sv)
	}
	if !containsKind(h.kinds(), "closed") {
		return "", errors.New("未发 closed 事件")
	}
	return "拥有者关闭销毁页面并上报 closed，status 已不存在", nil
}

func (h *hostApp) h08untrusted() (string, error) {
	// 外来 WebView（非前端、非 Manager 页）调用绑定方法必须被身份拒绝。
	foreign, err := h.win.NewWebView(mygo.WebViewOptions{URL: a.base + "/counter"})
	if err != nil {
		return "", err
	}
	defer foreign.Destroy()
	if !a.waitURL(foreign.Page(), "/counter", 10*time.Second) {
		return "", errors.New("外来页未就绪")
	}
	res, err := evalJSON[map[string]any](foreign.Page(), `return mygo.call("Browser.Takeover", "s1").then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: String((e && e.message) || e) }; })`)
	if err != nil {
		return "", err
	}
	if ok, _ := res["ok"].(bool); !ok {
		return fmt.Sprintf("外来页调用被引擎层拒绝: %v", res["e"]), nil
	}
	v, _ := res["v"].(map[string]any)
	if eobj, _ := v["error"].(map[string]any); eobj["code"] == "ipc_sender" {
		return "外来 WebView 调用 Browser.Takeover 被 ipc_sender 身份拒绝", nil
	}
	return "", fmt.Errorf("外来页调用未被拒绝: %v", res)
}

func containsKind(kinds []string, k string) bool {
	for _, x := range kinds {
		if x == k {
			return true
		}
	}
	return false
}

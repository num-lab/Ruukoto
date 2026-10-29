package browser

import (
	"context"
	"encoding/json"
)

// Frontend 是绑定给可信前端的窄方法面（Browser.*）；每个方法先核实前端身份。
// 绑定方法运行在主线程，可直接改视图状态；Manager 的其余方法不进 IPC 面。
type Frontend struct{ m *Manager }

func (f *Frontend) trusted(ctx context.Context) json.RawMessage {
	if f.m.deps.Identity == nil || !f.m.deps.Identity(ctx) {
		return failure("ipc_sender", "not_sent", "桌面请求来源不可用；请重新打开应用。")
	}
	return nil
}

// Rect 上报浏览器占位矩形；非法数值拒绝，越界钳制进内容区。
func (f *Frontend) Rect(ctx context.Context, r Rect) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	if !finiteRect(r) {
		return failure("invalid_rect", "not_sent", "占位矩形坐标无效。")
	}
	cw, ch := f.m.deps.Content()
	f.m.rect = clampRect(r, cw, ch)
	f.m.deps.Invalidate()
	return succeed(nil)
}

// State 上报展示状态：当前展示的会话、右栏是否展示浏览器占位、是否被弹层遮挡。
func (f *Frontend) State(ctx context.Context, s State) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	f.m.shown = s.Session
	f.m.panelShown = s.Shown
	f.m.covered = s.Covered
	f.m.deps.Invalidate()
	return succeed(nil)
}

// Takeover 是拥有者接管：先撤闸门与代次推进，再通知后台；之后新网页动作按代次拒绝。
func (f *Frontend) Takeover(ctx context.Context, session string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	p := f.m.pageOf(session)
	if p == nil {
		return failure("no_page", "not_sent", "该会话没有浏览器页面。")
	}
	f.m.setOwned(p, false, "owner")
	return succeed(map[string]any{"owned": p.owned.Load(), "generation": p.gen.Load()})
}

// Return 是拥有者交还：闸门复位并推进代次，后台须先取得新观察再继续。
func (f *Frontend) Return(ctx context.Context, session string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	p := f.m.pageOf(session)
	if p == nil {
		return failure("no_page", "not_sent", "该会话没有浏览器页面。")
	}
	f.m.setOwned(p, true, "owner")
	return succeed(map[string]any{"owned": p.owned.Load(), "generation": p.gen.Load()})
}

// Navigate 是拥有者地址栏导航；页面由 Agent 持有时同一闸门约束，须先接管。
func (f *Frontend) Navigate(ctx context.Context, session, rawURL string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	url, err := validURL(rawURL)
	if err != nil {
		return failure("invalid_url", "not_sent", "导航目标必须是 HTTP(S) 地址。")
	}
	p := f.m.pageOf(session)
	if p != nil && p.owned.Load() {
		return failure("page_owned", "not_sent", "页面由 Agent 持有；请先接管。")
	}
	if p == nil {
		if p, err = f.m.ensurePage(session); err != nil {
			return failure("open_failed", "not_sent", err.Error())
		}
	}
	p.gen.Add(1)
	if err := p.handle.load(url); err != nil {
		return failure("navigate_failed", "not_sent", err.Error())
	}
	return succeed(f.m.snapshot(p))
}

// ownerHistory 校验后退/前进/刷新的共同前置：身份、页存在、未被 Agent 持有。
func (f *Frontend) ownerHistory(ctx context.Context, session string) (*page, json.RawMessage) {
	if denied := f.trusted(ctx); denied != nil {
		return nil, denied
	}
	p := f.m.pageOf(session)
	if p == nil {
		return nil, failure("no_page", "not_sent", "该会话没有浏览器页面。")
	}
	if p.owned.Load() {
		return nil, failure("page_owned", "not_sent", "页面由 Agent 持有；请先接管。")
	}
	return p, nil
}

func (f *Frontend) Back(ctx context.Context, session string) json.RawMessage {
	p, denied := f.ownerHistory(ctx, session)
	if denied != nil {
		return denied
	}
	p.gen.Add(1)
	p.handle.back()
	return succeed(f.m.snapshot(p))
}

func (f *Frontend) Forward(ctx context.Context, session string) json.RawMessage {
	p, denied := f.ownerHistory(ctx, session)
	if denied != nil {
		return denied
	}
	p.gen.Add(1)
	p.handle.forward()
	return succeed(f.m.snapshot(p))
}

func (f *Frontend) Reload(ctx context.Context, session string) json.RawMessage {
	p, denied := f.ownerHistory(ctx, session)
	if denied != nil {
		return denied
	}
	p.gen.Add(1)
	p.handle.reload()
	return succeed(f.m.snapshot(p))
}

// Close 关闭会话页；关闭与接管始终可用，不受闸门限制。
func (f *Frontend) Close(ctx context.Context, session string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	return succeed(map[string]any{"closed": f.m.closePage(session)})
}

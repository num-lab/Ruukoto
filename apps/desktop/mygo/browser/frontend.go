package browser

import (
	"context"
	"encoding/json"
)

// Frontend is the narrow method surface bound to the trusted front end (Browser.*); every method verifies front-end identity first.
// Bound methods run on the main thread and may change view state directly; the rest of Manager never enters the IPC surface.
type Frontend struct{ m *Manager }

func (f *Frontend) trusted(ctx context.Context) json.RawMessage {
	if f.m.deps.Identity == nil || !f.m.deps.Identity(ctx) {
		return failure("ipc_sender", "not_sent", "The desktop request source is unavailable; reopen the app.")
	}
	return nil
}

// Rect reports the browser placeholder rect; invalid values are rejected and out-of-range is clamped to the content area.
func (f *Frontend) Rect(ctx context.Context, r Rect) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	if !finiteRect(r) {
		return failure("invalid_rect", "not_sent", "Invalid placeholder rect coordinates.")
	}
	cw, ch := f.m.deps.Content()
	f.m.rect = clampRect(r, cw, ch)
	f.m.deps.Invalidate()
	return succeed(nil)
}

// State reports the display state: the chat being shown, whether the right panel shows a browser placeholder, and whether a popup occludes it.
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

// Takeover interrupts an active Agent claim; idle pages need no takeover.
func (f *Frontend) Takeover(ctx context.Context, session string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	p := f.m.pageOf(session)
	if p == nil {
		return failure("no_page", "not_sent", "This chat has no browser page.")
	}
	if !p.owned.Load() || p.gone.Load() {
		return failure("not_owned", "not_sent", "The Agent isn't using this page.")
	}
	f.m.setOwned(p, false, "owner")
	return succeed(map[string]any{"owned": p.owned.Load(), "generation": p.gen.Load()})
}

// Return resumes the interrupted claim and requires a fresh Agent observation.
func (f *Frontend) Return(ctx context.Context, session string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	p := f.m.pageOf(session)
	if p == nil {
		return failure("no_page", "not_sent", "This chat has no browser page.")
	}
	if !p.ownerHeld.Load() || p.gone.Load() {
		return failure("not_held", "not_sent", "This page has nothing to return.")
	}
	f.m.setOwned(p, true, "owner")
	return succeed(map[string]any{"owned": p.owned.Load(), "generation": p.gen.Load()})
}

// Navigate is owner address-bar navigation; while the Agent holds the page the same gate applies — take over first.
func (f *Frontend) Navigate(ctx context.Context, session, rawURL string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	url, err := validURL(rawURL)
	if err != nil {
		return failure("invalid_url", "not_sent", "The navigation target must be an HTTP(S) URL.")
	}
	p := f.m.pageOf(session)
	if p != nil && !p.gone.Load() && p.owned.Load() {
		return failure("page_owned", "not_sent", "The Agent holds this page; take over first.")
	}
	if p == nil || p.gone.Load() {
		if p, err = f.m.ensurePage(session); err != nil {
			return failure("open_failed", "not_sent", err.Error())
		}
	}
	f.m.advance(p)
	if err := p.handle.load(url); err != nil {
		return failure("navigate_failed", "not_sent", err.Error())
	}
	return succeed(f.m.snapshot(p))
}

// ownerHistory verifies the shared preconditions of back/forward/refresh: identity, page exists, not held by the Agent.
func (f *Frontend) ownerHistory(ctx context.Context, session string) (*page, json.RawMessage) {
	if denied := f.trusted(ctx); denied != nil {
		return nil, denied
	}
	p := f.m.pageOf(session)
	if p == nil {
		return nil, failure("no_page", "not_sent", "This chat has no browser page.")
	}
	if p.owned.Load() {
		return nil, failure("page_owned", "not_sent", "The Agent holds this page; take over first.")
	}
	return p, nil
}

func (f *Frontend) Back(ctx context.Context, session string) json.RawMessage {
	p, denied := f.ownerHistory(ctx, session)
	if denied != nil {
		return denied
	}
	f.m.advance(p)
	p.handle.back()
	return succeed(f.m.snapshot(p))
}

func (f *Frontend) Forward(ctx context.Context, session string) json.RawMessage {
	p, denied := f.ownerHistory(ctx, session)
	if denied != nil {
		return denied
	}
	f.m.advance(p)
	p.handle.forward()
	return succeed(f.m.snapshot(p))
}

func (f *Frontend) Reload(ctx context.Context, session string) json.RawMessage {
	p, denied := f.ownerHistory(ctx, session)
	if denied != nil {
		return denied
	}
	f.m.advance(p)
	p.handle.reload()
	return succeed(f.m.snapshot(p))
}

// Close closes the chat page; close and take-over are always available regardless of the gate.
func (f *Frontend) Close(ctx context.Context, session string) json.RawMessage {
	if denied := f.trusted(ctx); denied != nil {
		return denied
	}
	return succeed(map[string]any{"closed": f.m.closePage(session)})
}

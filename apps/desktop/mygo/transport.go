package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const maxFrameBytes = 16 * 1024 * 1024

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md
// 已写入管道的请求无法推断是否执行；传输失败不能降为 not_sent 或自动重放。
type sidecar struct {
	mu       sync.Mutex
	writeMu  sync.Mutex
	eventMu  sync.Mutex
	stdin    io.WriteCloser
	cmd      *exec.Cmd
	next     uint64
	pending  map[uint64]*pendingCall
	closed   bool
	stopping bool
	done     chan struct{}
	onEvent  func(json.RawMessage)
}

type pendingCall struct {
	result  chan json.RawMessage
	started bool
	sent    bool
}

type wireMessage struct {
	Kind   string          `json:"kind"`
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
}

func failure(code, outcome, message string) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]string{"code": code, "outcome": outcome, "message": message}})
	return data
}

func disconnected() json.RawMessage {
	return failure("bridge_disconnected", "disconnected", "MyGo 连接已关闭；请重新打开应用，原操作结果仍需核实。")
}

func startSidecar(cmd *exec.Cmd, onEvent func(json.RawMessage)) (*sidecar, error) {
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		input.Close()
		output.Close()
		return nil, err
	}
	s := &sidecar{stdin: input, cmd: cmd, pending: make(map[uint64]*pendingCall), done: make(chan struct{}), onEvent: onEvent}
	go func() {
		s.read(output)
		output.Close()
		if err := cmd.Wait(); err != nil {
			os.Stderr.WriteString("[ruukoto:desktop] MyGo 子进程已退出；请重新打开应用并核实原操作。\n")
		}
		close(s.done)
	}()
	return s, nil
}

func (s *sidecar) read(output io.Reader) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64*1024), maxFrameBytes)
	for scanner.Scan() {
		data := append(json.RawMessage(nil), scanner.Bytes()...)
		var message wireMessage
		if json.Unmarshal(data, &message) != nil {
			break
		}
		if message.Kind == "result" && message.ID != 0 && len(message.Result) != 0 {
			s.mu.Lock()
			waiting := s.pending[message.ID]
			delete(s.pending, message.ID)
			s.mu.Unlock()
			if waiting != nil {
				waiting.result <- message.Result
			}
		} else if message.Kind == "update" || message.Kind == "notice" || message.Kind == "badge" {
			s.eventMu.Lock()
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				s.onEvent(data)
			}
			s.eventMu.Unlock()
			if closed {
				return
			}
		} else {
			break
		}
	}
	s.fail()
	// 坏帧与 EOF 同样停止输入，让 Node 回收 SSH；不继续消费不可信传输。
	s.stdin.Close()
}

func (s *sidecar) fail() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	stopping := s.stopping
	for id, waiting := range s.pending {
		result := disconnected()
		if !waiting.started {
			result = failure("bridge_closed", "not_sent", "MyGo 连接不可用，请重新打开应用后核实原操作。")
		}
		waiting.result <- result
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if stopping {
		return
	}
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	for _, target := range []string{"code", "personal"} {
		data, _ := json.Marshal(map[string]any{"kind": "update", "target": target, "update": map[string]any{"type": "state", "state": "failed", "error": json.RawMessage(extractFailure(disconnected()))}})
		s.onEvent(data)
	}
}

func extractFailure(result json.RawMessage) json.RawMessage {
	var value struct {
		Error json.RawMessage `json:"error"`
	}
	json.Unmarshal(result, &value)
	return value.Error
}

func (s *sidecar) call(ctx context.Context, method string, args ...any) json.RawMessage {
	s.mu.Lock()
	if s.closed || s.stopping && method != "close" {
		s.mu.Unlock()
		return failure("bridge_closed", "not_sent", "MyGo 连接不可用，请重新打开应用后核实原操作。")
	}
	s.next++
	id := s.next
	if args == nil {
		args = []any{}
	}
	data, err := json.Marshal(map[string]any{"id": id, "method": method, "args": args})
	if err != nil || len(data) >= maxFrameBytes {
		s.mu.Unlock()
		return failure("bridge_invalid", "not_sent", "MyGo 请求无法编码或超过大小限制，操作未发送。")
	}
	waiting := &pendingCall{result: make(chan json.RawMessage, 1)}
	s.pending[id] = waiting
	s.mu.Unlock()
	// 写管道不能持有状态锁；Node 停止读取时，退出仍能关闭管道并回收进程。
	go func() {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		s.mu.Lock()
		if s.closed || s.pending[id] != waiting {
			s.mu.Unlock()
			return
		}
		waiting.started = true
		s.mu.Unlock()
		_, writeErr := s.stdin.Write(append(data, '\n'))
		s.mu.Lock()
		waiting.sent = writeErr == nil
		s.mu.Unlock()
		if writeErr != nil {
			s.fail()
			s.stdin.Close()
		}
	}()
	deadline := time.NewTimer(60 * time.Second)
	defer deadline.Stop()
	timedOut := false
	select {
	case result := <-waiting.result:
		return result
	case <-ctx.Done():
	case <-deadline.C:
		timedOut = true
	}
	s.mu.Lock()
	delete(s.pending, id)
	started, writing := waiting.started, waiting.started && !waiting.sent
	s.mu.Unlock()
	if writing || timedOut {
		s.fail()
		s.stdin.Close()
	}
	if !started {
		return failure("bridge_timeout", "not_sent", "MyGo 请求未交付，操作未发送。")
	}
	return failure("bridge_timeout", "unknown", "MyGo 请求未能取得应答；请核实原操作，勿重复发送。")
}

func (s *sidecar) close() {
	s.mu.Lock()
	s.stopping = true
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	s.call(ctx, "close")
	cancel()
	s.stdin.Close()
	select {
	case <-s.done:
		return
	case <-time.After(3 * time.Second):
	}
	if err := s.cmd.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		os.Stderr.WriteString("[ruukoto:desktop] MyGo 子进程停止失败，正在强制回收。\n")
	}
	select {
	case <-s.done:
		return
	case <-time.After(3 * time.Second):
	}
	if err := s.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		os.Stderr.WriteString("[ruukoto:desktop] MyGo 子进程强制回收失败；请检查仍运行的进程。\n")
	}
	select {
	case <-s.done:
	case <-time.After(time.Second):
		os.Stderr.WriteString("[ruukoto:desktop] MyGo 子进程仍未退出；请检查仍运行的进程。\n")
	}
}

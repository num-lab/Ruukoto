package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
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

// Note: See .agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md
// A request already written to the pipe can't be proven unexecuted; a transport failure must not downgrade to not_sent or auto-replay.
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
	onFail   func()
	// Capture request identity in receipt order, then run the prepared work asynchronously.
	onRequest         func(method string, args json.RawMessage) func() json.RawMessage
	credentials       credentialStore
	generation        string
	credentialLast    uint64
	credentialPending int
	credentialWG      sync.WaitGroup
	requestTimeout    time.Duration
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

func startSidecar(cmd *exec.Cmd, onEvent func(json.RawMessage), onRequest func(method string, args json.RawMessage) func() json.RawMessage, stores ...credentialStore) (*sidecar, error) {
	var credentials credentialStore
	var generation string
	if len(stores) != 0 {
		credentials = stores[0]
		bytes := make([]byte, 16)
		if _, err := rand.Read(bytes); err != nil {
			return nil, err
		}
		generation = hex.EncodeToString(bytes)
	}
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
	s := &sidecar{stdin: input, cmd: cmd, pending: make(map[uint64]*pendingCall), done: make(chan struct{}), onEvent: onEvent, onRequest: onRequest, credentials: credentials, generation: generation}
	go func() {
		s.read(output)
		output.Close()
		if err := cmd.Wait(); err != nil {
			os.Stderr.WriteString("[ruukoto:desktop] The MyGo subprocess exited; reopen the app and verify the original operation.\n")
		}
		close(s.done)
	}()
	if credentials != nil {
		s.writePrivate(map[string]any{"kind": "credential_ready", "v": 1, "generation": generation})
	}
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
		if message.Kind == "credential_request" {
			if !s.receiveCredential(data) {
				break
			}
			continue
		}
		if message.Kind == "request" {
			var request struct {
				Method string          `json:"method"`
				Args   json.RawMessage `json:"args"`
			}
			if json.Unmarshal(data, &request) != nil || request.Method == "" {
				break
			}
			s.mu.Lock()
			handler, closed, stopping := s.onRequest, s.closed, s.stopping
			s.mu.Unlock()
			if handler == nil || closed || stopping && request.Method != "output_close_preview" {
				s.writeFrame(map[string]any{"kind": "response", "id": message.ID, "result": failure("bridge_closed", "not_sent", "MyGo 连接不可用，请重新打开应用后核实原操作。")}, true)
				continue
			}
			id := message.ID
			run := handler(request.Method, request.Args)
			go func() {
				result := run()
				// Note: See .agents/notes/implemented/architecture/2026-11-05-personal-final-outputs.md
				s.writeFrame(map[string]any{"kind": "response", "id": id, "result": result}, request.Method == "output_close_preview")
			}()
			continue
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
	// Bad frames stop input the same as EOF so Node reclaims SSH; don't keep consuming an untrusted transport.
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
	onFail := s.onFail
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
	if onFail != nil {
		onFail()
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
	timeout := s.requestTimeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	s.mu.Unlock()
	// Note: See .agents/notes/implemented/architecture/2026-11-05-personal-final-outputs.md
	humanWait := method == "request" && len(args) == 3 && args[0] == "personal" && args[1] == "desktop_personal_output_save"
	// Note: See .agents/notes/implemented/architecture/2026-11-07-personal-inbound-attachments.md
	// PA uploads are finite; each authenticated chunk retains its own request deadline.
	uploadWait := method == "attachments" && len(args) == 4 && args[3] == "personal"
	written := make(chan struct{})
	// Do not hold the state lock while writing; shutdown must still close a blocked pipe.
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
		} else {
			close(written)
		}
	}()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	deadlineC := deadline.C
	timedOut := false
wait:
	for {
		select {
		case result := <-waiting.result:
			return result
		case <-written:
			written = nil
			if humanWait || uploadWait {
				// Pipe writes stay bounded; cancellation remains available while the owner chooses.
				deadline.Stop()
				deadlineC = nil
			}
		case <-ctx.Done():
			break wait
		case <-deadlineC:
			s.mu.Lock()
			delivered := (humanWait || uploadWait) && waiting.sent
			s.mu.Unlock()
			if delivered {
				deadlineC = nil
				continue
			}
			timedOut = true
			break wait
		}
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
	defer s.credentialWG.Wait()
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
		os.Stderr.WriteString("[ruukoto:desktop] The MyGo subprocess stop failed; force-reaping.\n")
	}
	select {
	case <-s.done:
		return
	case <-time.After(3 * time.Second):
	}
	if err := s.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		os.Stderr.WriteString("[ruukoto:desktop] The MyGo subprocess force-reap failed; check still-running processes.\n")
	}
	select {
	case <-s.done:
	case <-time.After(time.Second):
		os.Stderr.WriteString("[ruukoto:desktop] The MyGo subprocess exit is still unverified and the instance lock stays; check still-running processes.\n")
		<-s.done
	}
}

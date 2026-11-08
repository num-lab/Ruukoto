package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ruukoto-desktop-mygo/browser"
)

func TestSidecarProcess(t *testing.T) {
	if os.Getenv("RUUKOTO_MYGO_TEST_CHILD") != "1" {
		return
	}
	input := bufio.NewScanner(os.Stdin)
	var generation string
	var credentialCall uint64
	for input.Scan() {
		var private struct {
			Kind       string          `json:"kind"`
			Generation string          `json:"generation"`
			Result     json.RawMessage `json:"result"`
		}
		if json.Unmarshal(input.Bytes(), &private) != nil {
			os.Exit(4)
		}
		if private.Kind == "credential_ready" {
			generation = private.Generation
			continue
		}
		if private.Kind == "credential_result" {
			fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":%s}\n", credentialCall, private.Result)
			continue
		}
		var request struct {
			ID     uint64            `json:"id"`
			Method string            `json:"method"`
			Args   []json.RawMessage `json:"args"`
		}
		if json.Unmarshal(input.Bytes(), &request) != nil || request.Args == nil {
			os.Exit(4)
		}
		switch request.Method {
		case "close":
			if os.Getenv("RUUKOTO_MYGO_TEST_PREVIEW") == "" {
				fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":{\"ok\":true}}\n", request.ID)
				continue
			}
			for index, method := range []string{"browser_command", "output_choose", "output_preview", "output_close_preview"} {
				id := request.ID + uint64(index) + 100
				fmt.Printf("{\"kind\":\"request\",\"id\":%d,\"method\":%q,\"args\":[1]}\n", id, method)
				if !input.Scan() {
					os.Exit(6)
				}
				var response struct {
					ID     uint64 `json:"id"`
					Result struct {
						OK bool `json:"ok"`
					} `json:"result"`
				}
				if json.Unmarshal(input.Bytes(), &response) != nil || response.ID != id || response.Result.OK != (method == "output_close_preview") {
					os.Exit(7)
				}
			}
			if err := os.RemoveAll(os.Getenv("RUUKOTO_MYGO_TEST_PREVIEW")); err != nil {
				os.Exit(8)
			}
			fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":{\"ok\":true}}\n", request.ID)
			continue
		case "attachments":
			go func(id uint64) {
				time.Sleep(200 * time.Millisecond)
				fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":{\"ok\":true,\"value\":[]}}\n", id)
			}(request.ID)
			continue
		case "browser_event":
			// Echo receipt order before acknowledging each event.
			fmt.Printf("{\"kind\":\"update\",\"value\":%s}\n", request.Args[0])
			fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":{\"ok\":true}}\n", request.ID)
			continue
		case "request":
			if len(request.Args) != 3 {
				os.Exit(8)
			}
			if strings.Contains(string(request.Args[2]), `"hold":true`) {
				continue
			}
			go func(id uint64) {
				time.Sleep(200 * time.Millisecond)
				fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":{\"ok\":true,\"value\":{\"state\":\"saved\"}}}\n", id)
			}(request.ID)
			continue
		case "credentials", "bad-credentials":
			credentialCall = request.ID
			if request.Method == "bad-credentials" {
				generation = "wrong-generation"
			}
			fmt.Printf("{\"kind\":\"credential_request\",\"v\":1,\"generation\":%q,\"id\":%d,\"op\":\"read\"}\n", generation, request.ID)
			continue
		case "late":
			os.Stdin.Close()
			fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":{\"ok\":true}}\n", request.ID)
			time.Sleep(100 * time.Millisecond)
			fmt.Println(`{"kind":"update","target":"code","update":{"type":"state","state":"online"}}`)
			os.Exit(0)
		case "ask_browser":
			fmt.Printf("{\"kind\":\"request\",\"id\":%d,\"method\":\"browser_command\",\"args\":[{\"op\":\"status\",\"session\":\"s1\"}]}\n", request.ID)
			if !input.Scan() {
				os.Exit(6)
			}
			var response struct {
				ID     uint64          `json:"id"`
				Result json.RawMessage `json:"result"`
			}
			if json.Unmarshal(input.Bytes(), &response) != nil || response.ID != request.ID {
				os.Exit(7)
			}
			fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":%s}\n", request.ID, response.Result)
			continue
		case "die":
			os.Exit(9)
		case "malformed":
			fmt.Println("not-json")
		case "oversize":
			fmt.Println(strings.Repeat("x", maxFrameBytes+1))
		case "wait":
			continue
		default:
			value := json.RawMessage(`null`)
			if len(request.Args) != 0 {
				value = request.Args[0]
			}
			fmt.Printf("{\"kind\":\"result\",\"id\":%d,\"result\":{\"ok\":true,\"value\":%s}}\n", request.ID, value)
		}
	}
	if marker := os.Getenv("RUUKOTO_MYGO_TEST_EOF"); marker != "" {
		if err := os.WriteFile(marker, []byte("closed"), 0o600); err != nil {
			os.Exit(5)
		}
	}
	os.Exit(0)
}

func testChild(t *testing.T, event func(json.RawMessage)) *sidecar {
	t.Helper()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(program, "-test.run=^TestSidecarProcess$")
	cmd.Env = append(os.Environ(), "RUUKOTO_MYGO_TEST_CHILD=1")
	child, err := startSidecar(cmd, event, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.close)
	return child
}

func TestBrowserEventsKeepTakeoverAndReturnOrder(t *testing.T) {
	seen := make(chan uint64, 20)
	child := testChild(t, func(raw json.RawMessage) {
		var event struct {
			Value browser.Event `json:"value"`
		}
		if json.Unmarshal(raw, &event) == nil {
			seen <- event.Value.Generation
		}
	})
	desktop := &Desktop{child: child}
	for generation := uint64(1); generation <= 20; generation++ {
		owned := generation%2 == 0
		desktop.browserEvent(browser.Event{Session: "current", Kind: "gate", Source: "owner", Owned: &owned, Generation: generation})
	}
	for generation := uint64(1); generation <= 20; generation++ {
		select {
		case got := <-seen:
			if got != generation {
				t.Fatalf("event order: got %d, want %d", got, generation)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("browser event did not arrive")
		}
	}
	<-desktop.browserTail
}

func outcome(t *testing.T, result json.RawMessage) string {
	t.Helper()
	var value struct {
		OK    bool `json:"ok"`
		Error struct {
			Outcome string `json:"outcome"`
		} `json:"error"`
	}
	if err := json.Unmarshal(result, &value); err != nil || value.OK {
		t.Fatalf("expected failure: %s, %v", result, err)
	}
	return value.Error.Outcome
}

func TestSidecarRawJSONAndConcurrentRequests(t *testing.T) {
	child := testChild(t, func(json.RawMessage) {})
	var group sync.WaitGroup
	for i := range 8 {
		group.Go(func() {
			value := json.RawMessage(fmt.Sprintf(`{"seq":9007199254740993,"text":"请求 %d\\n"}`, i))
			result := child.call(context.Background(), "echo", value)
			if !strings.Contains(string(result), string(value)) {
				t.Errorf("raw JSON changed: %s", result)
			}
		})
	}
	group.Wait()
}

func TestSidecarDeliveredFailureAndNoReplay(t *testing.T) {
	for _, method := range []string{"die", "malformed", "oversize"} {
		t.Run(method, func(t *testing.T) {
			events := make(chan json.RawMessage, 4)
			child := testChild(t, func(data json.RawMessage) { events <- data })
			if got := outcome(t, child.call(context.Background(), method)); got != "disconnected" {
				t.Fatal(got)
			}
			if got := outcome(t, child.call(context.Background(), "write")); got != "not_sent" {
				t.Fatal(got)
			}
			select {
			case update := <-events:
				if !strings.Contains(string(update), `"state":"failed"`) {
					t.Fatal(string(update))
				}
			case <-time.After(time.Second):
				t.Fatal("missing failed update")
			}
		})
	}
}

func TestSidecarCanceledCallIsUnknown(t *testing.T) {
	child := testChild(t, func(json.RawMessage) {})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if got := outcome(t, child.call(ctx, "wait")); got != "unknown" {
		t.Fatal(got)
	}
	if result := child.call(context.Background(), "echo", "still alive"); !strings.Contains(string(result), "still alive") {
		t.Fatal(string(result))
	}
}

func TestSidecarNativeSaveWaitsAfterDelivery(t *testing.T) {
	child := testChild(t, func(json.RawMessage) {})
	child.requestTimeout = 30 * time.Millisecond
	result := make(chan json.RawMessage, 1)
	go func() {
		result <- child.call(context.Background(), "request", "personal", "desktop_personal_output_save", json.RawMessage(`{}`))
	}()
	select {
	case value := <-result:
		t.Fatalf("human choice ended at the request deadline: %s", value)
	case <-time.After(90 * time.Millisecond):
	}
	if value := child.call(context.Background(), "focus", true); !strings.Contains(string(value), `"ok":true`) {
		t.Fatalf("human choice blocked another request: %s", value)
	}
	select {
	case value := <-result:
		if !strings.Contains(string(value), `"state":"saved"`) {
			t.Fatal(string(value))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("human choice never completed")
	}
}

func TestSidecarPersonalUploadWaitsAfterDelivery(t *testing.T) {
	child := testChild(t, func(json.RawMessage) {})
	child.requestTimeout = 30 * time.Millisecond
	result := make(chan json.RawMessage, 1)
	go func() {
		result <- child.call(context.Background(), "attachments", "draft", []string{"selected.bin"}, "identity", "personal")
	}()
	select {
	case value := <-result:
		t.Fatalf("finite upload ended at generic deadline: %s", value)
	case <-time.After(90 * time.Millisecond):
	}
	if value := child.call(context.Background(), "focus", true); !strings.Contains(string(value), `"ok":true`) {
		t.Fatalf("upload blocked unrelated request: %s", value)
	}
	select {
	case value := <-result:
		if !strings.Contains(string(value), `"ok":true`) {
			t.Fatal(string(value))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("finite upload never completed")
	}
}

func TestSidecarNativeSaveCancellationAndClose(t *testing.T) {
	child := testChild(t, func(json.RawMessage) {})
	child.requestTimeout = 30 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan json.RawMessage, 1)
	go func() {
		result <- child.call(ctx, "request", "personal", "desktop_personal_output_save", json.RawMessage(`{"hold":true}`))
	}()
	time.Sleep(90 * time.Millisecond)
	cancel()
	if got := outcome(t, <-result); got != "unknown" {
		t.Fatal(got)
	}
	go func() {
		result <- child.call(context.Background(), "request", "personal", "desktop_personal_output_save", json.RawMessage(`{"hold":true}`))
	}()
	time.Sleep(90 * time.Millisecond)
	child.close()
	select {
	case value := <-result:
		if got := outcome(t, value); got != "disconnected" {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("close left the native choice pending")
	}
}

func TestSidecarOrdinaryRequestsKeepTheirDeadline(t *testing.T) {
	for _, args := range [][]any{{"code", "desktop_personal_output_save", json.RawMessage(`{}`)}, {"personal", "desktop_personal_output_preview", json.RawMessage(`{}`)}} {
		child := testChild(t, func(json.RawMessage) {})
		child.requestTimeout = 30 * time.Millisecond
		if got := outcome(t, child.call(context.Background(), "request", args...)); got != "unknown" {
			t.Fatal(got)
		}
		if got := outcome(t, child.call(context.Background(), "focus", true)); got != "not_sent" {
			t.Fatal("ordinary timeout did not close the transport", got)
		}
	}
}

func TestSidecarNativeSaveKeepsPipeWriteDeadline(t *testing.T) {
	child, err := startSidecar(exec.Command("/bin/sleep", "30"), func(json.RawMessage) {}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.close)
	child.requestTimeout = 100 * time.Millisecond
	started := time.Now()
	if got := outcome(t, child.call(context.Background(), "request", "personal", "desktop_personal_output_save", strings.Repeat("x", 1024*1024))); got != "unknown" {
		t.Fatal(got)
	}
	if time.Since(started) > time.Second {
		t.Fatal("native save disabled the pipe write deadline")
	}
	if err := child.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-child.done
}

func TestSidecarShutdownFinishesOnlyOriginalPreviewCleanup(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(t.TempDir(), "ruukoto-output-preview")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "final.png"), []byte("original preview"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(program, "-test.run=^TestSidecarProcess$")
	cmd.Env = append(os.Environ(), "RUUKOTO_MYGO_TEST_CHILD=1", "RUUKOTO_MYGO_TEST_PREVIEW="+directory)
	invoked := make(chan string, 4)
	var child *sidecar
	child, err = startSidecar(cmd, func(json.RawMessage) {}, func(method string, _ json.RawMessage) func() json.RawMessage {
		return func() json.RawMessage {
			invoked <- method
			child.writePrivate(map[string]any{"kind": "credential_result", "id": 99})
			return json.RawMessage(`{"ok":true,"value":null}`)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.close)
	child.close()
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("verified preview was not reclaimed", err)
	}
	if method := <-invoked; method != "output_close_preview" {
		t.Fatal(method)
	}
	select {
	case method := <-invoked:
		t.Fatal("shutdown executed new work", method)
	default:
	}
}

func TestSidecarEOFAndMissingNode(t *testing.T) {
	marker := t.TempDir() + "/closed"
	t.Setenv("RUUKOTO_MYGO_TEST_EOF", marker)
	child := testChild(t, func(data json.RawMessage) { t.Errorf("normal exit published failure: %s", data) })
	child.close()
	if data, err := os.ReadFile(marker); err != nil || string(data) != "closed" {
		t.Fatalf("EOF cleanup: %s, %v", data, err)
	}
	if _, err := startSidecar(exec.Command(t.TempDir()+"/missing-node"), func(json.RawMessage) {}, nil); err == nil {
		t.Fatal("missing Node accepted")
	}
}

func TestSidecarBrowserRequest(t *testing.T) {
	child := testChild(t, func(json.RawMessage) {})
	var gotMethod string
	var gotArgs json.RawMessage
	child.mu.Lock()
	child.onRequest = func(method string, args json.RawMessage) func() json.RawMessage {
		gotMethod = method
		gotArgs = append(json.RawMessage(nil), args...)
		return func() json.RawMessage { return json.RawMessage(`{"ok":true,"value":{"generation":3}}`) }
	}
	child.mu.Unlock()
	result := child.call(context.Background(), "ask_browser")
	if !strings.Contains(string(result), `"generation":3`) {
		t.Fatalf("response lost: %s", result)
	}
	if gotMethod != "browser_command" || !strings.Contains(string(gotArgs), `"session":"s1"`) {
		t.Fatalf("request mangled: %s %s", gotMethod, gotArgs)
	}
	// A connection without a handler rejects requests as bridge_closed instead of hanging
	plain := testChild(t, func(json.RawMessage) {})
	if got := outcome(t, plain.call(context.Background(), "ask_browser")); got != "not_sent" {
		t.Fatal(got)
	}
}

func TestExternalURLs(t *testing.T) {
	for _, value := range []string{"file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com", "https:///missing", "invalid"} {
		if externalURL(value) != "" {
			t.Fatal(value)
		}
	}
	if externalURL("https://example.com/path") != "https://example.com/path" {
		t.Fatal("HTTP(S) link rejected")
	}
}

func TestSidecarBlockedWriteCanCancelAndClose(t *testing.T) {
	child, err := startSidecar(exec.Command("/bin/sleep", "30"), func(json.RawMessage) {}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.close)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan json.RawMessage, 1)
	go func() { result <- child.call(ctx, "write", strings.Repeat("x", 1024*1024)) }()
	deadline := time.After(2 * time.Second)
	for {
		child.mu.Lock()
		started := false
		for _, pending := range child.pending {
			started = started || pending.started
		}
		child.mu.Unlock()
		if started {
			break
		}
		select {
		case <-deadline:
			t.Fatal("fixture pipe write did not start")
		case <-time.After(time.Millisecond):
		}
	}
	started := time.Now()
	cancel()
	if got := outcome(t, <-result); got != "unknown" {
		t.Fatal(got)
	}
	if time.Since(started) > time.Second {
		t.Fatal("pipe write ignored cancellation")
	}
	child.stdin.Close()
	if err := child.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-child.done:
	case <-time.After(time.Second):
		t.Fatal("blocked writer prevented exit")
	}
}

func TestSidecarClosedTransportDiscardsLateUpdates(t *testing.T) {
	var mu sync.Mutex
	var events []string
	child := testChild(t, func(data json.RawMessage) { mu.Lock(); events = append(events, string(data)); mu.Unlock() })
	child.call(context.Background(), "late")
	if got := outcome(t, child.call(context.Background(), "write")); got != "disconnected" {
		t.Fatal(got)
	}
	<-child.done
	mu.Lock()
	defer mu.Unlock()
	for _, event := range events {
		if strings.Contains(event, `"state":"online"`) {
			t.Fatal("closed transport forwarded stale online")
		}
	}
}

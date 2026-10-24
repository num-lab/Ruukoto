package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
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
	child, err := startSidecar(cmd, event)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.close)
	return child
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

func TestSidecarEOFAndMissingNode(t *testing.T) {
	marker := t.TempDir() + "/closed"
	t.Setenv("RUUKOTO_MYGO_TEST_EOF", marker)
	child := testChild(t, func(data json.RawMessage) { t.Errorf("normal exit published failure: %s", data) })
	child.close()
	if data, err := os.ReadFile(marker); err != nil || string(data) != "closed" {
		t.Fatalf("EOF cleanup: %s, %v", data, err)
	}
	if _, err := startSidecar(exec.Command(t.TempDir()+"/missing-node"), func(json.RawMessage) {}); err == nil {
		t.Fatal("missing Node accepted")
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
	child, err := startSidecar(exec.Command("/bin/sleep", "30"), func(json.RawMessage) {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.close)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	if got := outcome(t, child.call(ctx, "write", strings.Repeat("x", 1024*1024))); got != "unknown" {
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

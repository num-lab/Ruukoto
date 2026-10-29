package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeCredentials struct {
	entered chan struct{}
	release chan struct{}
	calls   atomic.Int32
	fail    bool
}

func (f *fakeCredentials) request(string, *string) (*string, error) {
	f.calls.Add(1)
	if f.entered != nil {
		close(f.entered)
	}
	if f.release != nil {
		<-f.release
	}
	if f.fail {
		return nil, errors.New("secret-error-must-not-leak")
	}
	value := "private-test-secret"
	return &value, nil
}
func credentialChild(t *testing.T, store credentialStore) *sidecar {
	t.Helper()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(program, "-test.run=^TestSidecarProcess$")
	cmd.Env = append(os.Environ(), "RUUKOTO_MYGO_TEST_CHILD=1")
	child, err := startSidecar(cmd, func(data json.RawMessage) {
		if strings.Contains(string(data), "secret") || strings.Contains(string(data), "credential_") {
			t.Errorf("private frame emitted: %s", data)
		}
	}, nil, store)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.close)
	return child
}
func TestCredentialsDoNotBlockReadLoopOrReachEvents(t *testing.T) {
	store := &fakeCredentials{entered: make(chan struct{}), release: make(chan struct{})}
	child := credentialChild(t, store)
	result := make(chan json.RawMessage, 1)
	go func() { result <- child.call(context.Background(), "credentials") }()
	select {
	case <-store.entered:
	case <-time.After(time.Second):
		t.Fatal("storage not called")
	}
	if value := child.call(context.Background(), "echo", "still reading"); !strings.Contains(string(value), "still reading") {
		t.Fatal("read loop blocked")
	}
	close(store.release)
	select {
	case value := <-result:
		if !strings.Contains(string(value), "private-test-secret") {
			t.Fatal("missing private response")
		}
	case <-time.After(time.Second):
		t.Fatal("missing response")
	}
}
func TestCredentialFailureAndWrongGenerationFailClosed(t *testing.T) {
	store := &fakeCredentials{fail: true}
	child := credentialChild(t, store)
	result := string(child.call(context.Background(), "credentials"))
	if !strings.Contains(result, "personal_credentials_unavailable") || strings.Contains(result, "secret-error") {
		t.Fatal("unsafe failure")
	}
	other := &fakeCredentials{}
	bad := credentialChild(t, other)
	if got := outcome(t, bad.call(context.Background(), "bad-credentials")); got != "disconnected" {
		t.Fatal(got)
	}
	if other.calls.Load() != 0 {
		t.Fatal("wrong generation reached storage")
	}
}
func TestClosingWaitsForAcceptedCredentialOperation(t *testing.T) {
	store := &fakeCredentials{entered: make(chan struct{}), release: make(chan struct{})}
	child := credentialChild(t, store)
	go child.call(context.Background(), "credentials")
	select {
	case <-store.entered:
	case <-time.After(time.Second):
		t.Fatal("storage not called")
	}
	closed := make(chan struct{})
	go func() { child.close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("closed while storage was active")
	case <-time.After(50 * time.Millisecond):
	}
	close(store.release)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close not completed")
	}
}

func TestCredentialFrameRejectsCallerSelectedStorageAndVersion(t *testing.T) {
	child := &sidecar{generation: "0123456789abcdef0123456789abcdef"}
	for _, data := range []string{
		`{"kind":"credential_request","v":1,"generation":"0123456789abcdef0123456789abcdef","id":1,"op":"read","service":"production"}`,
		`{"kind":"credential_request","v":2,"generation":"0123456789abcdef0123456789abcdef","id":1,"op":"read"}`,
		`{"kind":"credential_request","v":1,"generation":"0123456789abcdef0123456789abcdef","id":1,"op":"write","value":null}`,
	} {
		if child.receiveCredential([]byte(data)) {
			t.Fatal("invalid credential frame accepted")
		}
	}
}

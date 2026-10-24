package main

import (
	"bytes"
	"encoding/json"
)

type credentialRequest struct {
	Kind       string  `json:"kind"`
	Version    int     `json:"v"`
	Generation string  `json:"generation"`
	ID         uint64  `json:"id"`
	Op         string  `json:"op"`
	Value      *string `json:"value"`
}

func (s *sidecar) writePrivate(value any) {
	data, err := json.Marshal(value)
	if err != nil {
		s.fail()
		s.stdin.Close()
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	closed := s.closed || s.stopping
	s.mu.Unlock()
	if closed {
		return
	}
	if _, err := s.stdin.Write(append(data, '\n')); err != nil {
		s.fail()
		s.stdin.Close()
	}
}

func (s *sidecar) receiveCredential(data []byte) bool {
	var request credentialRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if len(data) > 512*1024 || decoder.Decode(&request) != nil || request.Version != 1 || request.Generation != s.generation || request.ID == 0 || request.ID > 9007199254740991 || (request.Op != "read" && request.Op != "write" && request.Op != "remove") || request.Op == "write" && (request.Value == nil || len(*request.Value) > 65536) || request.Op != "write" && request.Value != nil {
		return false
	}
	s.mu.Lock()
	if s.credentials == nil || s.closed || s.stopping || s.credentialPending >= 2 || request.ID <= s.credentialLast {
		s.mu.Unlock()
		return false
	}
	s.credentialLast = request.ID
	s.credentialPending++
	s.credentialWG.Add(1)
	s.mu.Unlock()
	go func() {
		defer func() { s.mu.Lock(); s.credentialPending--; s.mu.Unlock(); s.credentialWG.Done() }()
		value, err := s.credentials.request(request.Op, request.Value)
		result := map[string]any{"ok": true, "value": value}
		if err != nil || value != nil && len(*value) > 65536 {
			result = map[string]any{"ok": false, "code": "personal_credentials_unavailable"}
		}
		s.writePrivate(map[string]any{"kind": "credential_result", "v": 1, "generation": s.generation, "id": request.ID, "result": result})
	}()
	return true
}

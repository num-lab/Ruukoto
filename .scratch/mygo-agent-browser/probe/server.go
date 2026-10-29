//go:build darwin

package main

import (
	"embed"
	"fmt"
	"html"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strings"
)

// fixtureServer 起 127.0.0.1 随机端口的确定性页面服务，返回其 origin。
func fixtureServer(fsys embed.FS) (string, error) {
	site, err := fs.Sub(fsys, "web/site")
	if err != nil {
		return "", err
	}
	serve := func(name, ctype string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b, err := fs.ReadFile(site, name)
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", ctype)
			w.Write(b)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/counter", serve("counter.html", "text/html; charset=utf-8"))
	mux.HandleFunc("/form", serve("form.html", "text/html; charset=utf-8"))
	mux.HandleFunc("/form.js", serve("form.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("/common.js", serve("common.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("/mod.js", serve("mod.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		// probe_login 是会话 Cookie，probe_persist 要求跨启动保留。
		w.Header().Add("Set-Cookie", "probe_login=token-abc; Path=/")
		w.Header().Add("Set-Cookie", "probe_persist=persist-xyz; Path=/; Max-Age=604800")
		serve("login.html", "text/html; charset=utf-8")(w, r)
	})
	mux.HandleFunc("/check", func(w http.ResponseWriter, r *http.Request) {
		b, err := fs.ReadFile(site, "check.html")
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		sent := r.Header.Get("Cookie")
		if sent == "" {
			sent = "(无)"
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(strings.Replace(string(b), "__SENT__", html.EscapeString(sent), 1)))
	})
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/blocked", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("blocked: 不应到达"))
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	go func() {
		if err := http.Serve(ln, mux); err != nil {
			fmt.Fprintf(os.Stderr, "[probe] fixture 服务退出: %v\n", err)
		}
	}()
	return "http://" + ln.Addr().String(), nil
}

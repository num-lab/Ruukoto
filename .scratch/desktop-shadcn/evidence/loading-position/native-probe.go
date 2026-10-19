package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"time"

	"github.com/egoist/mygo"
)

type metrics struct {
	X, Y, Width, Height, ViewportWidth, ViewportHeight, CenterX, CenterY float64
	Translate, Transform                                                 string
}

func main() {
	failed := true
	mygo.App.WhenReady(func() {
		window := mygo.NewWindow(mygo.WindowOptions{Title: "Ruukoto Loading Position QA", Width: 1280, Height: 720, Hidden: true, TitleBarStyle: mygo.TitleBarHiddenInset})
		page := window.Page()
		if err := page.LoadURL("http://127.0.0.1:63062/"); err != nil {
			os.Stderr.WriteString("[ruukoto:loading-qa] 无法加载隔离页面。\n")
			mygo.App.Quit()
			return
		}
		go func() {
			defer mygo.App.Quit()
			deadline := time.Now().Add(10 * time.Second)
			for time.Now().Before(deadline) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				value, err := page.EvalContext(ctx, `(() => { const p = document.querySelector('.connection-loading'), l = p?.querySelector('[role="status"]'); if (!p || !l) return null; const r = p.getBoundingClientRect(), t = l.getBoundingClientRect(), s = getComputedStyle(p); return { X:r.x,Y:r.y,Width:r.width,Height:r.height,ViewportWidth:innerWidth,ViewportHeight:innerHeight,CenterX:t.x+t.width/2,CenterY:t.y+t.height/2,Translate:s.translate,Transform:s.transform }; })()`)
				cancel()
				if err != nil || value == nil {
					time.Sleep(50 * time.Millisecond)
					continue
				}
				data, err := json.Marshal(value)
				if err != nil {
					os.Stderr.WriteString("[ruukoto:loading-qa] 无法序列化测量。\n")
					return
				}
				var measured metrics
				if err := json.Unmarshal(data, &measured); err != nil {
					os.Stderr.WriteString("[ruukoto:loading-qa] 测量格式不可用。\n")
					return
				}
				if err := os.WriteFile(os.Getenv("RUUKOTO_LOADING_QA_OUTPUT"), append(data, '\n'), 0600); err != nil {
					os.Stderr.WriteString("[ruukoto:loading-qa] 无法写入测量。\n")
					return
				}
				failed = measured.ViewportWidth == 0 || math.Abs(measured.X) > 1 || math.Abs(measured.Y) > 1 || math.Abs(measured.Width-measured.ViewportWidth) > 1 || math.Abs(measured.Height-measured.ViewportHeight) > 1 || math.Abs(measured.CenterX-measured.ViewportWidth/2) > 1 || math.Abs(measured.CenterY-measured.ViewportHeight/2) > 1
				return
			}
			os.Stderr.WriteString("[ruukoto:loading-qa] 加载页测量超时。\n")
		}()
	})
	if err := mygo.App.Run(); err != nil {
		os.Stderr.WriteString("[ruukoto:loading-qa] 原生夹具无法运行。\n")
		os.Exit(1)
	}
	if failed {
		os.Stderr.WriteString("[ruukoto:loading-qa] 加载页未覆盖视口或未居中。\n")
		os.Exit(1)
	}
}

import * as http from "node:http";
import * as fs from "node:fs";
const html = `<!doctype html><meta charset="utf-8"><style>body{font:15px system-ui;padding:16px}pre{white-space:pre-wrap}</style><h2>WKWebView 隔离探针</h2><pre id="out"></pre><script>
const results = {};
const check = (name, action) => { try { results[name] = String(action()); } catch (e) { results[name] = e.name; } };
check("own runtime", () => typeof window.mygo);
check("own bridge", () => typeof window.ruukoto);
check("parent bridge", () => typeof top.ruukoto);
check("popup", () => window.open("https://example.invalid/mygo-probe"));
check("top navigation", () => { top.location = "https://example.invalid/mygo-probe"; return "attempted"; });
check("media API", () => typeof navigator.mediaDevices);
document.querySelector('#out').textContent = JSON.stringify(results, null, 2);
fetch('/report', {method:'POST', mode:'no-cors', body:JSON.stringify(results)});
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/report") {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => { fs.writeFileSync(new URL("iframe-result.json", import.meta.url), data + "\n"); res.end("ok"); });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
});
server.listen(18461, "127.0.0.1", () => process.stdout.write("Iframe probe: http://127.0.0.1:18461/\n"));

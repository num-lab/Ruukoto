// style-src 需 'unsafe-inline'：xterm 运行时按主题与尺寸注入 <style> 元素（ANSI 16 色、字体与光标规则），拦截会同时失去颜色与行字体。
// Note: 见 .agents/notes/implemented/simplification/2026-10-25-desktop-markdown-images.md
export const PRODUCTION_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-src http: https:; img-src * data: blob: file:";

export function productionCspPlugin() {
  return {
    name: "ruukoto-desktop-production-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: () => [{
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: PRODUCTION_CSP },
        injectTo: "head-prepend",
      }],
    },
  };
}

export const PRODUCTION_CSP = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";

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

import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./style.css";
import "./settings.css";
import "./search.css";

// Note: See .agents/notes/implemented/feature/2026-11-08-desktop-appearance.md
// html.dark follows the host's applied appearance, not a stored value: each
// host maps the preference onto the native theme source, so the effective
// scheme is what the OS/WebView reports.
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", scheme.matches);
applyScheme();
scheme.addEventListener("change", applyScheme);

createRoot(document.getElementById("root")!).render(<App />);

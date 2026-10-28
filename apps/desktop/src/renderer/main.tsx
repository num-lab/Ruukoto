import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./style.css";
import "./settings.css";
import "./search.css";

createRoot(document.getElementById("root")!).render(<App />);

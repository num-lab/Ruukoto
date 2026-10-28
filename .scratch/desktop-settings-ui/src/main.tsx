import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDemo } from "./app.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsDemo />
  </StrictMode>,
);

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { SettingsButton } from "../components/controls.tsx";
import { SettingsRow } from "../components/settings.tsx";

export const apiOptions = [
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "mistral-conversations", label: "Mistral Conversations" },
  { value: "azure-openai-responses", label: "Azure OpenAI Responses" },
  { value: "openai-codex-responses", label: "OpenAI Codex Responses" },
  { value: "bedrock-converse-stream", label: "Bedrock Converse Stream" },
  { value: "google-vertex", label: "Google Vertex" },
  { value: "pi-messages", label: "Pi Messages" },
];

export function TextSetting({ id, title, description, type = "text", defaultValue = "", placeholder }: {
  id: string;
  title: string;
  description?: string;
  type?: "text" | "number" | "password" | "url";
  defaultValue?: string | number;
  placeholder?: string;
}) {
  return <SettingsRow title={title} description={description} htmlFor={id}><input className="settings-plain-input" id={id} type={type} defaultValue={defaultValue} placeholder={placeholder} autoComplete={type === "password" ? "new-password" : "off"} spellCheck={false} /></SettingsRow>;
}

export function RefreshButton({ label }: { label: string }) {
  return <SettingsButton variant="icon" aria-label={label} title={label}><RefreshCw aria-hidden="true" /></SettingsButton>;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="settings-tag">{children}</span>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="settings-notice">{children}</p>;
}

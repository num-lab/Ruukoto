import { useEffect, useRef, useState } from "react";
import { Archive, Blocks, Brain, Globe, Monitor, Moon, Puzzle, RotateCcw, Settings2, Sun, X } from "lucide-react";
import { SettingsButton } from "./components/controls.tsx";
import { SettingsNavItem, SettingsNavSection, SettingsShell } from "./components/settings.tsx";
import { CodeModelsPage } from "./pages/models.tsx";
import { CodeSkillsPage } from "./pages/skills.tsx";
import { CodeMcpPage } from "./pages/mcp.tsx";
import { CodeComputerPage } from "./pages/computer.tsx";
import { AppearancePage, ArchivedPage, WebSearchPage } from "./pages/utility.tsx";

type Category = "appearance" | "code-models" | "code-skills" | "code-mcp" | "code-computer" | "web-search" | "archived";
type Theme = "dark" | "light";

type NavEntry =
  | { type: "section"; label: string }
  | { type: "item"; id: Category; label: string; icon: typeof Settings2 };

const navigation: ReadonlyArray<NavEntry> = [
  { type: "item", id: "appearance", label: "外观", icon: Sun },
  { type: "section", label: "ruukoto" },
  { type: "item", id: "code-models", label: "模型", icon: Brain },
  { type: "item", id: "code-skills", label: "Skills", icon: Puzzle },
  { type: "item", id: "code-mcp", label: "MCP", icon: Blocks },
  { type: "item", id: "code-computer", label: "电脑", icon: Monitor },
  { type: "item", id: "web-search", label: "Web 搜索", icon: Globe },
  { type: "item", id: "archived", label: "已存档会话", icon: Archive },
];

export function SettingsDemo() {
  const [category, setCategory] = useState<Category>("appearance");
  const [theme, setTheme] = useState<Theme>("dark");
  const [resetKey, setResetKey] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    contentRef.current?.querySelector<HTMLElement>(".settings-page")?.scrollTo({ top: 0, behavior: "instant" });
  }, [category, resetKey]);

  function resetDemo() {
    setTheme("dark");
    setCategory("appearance");
    setResetKey(value => value + 1);
  }

  return (
    <div className="settings-demo">
      <SettingsShell
        navigation={navigation.map(entry => {
          if (entry.type === "section") return <SettingsNavSection key={`section-${entry.label}`} label={entry.label} />;
          const Icon = entry.id === "appearance" && theme === "dark" ? Moon : entry.icon;
          return <SettingsNavItem key={entry.id} selected={category === entry.id} aria-label={entry.label} onClick={() => setCategory(entry.id)} icon={<Icon aria-hidden="true" />}>{entry.label}</SettingsNavItem>;
        })}
        action={<SettingsButton variant="icon" aria-label="关闭设置" title="返回外观" onClick={() => setCategory("appearance")}><X /></SettingsButton>}
        footer={<SettingsButton variant="ghost" className="settings-reset" onClick={resetDemo}><RotateCcw />重置演示</SettingsButton>}
        data-density="comfortable"
      >
        <div ref={contentRef} key={`${category}:${resetKey}`} className="settings-content">
          {category === "appearance" && <AppearancePage theme={theme} onThemeChange={setTheme} />}
          {category === "code-models" && <CodeModelsPage />}
          {category === "code-skills" && <CodeSkillsPage />}
          {category === "code-mcp" && <CodeMcpPage />}
          {category === "code-computer" && <CodeComputerPage />}
          {category === "web-search" && <WebSearchPage />}
          {category === "archived" && <ArchivedPage />}
        </div>
      </SettingsShell>
    </div>
  );
}

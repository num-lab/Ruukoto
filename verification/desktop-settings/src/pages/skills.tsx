import { useState } from "react";
import { Puzzle } from "lucide-react";
import { SettingsButton, SettingsSearch } from "../components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow } from "../components/settings.tsx";
import { Tag, TextSetting } from "./shared.tsx";

type Skill = { id: string; name: string; description: string; source: "托管副本" | "外部维护"; explicitOnly?: boolean; enabled: boolean };

const initialSkills: Skill[] = [
  { id: "code-review", name: "code-review", description: "检查改动是否符合仓库标准与原始需求。", source: "托管副本", enabled: true },
  { id: "domain-modeling", name: "domain-modeling", description: "统一领域术语并维护领域模型。", source: "外部维护", explicitOnly: true, enabled: true },
  { id: "prototype", name: "prototype", description: "用可丢弃原型验证界面或状态设计。", source: "托管副本", enabled: false },
];

function SkillsListGroup() {
  const [skills, setSkills] = useState(initialSkills);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(false);
  const filtered = skills.filter(skill => skill.name.includes(query));
  return (
    <SettingsGroup title="全部技能" action={<SettingsSearch className="settings-group-search" id="skill-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="按名称检索" aria-label="检索技能" />}>
      {preview && <SettingsCard className="settings-import-preview">
        <SettingsRow title="导入预览：research" description="3 个文件 · 4,096 字节 · 仅显式调用" />
        <SettingsRow title="来源与冲突" description="复制到托管区，源目录保持原样；技能不增加工具或权限。没有名称冲突。" />
        <SettingsRow title="目录预览" description="仅演示导入预览，尚未选择真实目录。"><SettingsButton variant="ghost" onClick={() => setPreview(false)}>取消导入</SettingsButton></SettingsRow>
      </SettingsCard>}
      <SettingsList label="技能列表" empty={query ? "已取得的列表中没有匹配名称。" : "没有可展示的技能。"}>
        {filtered.map(skill => <SettingsListItem key={skill.id} title={<span className="settings-title-with-icon"><Puzzle aria-hidden="true" />{skill.name}</span>} description={`${skill.description} · ${skill.source}${skill.explicitOnly ? " · 仅显式调用" : ""}`}>
          {!skill.enabled && <Tag>已停用</Tag>}
        </SettingsListItem>)}
      </SettingsList>
    </SettingsGroup>
  );
}

export function CodeSkillsPage() {
  return (
    <SettingsPage title="Skills" description="管理 Code 的外部技能与托管副本。">
      <SkillsListGroup />
    </SettingsPage>
  );
}

export function PersonalSkillsPage() {
  const [library, setLibrary] = useState("/srv/ruukoto/skills");
  return (
    <SettingsPage title="Skills" description="管理 Personal Agent 的远端技能库与托管副本。">
      <SettingsGroup title="远端外部技能库" description="库根含 skills 子目录，外部维护项只读。">
        <SettingsCard>
          <TextSetting id="pa-skill-library" title="技能库目录" defaultValue={library} />
          <SettingsRow title="远端目录" description="从远端目录选择技能库，不使用本机路径冒充远端目录。">
            <SettingsButton onClick={() => setLibrary("/srv/ruukoto/library")}>选择技能库</SettingsButton>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SkillsListGroup />
    </SettingsPage>
  );
}

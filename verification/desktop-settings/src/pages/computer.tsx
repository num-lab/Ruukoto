import { useState } from "react";
import { Plus } from "lucide-react";
import { SettingsButton, SettingsSelect, SettingsSwitch } from "../components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow } from "../components/settings.tsx";
import { Notice, RefreshButton, Tag, TextSetting } from "./shared.tsx";

type Variant = "code" | "personal";

function ComputerDetails({ variant, enabled, onToggle }: { variant: Variant; enabled: boolean; onToggle: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="settings-provider-settings">
      <TextSetting id={`${variant}-computer-name`} title="服务名称" defaultValue={variant === "code" ? "本机电脑" : "Linux 桌面沙箱"} />
      {variant === "code" ? <SettingsRow title="已安装的 Cua Driver" description="选择本机程序。" htmlFor="cua-driver"><SettingsSelect id="cua-driver" options={[{ value: "cua", label: "Cua Driver · /Applications/Cua.app" }]} /></SettingsRow> : <SettingsRow title="Linux 沙箱" description="远端独立 Linux 桌面环境。" htmlFor="cua-sandbox"><SettingsSelect id="cua-sandbox" options={[{ value: "desktop", label: "ruukoto-desktop" }]} /></SettingsRow>}
      <SettingsRow title="computer_screenshot" description="读取屏幕内容。" htmlFor="computer-screenshot"><SettingsSwitch id="computer-screenshot" defaultChecked /></SettingsRow>
      <SettingsRow title="computer_action" description="副作用不明，逐次统一审批。" htmlFor="computer-action"><SettingsSwitch id="computer-action" /></SettingsRow>
      <SettingsRow title="检查权限与工具" description="辅助功能与屏幕录制分别核实。" footer={checked && <Notice>演示状态：辅助功能已授权 · 屏幕录制已授权 · 发现 2 个工具。</Notice>}><SettingsButton onClick={() => setChecked(true)}>检查权限与工具</SettingsButton></SettingsRow>
      <SettingsRow title="电脑操作" description="启停只更新演示状态。"><SettingsButton variant="ghost">删除服务</SettingsButton><SettingsButton onClick={onToggle}>{enabled ? "暂停电脑" : "继续使用电脑"}</SettingsButton><SettingsButton>保存</SettingsButton></SettingsRow>
    </div>
  );
}

function ComputerServices({ variant, description }: { variant: Variant; description: string }) {
  const [selected, setSelected] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [adding, setAdding] = useState(false);
  return (
    <SettingsPage title="电脑" description={description}>
      <SettingsGroup title="服务" action={<><RefreshButton label="重新读取电脑配置" /><SettingsButton onClick={() => setAdding(value => !value)} aria-expanded={adding}><Plus />{variant === "code" ? "添加电脑" : "添加 Linux 桌面沙箱"}</SettingsButton></>}>
        {adding && <SettingsCard className="settings-import-preview"><TextSetting id="new-computer-name" title="服务名称" defaultValue={variant === "code" ? "新电脑" : "新 Linux 沙箱"} /><SettingsRow title={variant === "code" ? "Cua Driver" : "既有沙箱"} description="选择目标后展示工具与权限配置。"><SettingsButton onClick={() => setAdding(false)}>完成配置</SettingsButton></SettingsRow></SettingsCard>}
        <SettingsList label="电脑服务">
          <SettingsListItem title={variant === "code" ? "本机电脑" : "Linux 桌面沙箱"} description={`${variant === "code" ? "本机 Cua Driver" : "Linux 电脑 · ruukoto-desktop"} · 2 个允许工具`} details={selected ? <ComputerDetails variant={variant} enabled={enabled} onToggle={() => setEnabled(value => !value)} /> : undefined}>
            <Tag>{enabled ? "已启用" : "已暂停"}</Tag><SettingsButton variant="ghost" onClick={() => setSelected(value => !value)} aria-expanded={selected}>{selected ? "收起" : "编辑"}</SettingsButton>
          </SettingsListItem>
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title={variant === "code" ? "本机电脑" : "电脑"} action={<RefreshButton label="刷新电脑状态" />}>
        <SettingsCard>
          <SettingsRow title="运行状态" description="没有正在等待恢复的电脑操作。"><Tag>使用中</Tag></SettingsRow>
          <SettingsRow title="停止电脑操作" description="未保存的应用状态可能丢失，磁盘文件保留。" footer={recovering && <Notice>演示状态：操作已停止，可获取新截图并确认恢复。</Notice>}><SettingsButton onClick={() => setRecovering(value => !value)}>{recovering ? "检查并恢复" : "停止电脑操作"}</SettingsButton></SettingsRow>
          {recovering && <SettingsRow title="恢复现场" description="真实桌面截图未接入 demo；此处仅保留确认流程。"><SettingsButton>重新截图</SettingsButton><SettingsButton>确认恢复</SettingsButton></SettingsRow>}
        </SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}

export function CodeComputerPage() {
  return <ComputerServices variant="code" description="管理本机 Cua Driver 与电脑操作恢复。" />;
}

export function PersonalComputerPage() {
  return <ComputerServices variant="personal" description="管理远端 Linux 桌面沙箱与电脑操作恢复。" />;
}

/**
 * 控制面协议：Unix socket + 换行分帧 JSON。
 *
 * - 请求 {v, id, op, params}；应答 {v, id, ok, result|error}；
 * - 事件推送 {v, push:"event", event}，event.seq 单调递增，客户端按 seq 去重；
 * - 帧大小上限 MAX_FRAME_BYTES，超限断开；
 * - connect 返回快照 + (since, seq] 补发，随后无缝转入实时推送。
 *
 * 拥有者认证（v2）：连接建立后首个操作必须是 auth（携带拥有者
 * 令牌）；认证成功前不返回快照、不执行任何请求。令牌只经控制面受控目录的
 * 令牌文件或拥有者自己的环境变量传递，不出现在命令行、工具环境或日志中。
 * Note: 见 .agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md
 *
 * v3（issue 04）：快照有界化（活动任务 + 每会话近期结束任务，更早的经
 * list_tasks 分页）；握手返回数据实例标识与执行后端说明；活动/中断任务
 * 携带输出预览；确认请求与工具操作经有界参数视图传输（完整参数按 ID
 * 分段读取）；新增历史读取与 request_id 核实接口。版本不匹配时服务端
 * 以 bad_request 明确拒绝，客户端应提示升级而非静默重试。
 *
 * v8（issue 17）：专用 GitHub 模块退役，github_* 业务接口移除；旧客户端
 * 因版本不匹配被拒绝，旧命令仅保留静态迁移提示。
 *
 * v9：正文按连续显示段发送 UTF-8 增量，新增持久思考阶段、read_task_events
 * 分页及 get_task 快照水位。旧客户端须升级；持久旧事件的累计尾部格式仍可读。
 *
 * v10（agent-direction issue 10）：长期操作授权——批准新增可空的授权 ID/版本
 * 关联与新决定来源 standing_permission；新增 standing_permission.* 事件与
 * service_grant_list/get/revoke 操作（不获得创建或扩大授权的能力）。旧客户端
 * 须升级；持久历史中的旧来源与事件保持可读。
 *
 * v11（agent-direction issue 11）：通用 SubAgent 委派——快照新增工作委托、
 * SubAgent 与其内部会话 ID 列表；新增 work_delegation.created 与
 * subagent_task.* 事件、work_list/work_get 操作（只读）。旧客户端须升级；
 * 持久旧事件与记录保持可读。
 *
 * v12（agent-direction issue 12）：SubAgent 继续/复用/显式关闭——SubAgent 新增
 * closedAt/closedBy；新增 subagent.closed 事件与 subagent_close 操作（工作委托
 * 列表照旧）；委派复用经模型工具的 sub_agent_id 参数。旧客户端须升级；
 * 持久旧事件与记录保持可读。
 *
 * v13（agent-direction issue 14）：整项工作取消——工作委托新增
 * canceledAt/canceledBy/cancelReason；新增 work_delegation.canceled 事件与
 * work_cancel 操作；主 Agent 工具增加 subagent_cancel。旧客户端须升级；
 * 持久旧事件与记录保持可读。
 *
 * v14（agent-direction issue 20）：核心群聊退役——qq_group_update 操作删除
 * （旧 qq_config.groups 保留为历史值）；qq_inbox_list 条目新增 acceptance
 * （main 接收账本）与 sourceProblem（当前复核结论）字段。旧客户端须升级；
 * 旧群收件/发送/入站记录保持可读。
 *
 * v15（agent-direction issue 13 + 17）：工作内协作消息——新增 subagent_message.sent /
 * subagent_message.dropped 事件；work_get 详情新增 messages 列表；主 Agent 工具
 * 增加 subagent_message，委派 work_id 与 sub_agent_id 同现表示协作加入。改动汇总——
 * 新增 work_delegation.integrated 事件与主 Agent 工具 subagent_integrate；main 会话
 * 的修改委派开放（通用 SubAgent 产生改动、宿主汇总进父工作区待提交区）。旧客户端
 * 须升级；持久旧事件与记录保持可读。
 *
 * v16（issue 31）：会话默认与提交支持 Plan，任务与 task.queued 新增 planMode，
 * 固定采用 auto-review；计划行为由模式设置确定，输入文本与继续链不决定模式。
 *
 * v17：会话分支持久名称与来源，完整创建事件、幂等分支查询及历史清单读取。
 *
 * v18：手动上下文压缩快速接收、持久结果查询与取消；压缩点区分任务与手动来源。
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-manual-context-compaction.md
 *
 * v21：工作流问题/事实查询与可信业务回答；回答有独立请求键及问题运行代次，不消费工具审批。
 * Note: 见 .agents/notes/implemented/feature/2026-10-13-workflow-owner-input-and-delivery.md
 *
 * v22：命名定义/不可变版本、可信显式启动、阶段读取及拥有者运行控制；授权不从 wire 回填。
 * Note: 见 .agents/notes/implemented/feature/2026-10-13-workflow-library-and-controls.md
 *
 * v23：任务视图派生输入用途，历史页与单条补读携带原任务关联、用途与关联诊断。
 * Note: 见 .agents/notes/implemented/feature/2026-10-14-internal-report-visibility.md
 *
 * v24：等待对象、到期时间、阶段与中断原因；可信普通子任务补报沿用内部输入用途。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md
 *
 * v29：快照显式提供 main 主会话身份，新增拥有者工作区只读 Git 历史。
 * v30：创建会话与打开工作区可原子指定初始模式及模型选择。
 * v31：工作区 Git 历史以仓库修订绑定的游标分页，无累计提交数上限。
 * v32：思考按 UTF-8 偏移增量发送，工作区文件以修订绑定的 base64 分页完整读取。
 * v33：会话可存档/取消存档；存档只影响列表可见性，快照与会话记录携带 archivedAt。
 * v34：持久问题快照与事件，可信回答原键回执及唯一续接；回答不消费操作审批。
 * v35：问题选项说明与推荐标记、多选及空回答跳题；问题查询页预算增至256KiB。
 * v36：会话后台快照、日志与可信停止，结束请求保留原键及固定成员。
 * v37：合并 Code 工作区正文搜索与连续历史定位（around／after／source），拒绝未合流的客户端与后台。
 * v40：Code MCP 配置与凭据按实例管理，删除来源操作并拒绝旧项目或工作区参数。
 * v38：MCP 配置、审批与事件增加具名 Cua 分支；原操作电脑证据有界读取，拥有者恢复控制不向模型开放。
 * Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-session-archive.md
 * v28：拥有者工作区文件树与只读预览；目录范围由登记身份决定，不接受客户端绝对路径。
 * v27：拥有者附件分块暂存、提交引用及工具结果按字段分页；旧后台不得静默丢弃附件。
 * v26：握手快照携带产品身份，桌面客户端在安装快照前核对连接目标。
 * Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
 */

import {
  PROTOCOL_VERSION,
  type Artifact,
  type PersistentEvent,
  type Project,
  type Session,
  type SubAgent,
  type WorkDelegation,
} from "@ruukoto/core/types.ts";
import type { ProductType } from "@ruukoto/core/product.ts";
import type { ConfirmationRequestView, OutputPreview, TaskView } from "@ruukoto/core/views.ts";
import type { BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import type { OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;

export const CONTROL_PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface ConnectSnapshot {
  product: ProductType;
  projects: Project[];
  sessions: Session[];
  /** 活动任务 + 每会话有界的近期结束任务；更早的经 list_tasks 分页。 */
  tasks: TaskView[];
  /** 未决审批（参数有界预览；完整参数经 get_confirmation_params 分段读取）。 */
  confirmations: ConfirmationRequestView[];
  artifacts: Artifact[];
  /** 活动/中断任务的最新输出预览（重连重建；缺失片段如实为空）。 */
  previews: Record<string, OutputPreview>;
  /** 数据实例稳定标识：待确认请求绑定它；新数据库分配新标识。 */
  instanceId: string;
  /** 执行后端与说明（local 无隔离必须显式展示）。 */
  execution: { backend: string; note: string };
  /** 后台启动默认模型；会话选择和任务实际配置分别随会话、任务返回。 */
  defaultModel: { provider: string; id: string; name: string; thinkingLevel: string };
  /** 实例级 Web Search 开关（全实例共用；旧后台缺省视为启用）。 */
  webSearch?: { state: "enabled" | "disabled"; version: number };
  mainSessionId: string | null;
  /** 逻辑角色绑定的会话（工作区入口不以其作为自动归属依据；旧后台缺省）。 */
  roleSessionIds?: string[];
  /** SubAgent 的内部工作会话（普通工作区列表排除；旧后台缺省）。 */
  subAgentSessionIds?: string[];
  /** 工作委托（issue 11；只读视图，状态/历史/任务事件与产物沿用既有接口）。 */
  workDelegations?: WorkDelegation[];
  /** 动态 SubAgent 身份（含运行/空闲/待核实状态）。 */
  subAgents?: SubAgent[];
  ownerQuestions?: OwnerQuestionView[];
  backgroundProcesses?: BackgroundProcessView[];
}

/** 单任务持久事件分页；nextAfter 非空时继续读，最终消息正文以历史接口为准。 */
export interface TaskEventsPage {
  events: PersistentEvent[];
  nextAfter: number | null;
}

export interface ConnectResult {
  /** 快照截止序号；实时推送自此之后开始，无缺口。 */
  seq: number;
  /** (since, seq] 的补发事件；fresh connect（无 since）为空。 */
  replay: PersistentEvent[];
  snapshot: ConnectSnapshot;
}

export type ControlRequest = {
  v: number;
  id: string;
  op: string;
  params?: Record<string, unknown>;
};

export type ControlResponse = {
  v: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type ControlPush = {
  v: number;
  push: "event";
  event: PersistentEvent;
};

export function encodeFrame(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

#!/usr/bin/env python3
"""Resolve issue-17 merge conflicts: replace each conflict region (in order) with
the given resolved text. Fails loudly if marker counts mismatch."""
import sys

RES = {
"src/core/types.ts": ["""/**
   * 工作内协作消息已登记（agent-direction issue 13）：与消息行同事务落盘，
   * 每条消息至多一条（含登记时的投递判定）；delivery：task = 已投递为接收方
   * 的本工作任务（taskId 非空）；wake = 已投递为 main 唤醒任务；inject = 待
   * dev 父会话注入；pending = 接收方正忙/名额满，宿主机在终态/启动时冲刷。
   * 同键同参命中不再产生事件；冲刷改变行与任务但不补发本事件，未送达的
   * 最终结果由 subagent_message.dropped 记录。
   */
  | { type: "subagent_message.sent"; messageId: string; workId: string; parentSessionId: string; fromSubAgentId: string | null; fromTaskId: string; toSubAgentId: string | null; delivery: "task" | "wake" | "inject" | "pending"; taskId: string | null }
  /** 工作内消息最终无法投递（接收方资格已失或工作已取消）；与判定同事务落盘。 */
  | { type: "subagent_message.dropped"; messageId: string; workId: string; parentSessionId: string; toSubAgentId: string | null; reason: string }
  /**
   * worktree 副本的改动已汇入父工作区（agent-direction issue 17）：taskId =
   * 发起汇总的主任务（直接父任务）；来源按（分支, baseCommit）钉定，parentHead
   * 是汇总时刻父仓库 HEAD（null = 读取失败）；文件清单与统计来自汇总时的完整
   * 差异（files 有界，上限见 INTEGRATE_FILE_LIST_CAP；超出只计数不列名）。只在
   * 真实套用时登记（幂等命中、空差异与冲突不登记）。
   */
  | { type: "work_delegation.integrated"; workId: string; parentSessionId: string; subAgentId: string; taskId: string; branch: string; baseCommit: string; parentHead: string | null; files: string[]; filesChanged: number; insertions: number; deletions: number; patchBytes: number }
"""],
"src/control/protocol.ts": [""" * v15（agent-direction issue 13 + 17）：工作内协作消息——新增 subagent_message.sent /
 * subagent_message.dropped 事件；work_get 详情新增 messages 列表；主 Agent 工具
 * 增加 subagent_message，委派 work_id 与 sub_agent_id 同现表示协作加入。改动汇总——
 * 新增 work_delegation.integrated 事件与主 Agent 工具 subagent_integrate；main 会话
 * 的修改委派开放（通用 SubAgent 产生改动、宿主汇总进父工作区待提交区）。旧客户端
 * 须升级；持久旧事件与记录保持可读。
"""],
"src/agent/tool-op-ledger.ts": ["""  // 工作内协作消息（issue 13）：按（工作, 发送方, 键）的消息行核实
  subagent_message: "subagent",
  // 改动汇总（issue 17）：按 work_delegation.integrated 事件核实；缺事件报无法核实（apply 可能已落字节）
  subagent_integrate: "subagent",
"""],
"src/agent/driver.ts": ["""  subagents?: Pick<SubAgentToolsDeps, "sources" | "delegate" | "close" | "cancelWork" | "message" | "integrate" | "readReply" | "resultNotice">;
"""],
"src/agent/session-factory.ts": [
    """    "- 需要独立完成的只读分析或用隔离副本修改仓库时用 subagent_delegate 创建 SubAgent（mode=modify + target 修改委派在宿主生成的本地副本上工作，不提交、不推送；Git 仓库目标建 worktree 副本，非 Git 目录直接写入并与父会话串行）。副本改动由你用 subagent_integrate 按工作 id 汇入你的待提交改动区——冲突时不覆盖、双方保留，拿到冲突就把待处理内容说清楚；汇总后用你自己的检查验证改动。补充原工作用 work_id，相关的另一项工作可用 sub_agent_id 复用同一个空闲 SubAgent（保留上下文）；work_id 与 sub_agent_id 同现可把空闲 SubAgent 拉入既有只读工作协作，同项工作内用 subagent_message 向其中的 SubAgent 补充（消息带来源、不扩大对方权限）。完成后用 subagent_result 按工作 id 读结果（省略 work_id 看总览，part=messages 看工作内消息）；不再需要的工作用 subagent_cancel 取消（已取消的工作不能继续委派）；不再需要后续协作时用 subagent_close 关闭。",
""",
    """    "- 你没有编码工具：只需读取与分析时用 subagent_delegate 创建通用 SubAgent（只读），完成后用 subagent_result 读结果（省略 work_id 看总览，part=messages 看工作内消息）；补充原工作用 work_id，相关的另一项工作可用 sub_agent_id 复用同一个空闲 SubAgent（保留上下文），work_id 与 sub_agent_id 同现可把空闲 SubAgent 拉入既有只读工作协作，同项工作内用 subagent_message 向其中的 SubAgent 补充（消息带来源、不扩大对方权限），不再需要的工作用 subagent_cancel 取消（已取消的工作不能继续委派），不再需要时用 subagent_close 关闭；要修改文件时用 subagent_delegate 的 mode=modify + target 让 SubAgent 在你的工作区隔离副本里改动（不提交、不推送），再用 subagent_integrate 按工作 id 把副本改动汇入你的工作区（冲突时不覆盖、双方保留，待处理内容如实说明）；coding_delegate 的 mode=draft 是旧固定路径（仅迁移期兼容），mode=analyze 已等价于只读委派。",
""",
    """    "- 任务输入首行标写模式：只读分析（工具 read / read_artifact / subagent_message）或副本修改（read / edit / write / bash / read_artifact / subagent_message；改动留在副本工作树由主 Agent 汇总，不要 git add/commit、不推送）。能力与范围以任务输入为准。",
    "- subagent_message 向主 Agent 或当前承接同一项工作的其他 SubAgent 发送有来源的消息：消息不扩大任何一方的工具或资料范围；协作消息会作为本工作的新任务送达你。",
""",
],
"src/agent/subagent-tools.ts": [
    """ * 通用 SubAgent 委派工具（agent-direction issue 11；issue 12 继续/复用/关闭；
 * issue 13 工作内协作消息与协作加入；issue 14 整项取消；issue 17 改动汇总与
 * main 修改委派）：subagent_delegate / subagent_result / subagent_close /
 * subagent_cancel / subagent_message / subagent_integrate。前五个对拥有者的普通
 * 开发会话与 main 角色会话装配（subagent_message 另行对 SubAgent 子会话装配）；
 * 其余身份一律不装配也不放行（subagent_close / subagent_cancel / subagent_integrate
 * 例外：回报唤醒轮次也允许——关闭与取消只收窄能力，汇总只作用于本会话自己
 * 登记的成果）。
""",
    """ * - subagent_message（issue 13）：同项工作的参与者互发有来源的消息——
 *   发送方身份完全由发起任务核实（工作父会话任务 = 主 Agent，回报唤醒
 *   轮次同样允许——作用范围仍是本会话名下工作；本工作的 SubAgent
 *   任务 = 该 SubAgent），不接受模型参数指定身份；接收方是当前承接
 *   本工作的 SubAgent（复用转做其他工作后资格即失）或主 Agent
 *   （省略 to_sub_agent_id）；资格核实、幂等与投递见 SubAgentManager.message。
 * - subagent_integrate 改动汇总（issue 17）：把本会话登记的 worktree 副本相对
 *   基线的完整差异套用到父工作区待提交区（不代提交、不强制覆盖）；冲突时
 *   零写入并点名冲突文件；幂等命中如实返回；直接写入工作如实告知没有副本；
 *   取消过的工作与已关闭的 SubAgent 不拦汇总（成果可找回）。
""",
    """import type {
  SubAgentDelegation,
  SubAgentDelegateInput,
  SubAgentMessageInput,
  SubAgentMessageResult,
  WorkCancellation,
  WorkIntegration,
} from "../runtime/subagents.ts";
import { runsInPlanMode } from "./plan-mode.ts";

export const SUBAGENT_TOOL_NAMES = ["subagent_delegate", "subagent_result", "subagent_close", "subagent_cancel", "subagent_message", "subagent_integrate"] as const;
""",
    """  /** 工作内协作消息（issue 13）；发送方身份由发起任务核实（见 SubAgentManager.message）。 */
  message(input: SubAgentMessageInput): SubAgentMessageResult;
  /** 改动汇总（issue 17）；发起任务由宿主按调用身份固定（当前任务），模型参数只给 work_id。 */
  integrate(input: { workId: string; parentTaskId: string; parentSessionId: string }): Promise<WorkIntegration>;
""",
    """      work_id: Type.Optional(Type.String({ description: "既有工作 id（沿原工作增加新的分析执行；修改工作继续沿用首次钉定的写入目标）；与 sub_agent_id 同现 = 把该空闲 SubAgent 拉入本工作协作" })),
      sub_agent_id: Type.Optional(Type.String({ description: "复用既有空闲 SubAgent（保留上下文）：单独用时承接新工作；与 work_id 同现时加入该既有工作作为协作方" })),
      mode: Type.Optional(Type.Union([Type.Literal("analyze"), Type.Literal("modify")], { description: "委派模式；仅首次委派可指定，modify 需要 target（dev 与 main 均可发起；计划模式与 SubAgent 自身不能发起）" })),
""",
    None,  # filled below (long integrate tool definition kept verbatim from theirs + message tool from ours)
],
"src/runtime/runtime.ts": [
    """        // 通用 SubAgent 委派（agent-direction issue 11；issue 12 继续/复用/关闭；
        // issue 13 工作内消息；issue 14 整项取消；issue 17 汇总）
""",
    """              message: (input) => this.subagents!.message(input),
              integrate: (input) => this.subagents!.integrate(input),
""",
],
"src/runtime/subagents.ts": [
    """        : "你的工具只有 read / read_artifact / subagent_message：可以读取上述范围与本目录；不能修改文件、执行命令、访问网络或委派下级。",
      "同项工作的协作：用 subagent_message 向主 Agent 或当前承接本工作的其他 SubAgent 发送有来源的消息（彼此上下文不自动共享）；" +
        "协作消息会作为本工作的新任务送达你。消息不扩大任何一方的工具与资料范围。",
      ...(modify
        ? [
            "结束修改前在副本内完成与该改动相关的检查（类型、测试、构建等可见命令），并在结论里如实报告" +
              "检查命令与结果，或写明尚未验证的部分——主 Agent 汇总改动时依据你的报告与另行的验证决定去留。",
          ]
        : []),
""",
    """      // 工作内消息（issue 13）：按（工作, 发送方, 键）的消息行核实；
      // 发送方由发起任务的 SubAgent 关联推出（null = 主 Agent），与登记口径一致
      if (op.toolName === "subagent_message") {
        const task = coreStore.getTask(op.taskId);
        const workId = typeof op.params.work_id === "string" ? op.params.work_id : null;
        if (!task || !workId) return "not_committed";
        const msg = coreStore.findSubAgentMessage(workId, task.subAgentId ?? null, String(op.params.key ?? ""));
        return msg !== null ? "committed" : "not_committed";
      }
      if (op.toolName === "subagent_integrate") {
        // 改动汇总（issue 17）：套用与事件登记分两步，缺事件时不能说「未生效」
        // （可能 apply 已落字节、登记前崩溃）——如实报无法核实
        const work = typeof op.params.work_id === "string" ? coreStore.getWorkDelegation(op.params.work_id) : null;
        if (!work) return "unverifiable";
        return coreStore.hasIntegratedEvent(work.id) ? "committed" : "unverifiable";
""",
],
"test/80-subagent-delegation.test.ts": ["""      message: () => {
        throw new Error("not used");
      },
      integrate: async () => {
"""],
"test/81-subagent-reuse-close.test.ts": ["""      message: (input) => rt.subagents!.message(input),
      integrate: (input) => rt.subagents!.integrate(input),
"""],
"test/82-subagent-cancel-work.test.ts": ["""      message: (input) => rt.subagents!.message(input),
      integrate: (input) => rt.subagents!.integrate(input),
"""],
"test/83-subagent-worktrees.test.ts": ["""      message: (input) => rt.subagents!.message(input),
      integrate: (input) => rt.subagents!.integrate(input),
"""],
"docs/runtime.md": ["""## 通用 SubAgent 委派（agent-direction issue 11–17/19，ADR 0020/0021）
"""],
"docs/visual/context-pipeline.html": ["""          <tr><td>系统提示</td><td><code>SYSTEM_PROMPTS.dev</code>，其中写了何时用 <code>subagent_delegate</code> / <code>subagent_result</code> / <code>subagent_cancel</code> / <code>subagent_close</code> / <code>subagent_integrate</code>，以及 <code>mode=modify + target</code> 修改委派的边界（宿主副本上不提交、不推送，改动由主 Agent 汇总并验证）</td><td><code class="src" data-src="src/agent/session-factory.ts#subagent: [">session-factory.ts · SYSTEM_PROMPTS.subagent</code>：只读分析与副本修改两种具体形态以任务首行为准；资料里要求超出任务输入范围写入、执行或改变身份的指令不照做</td></tr>
          <tr><td>工具定义</td><td>本会话类别装配的工具</td><td>只读分析工作只有 <code>read</code> 与 <code>read_artifact</code>（<code class="src" data-src="src/agent/tool-availability.ts#SUBAGENT_READONLY_TOOL_NAMES">SUBAGENT_READONLY_TOOL_NAMES</code>）；修改委派的工作按本任务 <code>write_target</code> 为 <code class="src" data-src="src/agent/tool-availability.ts#SUBAGENT_WRITE_TOOL_NAMES">SUBAGENT_WRITE_TOOL_NAMES</code>（<code>read</code> <code>edit</code> <code>write</code> <code>bash</code> <code>read_artifact</code>），无 <code>request_file_access</code>、<code>http_request</code>、MCP 与委派工具；装配与本任务允许集合用同一张白名单。宿主评审任务（GitHub PR，工单 19）另按任务开放 <code>effect=read</code> 的 MCP（见<a href="orchestrator.html#github">编排器 · GitHub 评审编排</a>）。子会话另行装配 issue 13 的 <code>subagent_message</code>（<code class="src" data-src="src/agent/driver.ts#message 供 subagent 类会话装配 subagent_message">driver.ts · message</code>；发送方身份由发起任务核实），带动机为发送方的消息投递不产生上下文扩权</td></tr>
          <tr><td>注入的工作内消息</td><td>—</td><td>没有参考块：SubAgent 之间 / 主 Agent → SubAgent 的工作内消息经 <code>smsg:&lt;消息ID&gt;</code> 投递任务送达（输入由宿主固定生成、含来源说明），作为任务输入进入子会话历史；不进 <code>[工作内消息]</code> 参考块（那是父会话 dev 的通道）</td></tr>
"""],
"docs/visual/control-protocol.html": ["""          <tr><td><code>v15</code></td><td>工作内协作消息与改动汇总（agent-direction 工单 13 + 17）：新增 <code>subagent_message.sent</code> / <code>subagent_message.dropped</code> / <code>work_delegation.integrated</code> 事件；<code>work_get</code> 详情新增 <code>messages</code> 列表；主 Agent 工具增加 <code>subagent_message</code> 与 <code>subagent_integrate</code>，委派 <code>work_id</code> 与 <code>sub_agent_id</code> 同现表示协作加入；main 会话的修改委派开放（通用 SubAgent 产生改动、宿主汇总进父工作区待提交区）。旧客户端须升级</td></tr>
"""],
"docs/visual/tool-call-path.html": ["""          <tr><td>SubAgent</td><td><code>subagent_result</code></td><td>—</td><td><code>subagent_delegate</code> → 工作、SubAgent、会话与任务关联；<code>subagent_close</code> → <code>sub_agents.closed_at</code>（幂等关闭也以该列为已提交）；<code>subagent_cancel</code> → <code>work_delegations.canceled_at</code>（幂等取消也以该列为已提交）；<code>subagent_message</code> → <code>subagent_messages</code> 行（按（工作, 发送方, 键）核实；发送方由发起任务的 SubAgent 关联推出）；<code>subagent_integrate</code> → <code class="src" data-src="src/core/store.ts#hasIntegratedEvent">work_delegation.integrated</code> 事件（缺事件如实报无法核实，不报「未生效」）</td></tr>
"""],
# orchestrator.html regions filled below
}

# --- subagent-tools.ts region 5: both tool definitions -----------------------
with open("src/agent/subagent-tools.ts") as fh:
    _s = fh.read()
def _regions(s):
    lines = s.split("\n")
    out, i = [], 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<<"):
            j = i
            while not lines[j].startswith("======="):
                j += 1
            k = j
            while not lines[k].startswith(">>>>>>>"):
                k += 1
            out.append((i, j, k))
            i = k
        else:
            i += 1
    return out
_regs = _regions(_s)
_lines = _s.split("\n")
_i, _j, _k = _regs[5]
_head5 = "\n".join(_lines[_i + 1 : _j])   # message tool + return(5)
_theirs5 = "\n".join(_lines[_j + 1 : _k]) # integrate tool + return(6)
# compose: keep head block but replace its return line; keep theirs block minus its return line
_head5 = _head5.replace(
    "return [subagentDelegate, subagentResult, subagentClose, subagentCancel, subagentMessage];",
    "",
)
_theirs5 = _theirs5.replace(
    "  return [subagentDelegate, subagentResult, subagentClose, subagentCancel, subagentIntegrate];",
    "",
)
RES["src/agent/subagent-tools.ts"][5] = (
    _head5 + "\n" + _theirs5
    + "\n  return [subagentDelegate, subagentResult, subagentClose, subagentCancel, subagentMessage, subagentIntegrate];\n"
)

# --- orchestrator.html three regions ----------------------------------------
_orc = open("docs/visual/orchestrator.html").read()
oregs = _regions(_orc)
olines = _orc.split("\n")
assert len(oregs) == 3, len(oregs)
# region 0: lede — HEAD + integrate sentence after "发 subagent_task.*"
i, j, k = oregs[0]
lede = "\n".join(olines[i + 1 : j])
anchor = "发 subagent_task.*；"
assert anchor in lede
lede = lede.replace(
    anchor,
    anchor
    + "worktree 副本的改动由主 Agent 经 subagent_integrate 汇入父工作区待提交区，预检通过才写入、冲突零写入双方保留，发 work_delegation.integrated，main 的修改委派走同一条通用链路；",
    1,
)
# region 1: two table rows — HEAD rows + append integrate 核实 to row 2
i, j, k = oregs[1]
rows = "\n".join(olines[i + 1 : j])
anchor2 = "subagent_message</code> 按（工作, 发送方, 键）的消息行核实（发送方由发起任务的 SubAgent 关联推出）"
assert anchor2 in rows
rows = rows.replace(
    anchor2,
    anchor2
    + "；<code>subagent_integrate</code> 按 <code class=\"src\" data-src=\"src/core/store.ts#hasIntegratedEvent\">work_delegation.integrated</code> 事件核实，缺事件如实报无法核实（apply 落字节与登记是两个步骤），不报「未生效」",
    1,
)
# region 2: callout — unified 范围边界
callout = """      <b>范围边界</b>
      <p>已有：首次委派、沿原工作继续（<code>work_id</code>）、复用承接新工作（<code>sub_agent_id</code>）、协作加入与同项工作的工作内消息（13；主 Agent 与当前承接本工作的各 SubAgent 互发，忙碌或名额满保持待投递，宿主机在终态、启动、取消与关闭后冲刷）、整项取消（14）、后台重启恢复（15）、修改委派与按工作隔离的 worktree（16）、main 修改委派与改动汇总（17；<code>subagent_integrate</code> 预检通过才写入、冲突零写入双方保留）、GitHub 固定评审（19）、结果回报与查询（含总览）、主 Agent 与拥有者两侧的显式关闭（<code>subagent_close</code> 与 <code>ruukoto work close</code>）。「执行中再委派同一工作覆盖当前任务指针」的缺口已堵死——继续与复用要求 idle，忙碌明确拒绝不排队。</p>"""
RES["docs/visual/orchestrator.html"] = [lede + "\n", rows + "\n", callout + "\n"]

# --- CONTEXT.md: region 0 = SubAgent entry, region 1 = 工作委托 entry --------
_ctx = open("CONTEXT.md").read()
cregs = _regions(_ctx)
clines = _ctx.split("\n")
assert len(cregs) == 2, len(cregs)
i, j, k = cregs[0]
sub_e = "\n".join(clines[i + 1 : j])  # HEAD (13+15 merged)
i17, j17, k17 = cregs[0]
_theirs0 = "\n".join(clines[j17 + 1 : k17])  # 17 side
m17 = re_m = None
old16 = "（子任务不提交、不推送，改动由主 Agent 汇总）"
assert old16 in sub_e
sub_e = sub_e.replace(old16, "（子任务不提交、不推送）", 1)
anchor3 = "非 Git 目标直接写入并与父会话按目录占用串行；"
assert anchor3 in sub_e
s17 = "issue 17 增加改动汇总并开放 main 的修改委派：`subagent_integrate` 把本会话登记的副本相对基线的完整差异套用到父工作区待提交区（预检通过才写入、不代提交、冲突零写入双方保留、已套用幂等返回、直接写入无副本如实告知），取消/关闭不拦汇总（副本与成果保留可找回），旧 `coding_delegate mode=draft` 仅保留迁移期兼容；"
sub_e = sub_e.replace(anchor3, anchor3 + s17, 1)
i, j, k = cregs[1]
work_e = "\n".join(clines[i + 1 : j])  # HEAD side
assert work_e.endswith("（见 SubAgent 条目）。")
work_e = work_e[: -len("。")] + "；issue 17 增加改动汇总：`work_delegation.integrated` 事件记录一次成功套用的分支/基线/父 HEAD/文件清单与统计（取消过的工作与已关闭的 SubAgent 仍可汇总其保留的副本成果）。"
RES["CONTEXT.md"] = [sub_e + "\n", work_e + "\n"]

# --- apply -------------------------------------------------------------------
def resolve(path):
    with open(path) as fh:
        lines = fh.read().split("\n")
    regs = _regions("\n".join(lines))
    want = RES[path]
    if len(regs) != len(want):
        print(f"MISMATCH {path}: {len(regs)} regions vs {len(want)} resolutions", file=sys.stderr)
        sys.exit(1)
    # apply back-to-front so indices stay valid
    for (i, j, k), text in sorted(zip(regs, want), key=lambda x: x[0][0], reverse=True):
        lines[i : k + 1] = text.rstrip("\n").split("\n")
    with open(path, "w") as fh:
        fh.write("\n".join(lines))
    print(f"resolved {path} ({len(regs)} regions)")

for p in RES:
    resolve(p)

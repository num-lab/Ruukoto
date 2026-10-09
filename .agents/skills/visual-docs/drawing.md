# 作图

组件的类名清单见 `docs/visual/style.css` 顶部注释。本文只讲怎么画：画什么、坐标怎么算、改完怎么看。

范例可以直接照抄：

- 状态机 + 转换表：task-lifecycle.html `#states`
- 时序图：control-protocol.html `#handshake`
- 失败分支放进 `<details>`：outbox.html `#sender`

## 画什么

- 画机制：谁调用谁、数据往哪里流、状态怎么变、边界在哪里、哪一步会失败。每条边都写边标签，例如「条件更新」「同一事务」「按原键核实」。
- 图上的文字只写一到三个词，解释写进 figcaption、正文或表格。
- 每张图都用 `<figure class="fig">` 包起来，svg 带 `role="img"`。`aria-label` 用一句话按顺序讲完整张图的全部节点和边。
- 图里用到语义色时，附一个 `ul.legend`，只列出这张图用到的颜色。
- 按比例画的图共用同一个刻度，标出的数值必须是图上真实到达的值。

## SVG 坐标

整宽图用 `viewBox="0 0 1040 H"`，这时文字按原尺寸显示。窄于 600 的小图，给 svg 加 `class="narrow"` 和 `style="max-width:…px"`，max-width 等于 viewBox 宽度。

**节点**

```html
<g class="n wait"><rect x="150" y="168" width="140" height="52" rx="8"/><text x="220" y="186">queued</text><text class="sub" x="220" y="205">排队</text></g>
```

- 文字由 CSS 水平居中，`x` 取矩形中心：x + width / 2。
- 两行文字：高 46 时，名称 `y = 顶 + 15`，说明 `y = 顶 + 33`；高 52 时分别加 18 和 37。只有一行时 `y = 顶 + 高 / 2`。
- 估算宽度：
  - 名称是 13px 等宽字体，ASCII 每字约 8px，汉字约 13px；
  - 说明是 11.5px，ASCII 约 6.5px，汉字约 11.5px；
  - 节点宽度 ≥ 最长那一行 + 24。
- 颜色类（ok / wait / run / unk / bad / idle / accent）表达这个节点的语义状态。普通组件节点不加颜色类。

**边**

```html
<path class="e" data-k="e-start" d="M290 194H448" marker-end="url(#ah)"/>
<text class="el" data-k="e-start" x="369" y="186">取得占用</text>
```

- 起点在源节点的边框上；终点停在目标边框外 2px，箭头尖正好碰到边框。
- 走线用 `H`、`V` 拐直角，需要时用 `C` 画曲线。线与无关节点保持 12px 以上的距离，平行的两条线至少隔 24px，留出写标签的位置。
- 有颜色的边要配同色箭头：`class="e ok"` 配 `url(#ah-ok)`，其余颜色同理。虚线加 `dash`，粗线加 `thick`。
- 边标签：
  - 水平线的标签放在线上方 8px，`x` 取线段中点；
  - 竖线的标签放在线的右侧，用 `class="el start"`，`x = 线 + 8`；或放在左侧，用 `class="el end"`，`x = 线 − 8`。
  - 标签自带底色描边，压在线上也看得清。

**边界框**

```html
<rect class="zone-r" x="372" y="24" width="328" height="330" rx="12"/>
<text class="zone-t" x="388" y="46">执行中 · Driver 持有</text>
```

标题放在 `(x + 16, y + 22)`。框内节点离框顶至少 30px，给标题留出位置。

**联动**

同一条转换的边、它的边标签和表格里对应的行，用同一个 `data-k`。

## 时序图

```html
<div class="seq" style="--n:3">
  <div class="who"><span>客户端</span><span>ControlServer</span><span>Runtime</span></div>
  <div class="m" style="--from:1;--to:2"><span>connect {since}</span></div>
  <div class="m l ok" style="--from:2;--to:1"><span>应答 {seq: N}</span></div>
  <div class="note" style="--from:2;--to:3">同一个同步段内完成</div>
  <div class="phase"><span>客户端按序应用</span></div>
</div>
```

- 列号从 1 开始。消息向左时加 `l`。颜色按语义加 ok、wait、unk、bad 或 accent；异步、可选的消息加 `dash`。
- 一行只写一条消息，标签写「动作 + 关键参数」。
- 列数最好不超过 6。
- 失败分支另画一张时序图，放进 `<details><summary>…</summary><div class="body">…</div></details>`。

## 表格

- 表格放在 `div.scroll > table.tbl` 里。单元格里有长代码、需要换行时，用 `class="tbl wrap"`；不许折行的单元格或代码，加 `class="nowrap"`。
- 状态机配一张转换表，列为：从 / 到 / 触发者 / 条件与位置 / 事件。

## 改完

运行 `.agents/skills/visual-docs/shoot.sh docs/visual/<页面>.html`，逐张看切片。坐标是估算出来的，以渲染结果为准。

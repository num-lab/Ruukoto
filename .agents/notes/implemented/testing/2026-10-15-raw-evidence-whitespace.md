# Agent Note: 原始验证证据保留行尾空格

Status: implemented

## 问题

原始测试日志的诊断空行可能包含空格，统一补丁的空白上下文行也以空格开头。将这些证据入库时，git diff --cached --check 会把数据中的必要字符当成编辑错误；直接修剪又会改变原始输出、补丁和已固定的摘要。

## 决定

仅在[本次证据目录](../../../../.scratch/subagent-roles/evidence/.gitattributes)为原始 .log 与 .patch 设置 whitespace=-blank-at-eol，保留其行尾空格。其他文件仍使用既有空白检查；原始证据的 space-before-tab、末尾空行和独立 EOF 门禁继续执行，不关闭提交钩子或修改历史证据。

## 既有笔记审计

按原始证据、空白、gitattributes 与 whitespace 检索既有笔记，无同题决定。[文风与门禁](../process/2026-10-10-postmortem-and-prose-standards.md)部分重叠，其源码/文档空白与 EOF 要求继续适用；本篇只记录证据数据的局部属性，不改写旧决定或归档。

## 备选方案

修剪日志和补丁最少新增配置，但会改变原始证据和摘要，因此不采用。禁用钩子或全局空白检查可以直接提交，却会放过源码问题；整类关闭 whitespace 又超出已见格式需要，因此只豁免该目录两类原始数据的行尾空格。

## 后果

原始输出和补丁可逐字节复核，提交门禁继续保护源码与文档。代价是该目录这两类数据的行尾空格不再产生诊断，不能把它们当作手写源码存放处。隔离 Git 仓以实际证据核实属性前失败、属性后通过、字节不变，并验证源码行尾空格、证据 space-before-tab 与末尾空行仍失败；结果见[探针记录](../../../../.scratch/subagent-roles/evidence/commit-whitespace-probe.log)。

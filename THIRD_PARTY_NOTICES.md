# 第三方组件说明

## 已退役Letta与保留的进程身份算法

旧运行时来源：https://github.com/letta-ai/letta-code ，基线0.34.24。2026-11-03已从活跃目录移除，源码、原许可和补丁仅存入私有回退包。

当前只保留从该版本提取的进程创建标识算法，位于 asterhabit/scripts/process-start.mjs，用于PID复用保护；不依赖Letta包、服务或配置。Apache-2.0原文保留于 asterhabit/licenses/process-start-Apache-2.0.txt。

## 当前执行与WebSocket依赖

执行后端为本机Codex 0.165.0，路径和二进制指纹记录在私有local-runtime.json，不将安装的Codex二进制重新分发为项目自有代码。QQ使用项目直接依赖ws 8.19.0，原MIT许可随node_modules/ws/LICENSE保留。

## Cherry Studio（仅流程参考）
来源：https://github.com/CherryHQ/cherry-studio ，官方配置文档：https://www.cherryai.com/docs/en/pre-basic/providers/ 。
2026-10-28读取公开文档；仓库标注AGPL-3.0。本轮只参考供应商预设、连接地址、模型目录分离的操作流程，没有复制源码、安装或运行项目、引入其依赖，故不存在采用代码的版本或范围。

## Graphify
来源：https://github.com/Graphify-Labs/graphify
Python 分发包：graphifyy==0.9.95；许可 Apache-2.0，见 graphify/LICENSE。
用途：记忆与角色关联图。graphify/requirements.lock.txt 固定本次迁移沿用的依赖版本。

## QQ 官方机器人 API
QQ 功能通过腾讯 QQ 开放平台官方 API 接入，文档：https://bot.q.qq.com/wiki/develop/api-v2/ 。
本次协议客户端为项目内实现，复用已有 WebSocket 依赖；不引入或分发 NapCat、QQ 客户端或额外官方 SDK。已归档的历史资料仍按其原许可处理。

以上是本次工作区核心组件的来源记录，不是完整依赖许可证清单，也不是主应用自有代码的许可证。发布发行物前仍需按实际包含文件保留相应许可证和声明。

# 星伴 (Asterhabit)

Asterhabit 是使用 Codex 执行后端的多 Agent 伙伴应用，包含 Vue/Tauri 桌面、Node 业务后端、SQLite 记忆和 Graphify 关联索引，支持官方 QQBot、OneBot 和 B站只读观察。

**项目目前处于初期开发阶段，仍有较多 Bug。** 功能、接口和配置方式仍可能调整。

本仓库仅保留运行源码、启动和构建脚本、依赖锁文件及许可证。私人记忆、角色运行状态、登录凭据、本机运行配置、依赖安装目录、构建产物、日志、历史验收资料及 SnowLuma 上游副本均不入库；本地文件仍保留。

## 环境与依赖

Windows 需要 Node.js >=24.22.1、Python、PowerShell 7、WebView2，以及 Tauri 构建所需的 Rust/MSVC 工具链。当前代码依赖外部 Codex 0.166.0，不是独立安装包。

在仓库根目录安装依赖：

```powershell
npm --prefix asterhabit ci
npm --prefix asterhabit/desktop ci
python -m venv graphify/.venv
graphify/.venv/Scripts/python.exe -m pip install -r graphify/requirements.lock.txt
```

现有 Graphify 环境使用 Python 3.14。将 [运行配置示例](asterhabit/local-runtime.example.json) 复制为 `asterhabit/local-runtime.json`，填写本机 PowerShell 目录、Codex 可执行文件路径、版本和 SHA256 指纹。可用 `Get-FileHash -Algorithm SHA256` 读取实际指纹；不要直接使用示例占位值。登录凭据由本机 Codex 管理，不写入仓库。

当前应用启动要求本机已有完成协议迁移的 `asterhabit/state/`；Git 克隆不包含记忆、账号、授权和运行状态，也不提供全新数据初始化流程。恢复现有部署需另外恢复可信的私人数据和本机配置；Windows DPAPI 凭据不可直接跨用户或跨平台复制。

## 构建与启动

```powershell
node asterhabit/scripts/desktop-build.mjs
./Start-Asterhabit.ps1
```

启动脚本使用当前工作区的已构建桌面程序。已有旧数据需要迁移时，应先停止应用和后台，再按原部署流程使用 `asterhabit/scripts/migrate-application.mjs`；不要将空数据目录当作旧数据迁移。

OneBot 的 SnowLuma 实例需要单独安装配置。

## 许可证

项目自有代码仅按 [GNU Lesser General Public License v3.0（LGPL-3.0-only）](LICENSE) 授权。LGPL 第 3 版纳入了 [GPL 第 3 版条款](asterhabit/licenses/GPL-3.0.txt)，该文件作为 LGPL 的配套文本提供。

第三方代码及依赖沿用各自的许可证。来源与许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# boss-cli-mcp

基于 [joohw/boss-cli](https://github.com/joohw/boss-cli) 扩展的 Boss 直聘自动化 CLI 与 MCP 服务。

项目通过 Puppeteer/CDP 驱动本机 Chrome，复用本地登录状态，为 Claude Desktop、Cursor、Zcode 等支持 MCP 的 AI 客户端提供候选人查询、聊天、消息发送、批量回复、推荐搜索和职位管理能力。

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-purple.svg)](https://modelcontextprotocol.io/)

> 本项目会对 Boss 账号执行真实操作。发送消息、打招呼、查看简历和深度匹配前，请确认候选人及参数，并遵守平台规则。

## 功能

- 读取全部或未读候选人列表
- 按姓名或列表序号打开聊天
- 发送单条消息
- 异步批量回复候选人
- 查询批量发送进度和逐人结果
- 索要简历、备注、不合适、交换微信等聊天操作
- 读取推荐候选人和常规搜索结果
- 深度搜索和匹配
- 在线简历预览
- 读取职位列表和职位详情
- CLI 与 stdio MCP 两种调用方式

## 环境要求

- Node.js 20 或更高版本
- 本机已安装 Chrome 或 Chromium
- Windows、macOS 或 Linux
- 可以登录 Boss 直聘企业端的账号

## 安装

### 通过 npm 安装（推荐）

发布后可以直接安装本包：

```powershell
npm install -g boss-cli-mcp
```

安装完成后有两个命令：

```powershell
boss --help       # CLI
boss-cli-mcp      # MCP 服务（stdio）
```

也可以不全局安装，直接使用：

```powershell
npx boss-cli-mcp
```

### 发布到阿里云 npm 仓库

阿里云仓库地址由你们的企业/团队空间决定，不能使用固定公共地址。请在阿里云
Packages 页面复制完整的 npm registry URL（通常以 `/` 结尾），然后在 PowerShell
执行：

```powershell
$registry = "https://packages.aliyun.com/621cab5b756fe0dd8b6d7c29/npm/repo-apxsi/"
npm login --registry=$registry
npm run build
npm publish --registry=$registry
```

验证发布结果：

```powershell
npm view boss-cli-mcp version --registry=$registry
```

如果提示版本已存在，先递增版本号再发布：

```powershell
npm version patch --no-git-tag-version
npm publish --registry=$registry
```

完整的阿里云仓库配置说明见 [`docs/npm-aliyun.md`](docs/npm-aliyun.md)。不要把
Token 写进仓库或提交 `.npmrc`。

在 Zcode、Claude Desktop、Cursor 等 MCP 客户端中，使用 npm 安装后的命令：

```json
{
  "boss-recruiter": {
    "type": "stdio",
    "command": "boss-cli-mcp",
    "args": []
  }
}
```

如果客户端找不到全局命令，请改用 Node 和全局安装目录中的入口：

```powershell
npm root -g
```

然后把 `args` 设置为该目录下 `boss-cli-mcp/dist/mcp/index.js` 的绝对路径。

### 从本仓库运行 MCP

```powershell
git clone https://github.com/bmbbms/boss-cli-mcp.git D:\boss-cli
cd D:\boss-cli
npm install
npm run build
```

构建后的 MCP 入口：

```text
D:\boss-cli\dist\mcp\index.js
```

手动启动测试：

```powershell
& "D:\nodejs\node.exe" "D:\boss-cli\dist\mcp\index.js"
```

MCP 使用 stdio 通信，启动后终端没有普通输出属于正常现象。按 `Ctrl+C` 可以停止测试进程。

### 只安装 CLI

本包同时提供 `boss` CLI 命令：

```powershell
npm install -g boss-cli-mcp
boss help
```

## 配置 MCP 客户端

### Zcode

```json
{
  "boss-recruiter": {
    "type": "stdio",
    "command": "D:\\nodejs\\node.exe",
    "args": [
      "D:\\boss-cli\\dist\\mcp\\index.js"
    ]
  }
}
```

### Claude Desktop

将下面内容加入 Claude Desktop 的 MCP 配置文件：

```json
{
  "mcpServers": {
    "boss-recruiter": {
      "command": "D:\\nodejs\\node.exe",
      "args": [
        "D:\\boss-cli\\dist\\mcp\\index.js"
      ]
    }
  }
}
```

注意：

- `command` 只填写 Node.js 可执行文件路径。
- MCP 文件的完整路径必须是 `args` 中的一个字符串，不能按空格拆分。
- JSON 中的 Windows 反斜杠必须写成 `\\`。
- 修改配置后，需要完全重启或重新加载 MCP 客户端。

如果不确定 Node.js 的安装路径，可以在 PowerShell 执行：

```powershell
(Get-Command node).Source
```

## 首次登录

MCP 客户端连接成功后，调用：

```text
boss_login
```

工具会打开本机 Chrome。完成扫码或验证后，后续操作会复用保存在 `~/.boss-cli/` 中的本地浏览器会话。

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `boss_login` | 打开 Boss 登录页 |
| `boss_list_candidates` | 读取全部或未读候选人 |
| `boss_open_chat` | 按姓名打开聊天 |
| `boss_open_chat_by_index` | 按候选人列表序号打开聊天 |
| `boss_chat_action` | 执行简历、备注、不合适、微信等聊天操作 |
| `boss_send_message` | 向当前会话发送单条消息 |
| `boss_batch_send_messages` | 启动异步批量发送任务 |
| `boss_batch_send_status` | 查询批量发送任务进度和结果 |
| `boss_list_positions` | 读取职位列表或职位详情 |
| `boss_deep_search` | 设置深度搜索条件或执行匹配 |
| `boss_normal_search` | 执行常规候选人搜索 |
| `boss_recommend` | 异步读取推荐候选人，返回 `taskId` |
| `boss_preview_candidate` | 预览在线简历 |
| `boss_greet_candidate` | 异步向推荐或搜索结果中的候选人打招呼，返回 `taskId` |
| `boss_async_task_status` | 查询推荐、打招呼和批量发送任务 |
| `boss_cancel_task` | 请求取消正在运行的异步任务 |
| `boss_mcp_health` | 检查 MCP、Chrome CDP 和任务状态 |
| `boss_set_baidu_credentials` | 设置百度 OCR 凭据 |

## 批量回复消息

### 推荐流程

1. 调用 `boss_list_candidates`，先获取候选人列表。
2. 将列表展示给用户并人工确认。
3. 调用 `boss_batch_send_messages` 启动任务。
4. 保存返回的 `taskId`。
5. 调用 `boss_batch_send_status` 查询进度，直到状态变为 `completed` 或 `failed`。

### 启动批量发送

```json
{
  "messages": [
    {
      "candidateId": "123456789-0",
      "candidateName": "张三",
      "text": "您好，感谢您的关注，请问方便补充一下简历吗？",
      "exact": true
    },
    {
      "candidateId": "987654321-0",
      "candidateName": "李四",
      "text": "您好，感谢您的关注，请问方便补充一下简历吗？",
      "exact": true
    }
  ],
  "confirm": true,
  "confirmationText": "确认给张三、李四发送消息"
}
```

默认异步启动并立即返回：

```json
{
  "taskId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "status": "running",
  "total": 2,
  "processed": 0,
  "sent": 0,
  "failed": 0
}
```

### 查询任务状态

调用 `boss_batch_send_status`：

```json
{
  "taskId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

完成后返回类似：

```json
{
  "status": "completed",
  "total": 2,
  "sent": 1,
  "failed": 1,
  "results": [
    {
      "candidateName": "张三",
      "status": "sent"
    },
    {
      "candidateName": "李四",
      "status": "failed",
      "error": "未找到候选人"
    }
  ]
}
```

参数说明：

- `candidateId`：候选人会话稳定 ID，必须从最新的 `boss_list_candidates` 或 `chat-list` 结果获取；批量工具按此 ID 定位，不按姓名回退。
- `candidateName`：候选人姓名，用于打开后的姓名校验和结果展示。
- `text`：要发送的消息正文。
- `exact`：是否精确匹配姓名，建议保持 `true`。
- `confirm`：必须显式设置为 `true`，否则不会发送。
- `confirmationText`：必须等于候选人摘要，例如 `确认给张三、李四发送消息`。
- `dryRun`：设为 `true` 只校验并预览，不会打开聊天或发送消息。
- `waitForCompletion`：默认 `false`。不建议改成 `true`，否则首次加载页面时可能触发 MCP 客户端超时。

批量工具会串行处理候选人，并实时记录 `processed`、`sent`、`failed`、`currentCandidate` 和每人的结果。单次最多 20 人。单个候选人失败不会阻止后续候选人继续执行；重复候选人、空消息和超过 2,000 字的消息会在启动前拒绝。同一 MCP 进程同时只运行一个浏览器写操作任务。

### 推荐和打招呼任务

`boss_recommend` 与 `boss_greet_candidate` 默认立即返回 `taskId`，不会等待页面加载完成。
使用 `boss_async_task_status` 查询：

```json
{
  "taskId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

## 在 AI 客户端中的示例提示词

```text
调用 boss_list_candidates 获取未读候选人，将列表展示给我并等待确认。
我确认后，使用 boss_batch_send_messages 逐个发送指定消息。
必须精确匹配姓名，设置 confirm=true，并提供 confirmationText。
取得 taskId 后，定期调用 boss_batch_send_status，最后汇总成功和失败结果。
```

## CLI 快速使用

```powershell
# 登录
boss login

# 查看未读候选人
boss list --unread

# 打开聊天并发送消息
boss chat 张三 --strict
boss send --text "您好，请问方便发一下简历吗？"

# 查看推荐候选人
boss recommend 前端工程师

# 常规搜索
boss search "AI 产品经理"
```

完整 CLI 参数：

```powershell
boss help
```

## 常见问题

### MCP 启动时报 `Cannot find module`

通常是带空格的路径被拆成了多个参数。确保完整 MCP 路径是 `args` 数组中的一个字符串：

```json
"args": ["D:\\boss-cli\\dist\\mcp\\index.js"]
```

### MCP 首次调用超时

首次调用需要启动或连接 Chrome，并加载 Boss 页面，耗时可能较长。批量发送默认使用异步任务，因此应保存 `taskId` 并使用 `boss_batch_send_status` 查询，而不是重复启动任务。

如果一次同步调用显示超时，操作可能仍在浏览器中继续执行。重试发送前先检查聊天记录，避免重复消息。

### 修改源码后 MCP 工具没有更新

重新构建并重启 MCP 客户端：

```powershell
cd D:\boss-cli
npm run build
```

### 数据保存在哪里

| 路径 | 内容 |
| --- | --- |
| `~/.boss-cli/.cache/` | Cookie、浏览器用户数据和登录状态 |
| `~/.boss-cli/jd/` | 缓存的职位描述 |

这些数据保存在本机，不应提交到 GitHub。

## 开发

```powershell
npm install
npm run build
npm run mcp
```

MCP 主要实现位于：

- `src/mcp/index.ts`
- `src/toolset/`
- `docs/mcp.md`

## 上游与许可证

本仓库基于 [joohw/boss-cli](https://github.com/joohw/boss-cli) 开发，保留原项目的 GPL-3.0 许可证。

本仓库新增了 MCP 服务、MCP 客户端文档、批量发送及异步任务状态查询能力。

详见 [LICENSE](./LICENSE)。

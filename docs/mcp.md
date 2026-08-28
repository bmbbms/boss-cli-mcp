# boss-cli MCP 服务

本项目提供基于 stdio 的 MCP 服务，直接复用 `src/toolset` 业务实现和
`~/.boss-cli/` 中的本地 Chrome 登录态。

## 本地运行

要求 Node.js 20 或更高版本：

```bash
npm install
npm run build
node dist/mcp/index.js
```

MCP 服务使用 stdio 通信，直接在终端运行时不会显示交互提示，这是正常行为。
运行日志同时写入 `~/.boss-cli/logs/mcp.log`，并保留输出到 stderr；日志目录或文件无法创建时，MCP 会直接启动失败并报告原因。

## npm 安装

发布后的 npm 包名称为 `boss-cli-mcp`：

```bash
npm install -g boss-cli-mcp
boss-cli-mcp
```

或者直接运行：

```bash
npx boss-cli-mcp
```

在 MCP 客户端中优先使用 `boss-cli-mcp` 作为 stdio `command`；如果客户端不继承
系统 PATH，则将 `dist/mcp/index.js` 配置为绝对路径，并使用 Node.js 20 或更高版本。

## 客户端配置

在 Claude Desktop、Cursor 或其他支持 stdio MCP 的客户端中加入：

```json
{
  "mcpServers": {
    "boss-cli": {
      "command": "node",
      "args": [
        "C:\\absolute\\path\\to\\boss-cli\\dist\\mcp\\index.js"
      ]
    }
  }
}
```

把路径改为本机仓库的绝对路径。首次使用时调用 `boss_login`，然后在打开的
Chrome 中完成登录。

## MCP 工具

- `boss_login`
- `boss_list_candidates`
- `boss_open_chat`
- `boss_open_chat_by_index`
- `boss_chat_action`
- `boss_send_message`
- `boss_batch_send_messages`
- `boss_batch_send_status`
- `boss_list_positions`
- `boss_deep_search`
- `boss_normal_search`
- `boss_recommend`
- `boss_preview_candidate`
- `boss_greet_candidate`
- `boss_async_task_status`
- `boss_cancel_task`
- `boss_mcp_health`
- `boss_set_baidu_credentials`
- `boss_candidate_automation`

`boss_deep_search` 只有在 `match=true` 时才会执行匹配并消耗次数。发送消息、
打招呼、查看在线简历等操作会真实影响 Boss 账号，请在调用前确认参数。

批量回复示例：

```json
{
  "messages": [
    {
      "candidateName": "张三",
      "text": "您好，感谢您的关注，请问方便补充一下简历吗？",
      "exact": true
    },
    {
      "candidateName": "李四",
      "text": "您好，感谢您的关注，请问方便补充一下简历吗？",
      "exact": true
    }
  ],
  "confirm": true,
  "confirmationText": "确认给张三、李四发送消息"
}
```

如需先检查名单和确认摘要而不产生任何浏览器操作，可设置 `dryRun: true`；正式发送时
必须设置 `confirm: true`，并传入返回结果中的 `confirmationText`。

建议先调用 `boss_list_candidates` 获取候选人姓名，确认列表无误后再调用批量工具。
批量工具默认异步启动，立即返回 `taskId`，避免首次加载页面时触发 MCP 超时；随后使用
`boss_batch_send_status` 查询进度和 `sent` / `failed` 结果。设置 `waitForCompletion=true`
可以改为等待全部发送完成，但页面首次加载较慢时可能超时。工具不会自动发送求简历操作。

任务运行时会实时更新 `processed`、`sent`、`failed`、`currentCandidate` 和 `results`。批量发送会为每个“候选人+消息指纹”写入 `~/.boss-cli/.cache/candidate-actions.json`：发送前先预占，打开会话后复核己方聊天记录，发送后必须再次确认消息已出现；未确认成功时不会自动重试，避免重复发送。
单次最多发送 20 人。
同一 MCP 进程同时只允许一个浏览器写操作任务，避免多个任务切换同一个聊天页面。
任务默认最长运行 30 分钟，完成后的任务状态在内存中保留 1 小时；MCP 重启后旧的
`taskId` 不再可查询。可以调用 `boss_cancel_task` 请求取消任务，调用 `boss_mcp_health`
检查 MCP、Chrome CDP 连接和当前页面。

`boss_recommend` 和 `boss_greet_candidate` 也默认异步执行，立即返回 `taskId`。使用
`boss_async_task_status` 查询结果；这样推荐页加载、列表刷新或平台风控等待不会阻塞 MCP 请求。

`boss_candidate_automation` 支持 `scope=recommend` 分析当前推荐卡片，`scope=chat` 分析当前打开会话，或 `scope=chat-list` 异步依次处理当前会话列表。`chat-list` 会自动识别列表滚动容器，逐轮滚动并累计虚拟列表中的候选人，直到到达底部且连续无新增，再恢复到列表顶部。调用会立即返回 `taskId`，使用 `boss_async_task_status` 查看 `phase`、`total`、`processed`、`currentCandidate`、`matched` 和 `failed` 进度；`batchSize` 默认 5，用于控制批次间节奏（浏览器写操作仍保持串行，避免同时切换同一会话）。默认 `execute=false` 只分析和匹配；执行真实打招呼、回复、求简历或标记不合适时必须同时设置 `execute=true` 和 `confirm=true`。发送前会检查聊天记录和本地 `~/.boss-cli/.cache/candidate-actions.json`，避免重复发送。

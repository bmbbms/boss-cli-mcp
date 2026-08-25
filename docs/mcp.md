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
- `boss_set_baidu_credentials`

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
  "confirm": true
}
```

建议先调用 `boss_list_candidates` 获取候选人姓名，确认列表无误后再调用批量工具。
批量工具默认异步启动，立即返回 `taskId`，避免首次加载页面时触发 MCP 超时；随后使用
`boss_batch_send_status` 查询进度和 `sent` / `failed` 结果。设置 `waitForCompletion=true`
可以改为等待全部发送完成，但页面首次加载较慢时可能超时。工具不会自动发送求简历操作。

`boss_recommend` 和 `boss_greet_candidate` 也默认异步执行，立即返回 `taskId`。使用
`boss_async_task_status` 查询结果；这样推荐页加载、列表刷新或平台风控等待不会阻塞 MCP 请求。

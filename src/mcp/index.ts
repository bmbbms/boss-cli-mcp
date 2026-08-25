#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { APP_HOME } from '../config.js';
import {
  implBossSearch,
  implChatAction,
  implLogin,
  implListCandidates,
  implListPositionsWithOptions,
  implListUnreadCandidates,
  implNormalSearch,
  implOpenChat,
  implOpenChatByIndex,
  implPreview,
  implRecommend,
  implRecommendGreet,
  implSendMessage,
  implSetBaiduCredentials,
  type ChatPageAction,
} from '../toolset/index.js';

// Keep MCP and the CLI on the same local configuration and browser session.
const userEnvPath = join(APP_HOME, '.env');
if (existsSync(userEnvPath)) {
  loadEnv({ path: userEnvPath, quiet: true });
}
loadEnv({ quiet: true });

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text: text.trimEnd() }] };
}

type BatchMessage = {
  candidateName: string;
  text: string;
  exact: boolean;
};

type BatchTask = {
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  total: number;
  sent: number;
  failed: number;
  results: Array<{
    candidateName: string;
    status: 'sent' | 'failed';
    message?: string;
    error?: string;
  }>;
  error?: string;
};

const batchTasks = new Map<string, BatchTask>();

type AsyncBrowserTask = {
  taskId: string;
  operation: 'recommend' | 'greet';
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
};

const asyncBrowserTasks = new Map<string, AsyncBrowserTask>();

function startAsyncBrowserTask(
  operation: AsyncBrowserTask['operation'],
  run: () => Promise<string>,
): string {
  const taskId = randomUUID();
  const task: AsyncBrowserTask = { taskId, operation, status: 'running' };
  asyncBrowserTasks.set(taskId, task);
  void run()
    .then((result) => {
      task.status = 'completed';
      task.result = result;
    })
    .catch((error) => {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
    });
  return JSON.stringify(
    {
      taskId,
      operation,
      status: task.status,
      message: '异步任务已启动，请使用 boss_async_task_status 查询结果。',
    },
    null,
    2,
  );
}

async function runBatchSendMessages(
  messages: BatchMessage[],
  confirm: boolean,
): Promise<string> {
  if (!confirm) {
    throw new Error('批量发送是实际账号操作；请将 confirm 设置为 true 后再执行。');
  }

  const results: Array<{
    candidateName: string;
    status: 'sent' | 'failed';
    message?: string;
    error?: string;
  }> = [];

  for (const item of messages) {
    try {
      await implOpenChat(item.candidateName, item.exact);
      const result = await implSendMessage({ text: item.text, requestResume: false });
      results.push({ candidateName: item.candidateName, status: 'sent', message: result });
    } catch (error) {
      results.push({
        candidateName: item.candidateName,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return JSON.stringify(
    {
      total: results.length,
      sent: results.filter((item) => item.status === 'sent').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    },
    null,
    2,
  );
}

function startBatchSendMessages(messages: BatchMessage[], confirm: boolean): string {
  if (!confirm) {
    throw new Error('批量发送是实际账号操作；请将 confirm 设置为 true 后再执行。');
  }

  const taskId = randomUUID();
  const task: BatchTask = {
    taskId,
    status: 'running',
    total: messages.length,
    sent: 0,
    failed: 0,
    results: [],
  };
  batchTasks.set(taskId, task);

  void runBatchSendMessages(messages, true)
    .then((summary) => {
      const parsed = JSON.parse(summary) as Pick<BatchTask, 'sent' | 'failed' | 'results'>;
      task.status = 'completed';
      task.sent = parsed.sent;
      task.failed = parsed.failed;
      task.results = parsed.results;
    })
    .catch((error) => {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
    });

  return JSON.stringify(
    {
      taskId,
      status: task.status,
      total: task.total,
      message: '批量发送任务已启动，请使用 boss_batch_send_status 查询进度。',
    },
    null,
    2,
  );
}

const server = new McpServer({
  name: 'boss-cli',
  version: '0.6.6',
});

server.registerTool(
  'boss_login',
  {
    description: '打开 Boss 直聘登录页。需要用户在本机 Chrome 中完成扫码或验证。',
  },
  async () => textResult(await implLogin()),
);

server.registerTool(
  'boss_list_candidates',
  {
    description: '读取 Boss 直聘聊天列表，可选择只返回未读候选人。',
    inputSchema: { unreadOnly: z.boolean().optional().describe('是否只返回未读候选人') },
  },
  async ({ unreadOnly }) =>
    textResult(await (unreadOnly ? implListUnreadCandidates() : implListCandidates())),
);

server.registerTool(
  'boss_open_chat',
  {
    description: '按候选人姓名打开 Boss 直聘聊天会话。默认模糊匹配，可用 exact 精确匹配。',
    inputSchema: {
      candidateName: z.string().min(1),
      exact: z.boolean().optional().default(false),
    },
  },
  async ({ candidateName, exact }) => textResult(await implOpenChat(candidateName, exact)),
);

server.registerTool(
  'boss_open_chat_by_index',
  {
    description: '按 boss_list_candidates 返回的 1-based 序号打开聊天会话。',
    inputSchema: {
      index: z.number().int().min(1),
      unreadOnly: z.boolean().optional().default(false),
      expectedName: z.string().optional(),
      exact: z.boolean().optional().default(false),
    },
  },
  async (args) => textResult(await implOpenChatByIndex(args)),
);

server.registerTool(
  'boss_chat_action',
  {
    description: '对当前已打开的候选人聊天执行操作。',
    inputSchema: {
      action: z.enum([
        'resume',
        'not-fit',
        'remark',
        'agree-resume',
        'request-attachment-resume',
        'history',
        'exchange-wechat',
      ] as [ChatPageAction, ...ChatPageAction[]]),
      remark: z.string().optional(),
    },
  },
  async ({ action, remark }) => textResult(await implChatAction({ action, remark })),
);

server.registerTool(
  'boss_send_message',
  {
    description: '向当前已打开的聊天会话发送文本消息。可选自动执行求简历。',
    inputSchema: {
      text: z.string().min(1),
      requestResume: z.boolean().optional().default(false),
    },
  },
  async ({ text, requestResume }) => textResult(await implSendMessage({ text, requestResume })),
);

server.registerTool(
  'boss_batch_send_messages',
  {
    description:
      '按候选人姓名逐个打开聊天并发送消息。工具会串行执行，返回每位候选人的发送结果；必须显式确认真实发送。',
    inputSchema: {
      messages: z
        .array(
          z.object({
            candidateName: z.string().min(1).describe('候选人姓名；建议来自 boss_list_candidates 的结果'),
            text: z.string().min(1).describe('要发送的消息正文'),
            exact: z.boolean().optional().default(true).describe('是否精确匹配姓名，默认 true'),
          }),
        )
        .min(1)
        .max(100),
      confirm: z.boolean().default(false).describe('确认对这些候选人执行真实发送，必须为 true'),
      waitForCompletion: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否等待全部发送完成；默认 false，避免页面首次加载导致 MCP 超时'),
    },
  },
  async ({ messages, confirm, waitForCompletion }) =>
    textResult(
      waitForCompletion
        ? await runBatchSendMessages(messages, confirm)
        : startBatchSendMessages(messages, confirm),
    ),
);

server.registerTool(
  'boss_batch_send_status',
  {
    description: '查询 boss_batch_send_messages 异步任务的进度和逐人发送结果。',
    inputSchema: { taskId: z.string().uuid() },
  },
  async ({ taskId }) => {
    const task = batchTasks.get(taskId);
    if (!task) {
      throw new Error(`找不到批量发送任务: ${taskId}`);
    }
    return textResult(JSON.stringify(task, null, 2));
  },
);

server.registerTool(
  'boss_list_positions',
  {
    description: '读取当前 Boss 直聘职位列表；可按名称抓取职位详情并缓存为 Markdown。',
    inputSchema: {
      detail: z.boolean().optional().default(false),
      name: z.string().optional(),
    },
  },
  async ({ detail, name }) => textResult(await implListPositionsWithOptions({ detail, name })),
);

server.registerTool(
  'boss_deep_search',
  {
    description: '读取或更新深度搜索条件；只有 match=true 时才会消耗匹配次数并执行匹配。',
    inputSchema: {
      jobKeyword: z.string().optional(),
      coreRequirements: z.array(z.string()).optional(),
      bonusRequirements: z.array(z.string()).optional(),
      match: z.boolean().optional().default(false),
    },
  },
  async ({ jobKeyword, coreRequirements, bonusRequirements, match }) =>
    textResult(await implBossSearch({ jobKeyword, coreRequirements, bonusRequirements, match })),
);

server.registerTool(
  'boss_normal_search',
  {
    description: '进入 Boss 直聘常规搜索页并读取搜索结果。',
    inputSchema: { keyword: z.string().optional() },
  },
  async ({ keyword }) => textResult(await implNormalSearch(keyword)),
);

server.registerTool(
  'boss_recommend',
  {
    description:
      '异步进入推荐页并读取推荐候选人列表，可按岗位关键字切换职位。立即返回 taskId，避免页面加载导致 MCP 超时。',
    inputSchema: { jobKeyword: z.string().optional() },
  },
  async ({ jobKeyword }) =>
    textResult(startAsyncBrowserTask('recommend', () => implRecommend(jobKeyword))),
);

server.registerTool(
  'boss_preview_candidate',
  {
    description: '预览当前推荐、深度搜索或常规搜索列表中的候选人在线简历。',
    inputSchema: { candidateTarget: z.string().min(1) },
  },
  async ({ candidateTarget }) => textResult(await implPreview({ candidateTarget })),
);

server.registerTool(
  'boss_greet_candidate',
  {
    description:
      '异步在当前推荐或深度搜索列表中对候选人执行打招呼。立即返回 taskId，避免页面加载和风控等待导致 MCP 超时。',
    inputSchema: {
      candidateTarget: z.string().min(1),
      jobKeyword: z.string().optional(),
    },
  },
  async ({ candidateTarget, jobKeyword }) =>
    textResult(
      startAsyncBrowserTask('greet', () => implRecommendGreet({ candidateTarget, jobKeyword })),
    ),
);

server.registerTool(
  'boss_async_task_status',
  {
    description:
      '查询 boss_recommend、boss_greet_candidate 或批量发送工具返回的异步 taskId。',
    inputSchema: { taskId: z.string().uuid() },
  },
  async ({ taskId }) => {
    const browserTask = asyncBrowserTasks.get(taskId);
    if (browserTask) {
      return textResult(JSON.stringify(browserTask, null, 2));
    }
    const batchTask = batchTasks.get(taskId);
    if (batchTask) {
      return textResult(JSON.stringify(batchTask, null, 2));
    }
    throw new Error(`找不到异步任务: ${taskId}`);
  },
);

server.registerTool(
  'boss_set_baidu_credentials',
  {
    description: '设置百度 OCR 凭据（写入本机 boss-cli 配置）。',
    inputSchema: {
      apiKey: z.string().min(1),
      secretKey: z.string().min(1),
    },
  },
  async ({ apiKey, secretKey }) => textResult(await implSetBaiduCredentials(apiKey, secretKey)),
);

const transport = new StdioServerTransport();
await server.connect(transport);

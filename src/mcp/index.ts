#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
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
  implOpenAndSendMessage,
  implOpenChat,
  implOpenChatByIndex,
  implPreview,
  implRecommend,
  implRecommendGreet,
  implSendMessage,
  implSetBaiduCredentials,
  runCandidateAutomation,
  type ChatPageAction,
} from '../toolset/index.js';
import type { CandidateRequirements } from '../toolset/candidate_profile.js';
import { getBrowserRef, getPageRef } from '../browser/browser_session.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version?: string };
const MCP_VERSION = packageJson.version ?? '0.1.0';

// Keep MCP and the CLI on the same local configuration and browser session.
const userEnvPath = join(APP_HOME, '.env');
if (existsSync(userEnvPath)) {
  loadEnv({ path: userEnvPath, quiet: true });
}
loadEnv({ quiet: true });

// Read runtime settings only after both supported .env locations are loaded.
// Otherwise values in ~/.boss-cli/.env are silently ignored at module startup.
const TASK_TIMEOUT_MS = Number.parseInt(process.env.BOSS_MCP_TASK_TIMEOUT_MS ?? '', 10) || 30 * 60_000;
const TASK_TTL_MS = Number.parseInt(process.env.BOSS_MCP_TASK_TTL_MS ?? '', 10) || 60 * 60_000;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_BATCH_SIZE = 20;
const MCP_LOG_DIR = join(APP_HOME, 'logs');
const MCP_LOG_FILE = join(MCP_LOG_DIR, 'mcp.log');

mkdirSync(MCP_LOG_DIR, { recursive: true });

function mcpLog(event: string, fields: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    event,
    pid: process.pid,
    ...fields,
  })}\n`;
  appendFileSync(MCP_LOG_FILE, line, { encoding: 'utf8' });
  process.stderr.write(line);
}

mcpLog('startup', {
  version: MCP_VERSION,
  node: process.version,
  cwd: process.cwd(),
  entrypoint: process.argv[1] ?? null,
});

function textResult(text: string) {
  const trimmed = text.trimEnd();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        content: [{ type: 'text' as const, text: trimmed }],
        structuredContent: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // Plain-text tool responses remain text-only for backwards compatibility.
  }
  return { content: [{ type: 'text' as const, text: trimmed }] };
}

type BatchMessage = {
  candidateName: string;
  text: string;
  exact: boolean;
};

type BatchTask = {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  sent: number;
  failed: number;
  processed: number;
  currentCandidate?: string;
  startedAt: string;
  completedAt?: string;
  cancelRequested?: boolean;
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
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  cancelRequested?: boolean;
  result?: string;
  error?: string;
};

const asyncBrowserTasks = new Map<string, AsyncBrowserTask>();
const taskControllers = new Map<string, AbortController>();
let activeBatchTaskId: string | null = null;
let activeBrowserTaskId: string | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function cleanupExpiredTasks(): void {
  const cutoff = Date.now() - TASK_TTL_MS;
  for (const [taskId, task] of batchTasks) {
    const completedAt = task.completedAt ? Date.parse(task.completedAt) : 0;
    if (completedAt > 0 && completedAt < cutoff) batchTasks.delete(taskId);
  }
  for (const [taskId, task] of asyncBrowserTasks) {
    const completedAt = task.completedAt ? Date.parse(task.completedAt) : 0;
    if (completedAt > 0 && completedAt < cutoff) asyncBrowserTasks.delete(taskId);
  }
}

const taskCleanupTimer = setInterval(cleanupExpiredTasks, Math.min(TASK_TTL_MS, 5 * 60_000));
taskCleanupTimer.unref();

function buildConfirmationText(messages: BatchMessage[]): string {
  return `确认给${messages.map((item) => item.candidateName).join('、')}发送消息`;
}

function normalizeBatchMessages(messages: BatchMessage[]): BatchMessage[] {
  if (messages.length > MAX_BATCH_SIZE) {
    throw new Error(`单次最多发送 ${MAX_BATCH_SIZE} 人。`);
  }
  const normalized = messages.map((item) => ({
    candidateName: item.candidateName.trim(),
    text: item.text.trim(),
    exact: item.exact !== false,
  }));
  const seen = new Set<string>();
  for (const item of normalized) {
    if (!item.candidateName) throw new Error('候选人姓名不能为空。');
    if (!item.text) throw new Error(`候选人「${item.candidateName}」的消息不能为空。`);
    if (item.text.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`候选人「${item.candidateName}」的消息超过 ${MAX_MESSAGE_LENGTH} 个字符。`);
    }
    const key = item.candidateName.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`批量列表中存在重复候选人：${item.candidateName}`);
    seen.add(key);
  }
  return normalized;
}

function startAsyncBrowserTask(
  operation: AsyncBrowserTask['operation'],
  run: (signal: AbortSignal) => Promise<string>,
): string {
  if (activeBrowserTaskId) {
    throw new Error(`已有浏览器异步任务正在运行：${activeBrowserTaskId}`);
  }
  const taskId = randomUUID();
  const controller = new AbortController();
  const task: AsyncBrowserTask = { taskId, operation, status: 'running', startedAt: nowIso() };
  asyncBrowserTasks.set(taskId, task);
  taskControllers.set(taskId, controller);
  activeBrowserTaskId = taskId;
  mcpLog('task_started', { taskId, operation });
  const timeout = setTimeout(() => {
    task.cancelRequested = true;
    controller.abort(new Error(`异步任务超过 ${TASK_TIMEOUT_MS / 1000}s，已请求停止。`));
  }, TASK_TIMEOUT_MS);
  void run(controller.signal)
    .then((result) => {
      clearTimeout(timeout);
      if (task.cancelRequested) {
        task.status = 'cancelled';
        task.error = `异步任务超过 ${TASK_TIMEOUT_MS / 1000}s。`;
      } else {
        task.status = 'completed';
        task.result = result;
      }
      task.completedAt = nowIso();
      mcpLog('task_finished', { taskId, operation, status: task.status });
    })
    .catch((error) => {
      clearTimeout(timeout);
      task.status = task.cancelRequested ? 'cancelled' : 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = nowIso();
      mcpLog('task_finished', { taskId, operation, status: task.status, error: task.error });
    })
    .finally(() => {
      taskControllers.delete(taskId);
      if (activeBrowserTaskId === taskId) activeBrowserTaskId = null;
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
  task?: BatchTask,
  signal?: AbortSignal,
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
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('批量任务已取消。');
    }
    if (task) task.currentCandidate = item.candidateName;
    try {
      const result = await implOpenAndSendMessage({
        candidateName: item.candidateName,
        text: item.text,
        exact: item.exact,
        signal,
      });
      results.push({ candidateName: item.candidateName, status: 'sent', message: result });
    } catch (error) {
      results.push({
        candidateName: item.candidateName,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (task) {
      task.processed = results.length;
      task.sent = results.filter((item) => item.status === 'sent').length;
      task.failed = results.filter((item) => item.status === 'failed').length;
      task.results = [...results];
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

async function runBatchSendMessagesWithLifecycle(
  messages: BatchMessage[],
  confirm: boolean,
): Promise<string> {
  if (activeBrowserTaskId) {
    throw new Error(`已有浏览器任务正在运行：${activeBrowserTaskId}`);
  }
  const taskId = randomUUID();
  const controller = new AbortController();
  const task: BatchTask = {
    taskId,
    status: 'running',
    total: messages.length,
    sent: 0,
    failed: 0,
    processed: 0,
    startedAt: nowIso(),
    results: [],
  };
  activeBrowserTaskId = taskId;
  mcpLog('task_started', { taskId, operation: 'batch_send', total: messages.length, waitForCompletion: true });
  const timeout = setTimeout(() => controller.abort(new Error(`批量任务超过 ${TASK_TIMEOUT_MS / 1000}s。`)), TASK_TIMEOUT_MS);
  let taskStatus: 'completed' | 'failed' = 'completed';
  try {
    return await runBatchSendMessages(messages, confirm, task, controller.signal);
  } catch (error) {
    taskStatus = 'failed';
    mcpLog('task_failed', {
      taskId,
      operation: 'batch_send',
      waitForCompletion: true,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    activeBrowserTaskId = null;
    mcpLog('task_finished', { taskId, operation: 'batch_send', status: taskStatus, waitForCompletion: true });
  }
}

function startBatchSendMessages(messages: BatchMessage[], confirm: boolean): string {
  if (!confirm) {
    throw new Error('批量发送是实际账号操作；请将 confirm 设置为 true 后再执行。');
  }

  if (activeBrowserTaskId) {
    throw new Error(`已有浏览器任务正在运行：${activeBrowserTaskId}`);
  }
  const taskId = randomUUID();
  const controller = new AbortController();
  const task: BatchTask = {
    taskId,
    status: 'running',
    total: messages.length,
    sent: 0,
    failed: 0,
    processed: 0,
    startedAt: nowIso(),
    results: [],
  };
  batchTasks.set(taskId, task);
  taskControllers.set(taskId, controller);
  activeBatchTaskId = taskId;
  activeBrowserTaskId = taskId;
  mcpLog('task_started', { taskId, operation: 'batch_send', total: messages.length, waitForCompletion: false });
  const timeout = setTimeout(() => {
    task.cancelRequested = true;
    controller.abort(new Error(`批量任务超过 ${TASK_TIMEOUT_MS / 1000}s，已请求停止。`));
  }, TASK_TIMEOUT_MS);

  void runBatchSendMessages(messages, true, task, controller.signal)
    .then((summary) => {
      const parsed = JSON.parse(summary) as Pick<BatchTask, 'sent' | 'failed' | 'results'>;
      task.status = task.cancelRequested ? 'cancelled' : 'completed';
      task.sent = parsed.sent;
      task.failed = parsed.failed;
      task.results = parsed.results;
      task.currentCandidate = undefined;
      task.processed = messages.length;
      task.completedAt = nowIso();
      if (task.cancelRequested) task.error = '批量任务已取消或超时。';
      mcpLog('task_finished', { taskId, operation: 'batch_send', status: task.status, sent: task.sent, failed: task.failed });
    })
    .catch((error) => {
    task.status = task.cancelRequested ? 'cancelled' : 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = nowIso();
      mcpLog('task_finished', { taskId, operation: 'batch_send', status: task.status, error: task.error });
    })
    .finally(() => {
      clearTimeout(timeout);
      taskControllers.delete(taskId);
      if (activeBatchTaskId === taskId) activeBatchTaskId = null;
      if (activeBrowserTaskId === taskId) activeBrowserTaskId = null;
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
  version: MCP_VERSION,
});

server.registerTool(
  'boss_candidate_automation',
  {
    description: '分析推荐页或当前会话候选人简历字段，并按职位条件预览或执行打招呼/回复/求简历/不合适操作。',
    inputSchema: {
      scope: z.enum(['recommend', 'chat', 'chat-list']),
      execute: z.boolean().optional().default(false),
      confirm: z.boolean().optional().default(false),
      message: z.string().optional(),
      requestResume: z.boolean().optional().default(false),
      receiveResume: z.boolean().optional().default(false),
      requirements: z.object({
        gender: z.enum(['男', '女', '不限']).optional(),
        ageMin: z.number().int().optional(),
        ageMax: z.number().int().optional(),
        educationMin: z.string().optional(),
        workYearsMin: z.number().optional(),
        workYearsMax: z.number().optional(),
        positionKeywords: z.array(z.string()).optional(),
        salaryMin: z.number().optional(),
        locationKeywords: z.array(z.string()).optional(),
      }).optional(),
    },
  },
  async ({ scope, execute, confirm, message, requestResume, receiveResume, requirements }) =>
    textResult(await runCandidateAutomation({
      scope,
      execute,
      confirm,
      message,
      requestResume,
      receiveResume,
      requirements: requirements as CandidateRequirements | undefined,
    })),
);

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
      '按候选人姓名逐个打开聊天并发送消息。工具会串行执行，最多 20 人；必须显式确认真实发送。',
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
        .max(MAX_BATCH_SIZE),
      confirm: z.boolean().default(false).describe('确认对这些候选人执行真实发送，必须为 true'),
      confirmationText: z
        .string()
        .optional()
        .describe('确认摘要，必须等于“确认给张三、李四发送消息”这类文本'),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe('仅校验并预览发送列表，不打开聊天也不发送消息'),
      waitForCompletion: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否等待全部发送完成；默认 false，避免页面首次加载导致 MCP 超时'),
    },
  },
  async ({ messages, confirm, confirmationText, dryRun, waitForCompletion }) => {
    const normalized = normalizeBatchMessages(messages);
    if (dryRun) {
      return textResult(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            total: normalized.length,
            confirmationText: buildConfirmationText(normalized),
            messages: normalized,
          },
          null,
          2,
        ),
      );
    }
    if (confirm && confirmationText !== buildConfirmationText(normalized)) {
      throw new Error(`确认文本不匹配。请传入：${buildConfirmationText(normalized)}`);
    }
    return textResult(
      waitForCompletion
        ? await runBatchSendMessagesWithLifecycle(normalized, confirm)
        : startBatchSendMessages(normalized, confirm),
    );
  },
);

server.registerTool(
  'boss_batch_send_status',
  {
    description: '查询 boss_batch_send_messages 异步任务的进度和逐人发送结果。',
    inputSchema: { taskId: z.string().uuid() },
  },
  async ({ taskId }) => {
    cleanupExpiredTasks();
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
    textResult(startAsyncBrowserTask('recommend', (signal) => implRecommend(jobKeyword, signal))),
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
      startAsyncBrowserTask('greet', (signal) =>
        implRecommendGreet({ candidateTarget, jobKeyword, signal }),
      ),
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
    cleanupExpiredTasks();
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
  'boss_cancel_task',
  {
    description: '请求取消正在运行的推荐、打招呼或批量发送任务。浏览器当前动作结束后才会停止。',
    inputSchema: { taskId: z.string().uuid() },
  },
  async ({ taskId }) => {
    cleanupExpiredTasks();
    const batchTask = batchTasks.get(taskId);
    const browserTask = asyncBrowserTasks.get(taskId);
    const task = batchTask ?? browserTask;
    if (!task) throw new Error(`找不到异步任务: ${taskId}`);
    if (task.status !== 'running') {
      return textResult(JSON.stringify({ taskId, status: task.status, cancelled: false }, null, 2));
    }
    task.cancelRequested = true;
    taskControllers.get(taskId)?.abort(new Error('任务已请求取消。'));
    return textResult(JSON.stringify({ taskId, status: 'cancelling', cancelled: true }, null, 2));
  },
);

server.registerTool(
  'boss_mcp_health',
  {
    description: '检查 MCP 进程、浏览器 CDP 连接、当前页面和异步任务状态。',
    inputSchema: {},
  },
  async () => {
    cleanupExpiredTasks();
    const browser = getBrowserRef();
    const page = getPageRef();
    let currentUrl: string | null = null;
    if (page && !page.isClosed()) {
      try {
        currentUrl = page.url();
      } catch {
        currentUrl = null;
      }
    }
    return textResult(
      JSON.stringify(
        {
          ok: true,
          mcpVersion: MCP_VERSION,
          pid: process.pid,
          browserConnected: !!browser?.connected,
          pageClosed: page ? page.isClosed() : null,
          currentUrl,
          activeTaskId: activeBrowserTaskId,
          runningTasks:
            [...batchTasks.values(), ...asyncBrowserTasks.values()].filter(
              (task) => task.status === 'running',
            ).length,
        },
        null,
        2,
      ),
    );
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

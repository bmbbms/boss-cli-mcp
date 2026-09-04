import type { Page } from 'puppeteer-core';
import {
  LIST_FILTER_GAP_MS,
  LIST_MIN_BEFORE_EMPTY_OK_MS,
  LIST_POLL_MS,
  sleepRandom,
} from '../browser/index.js';
import { BOSS_CHAT_INDEX_URL, isBossChatIndexUrl } from '../common/auth.js';
import { ensurePage } from '../common/ensure_page.js';
import { withBossSessionPage } from '../common/boss_session_page.js';

export type CandidateItem = {
  candidateId: string;
  name: string;
  job: string;
  time: string;
  message: string;
  unreadCount: number;
};

async function waitForCandidateListSettled(
  page: Page,
  opts: { timeoutMs: number; pollMsMin: number; pollMsMax: number; minMsBeforeEmptyOk: number },
): Promise<void> {
  const start = Date.now();
  let prev = -1;
  let stable = 0;
  while (Date.now() - start < opts.timeoutMs) {
    const n = (await page.evaluate(
      `(() => document.querySelectorAll(".geek-item").length)()`,
    )) as number;
    const elapsed = Date.now() - start;
    if (n === prev) {
      stable++;
    } else {
      prev = n;
      stable = 1;
    }
    if (stable >= 2) {
      if (n > 0) {
        return;
      }
      if (n === 0 && elapsed >= opts.minMsBeforeEmptyOk) {
        return;
      }
    }
    await sleepRandom(opts.pollMsMin, opts.pollMsMax);
  }
  throw new Error(`聊天列表在 ${opts.timeoutMs}ms 内未稳定，拒绝返回可能不完整的列表。`);
}

const CHAT_LIST_SCROLL_MAX_ROUNDS = 80;
const CHAT_LIST_SCROLL_WAIT_MS = { min: 450, max: 850 } as const;

/** 滚动虚拟列表并收集全部已加载会话；按稳定 candidateId 去重。 */
export async function collectAllChatItems(page: Page): Promise<CandidateItem[]> {
  await resetChatListScroll(page);
  const entries = new Map<string, CandidateItem>();
  const unresolved: string[] = [];
  let stableRounds = 0;
  let lastSignature = '';
  for (let round = 0; round < CHAT_LIST_SCROLL_MAX_ROUNDS; round += 1) {
    const state = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? '').replace(/\\s+/g, ' ').trim();
      const rows = Array.from(document.querySelectorAll('.geek-item-wrap'));
      const visible = rows.map((wrap) => {
        const row = wrap.querySelector('.geek-item') || wrap;
        const candidateId = row.getAttribute('data-id') || (row.id || '').replace(/^_/, '');
        const badge = row.querySelector('.badge-count');
        const digits = norm(badge?.textContent).replace(/\\D/g, '');
        return {
          candidateId,
          name: norm(wrap.querySelector('.geek-name')?.textContent),
          job: norm(wrap.querySelector('.source-job')?.textContent),
          time: norm(wrap.querySelector('.time')?.textContent),
          message: norm(wrap.querySelector('.push-text')?.textContent),
          unreadCount: digits ? (parseInt(digits, 10) || 0) : 0,
        };
      }).filter((x) => x.name);
      let scroller = null;
      const first = rows[0];
      let node = first ? first.parentElement : document.querySelector('.user-list');
      while (node) {
        const style = window.getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'hidden') && node.scrollHeight > node.clientHeight) {
          scroller = node;
          break;
        }
        node = node.parentElement;
      }
      if (!scroller) scroller = document.scrollingElement;
      const before = scroller ? scroller.scrollTop : 0;
      const height = scroller ? scroller.scrollHeight : 0;
      const client = scroller ? scroller.clientHeight : 0;
      if (scroller) scroller.scrollTop = Math.min(before + Math.max(180, Math.floor(client * 0.82)), height);
      const top = scroller ? scroller.scrollTop : 0;
      return { visible, moved: top !== before, atEnd: !scroller || top + client >= height - 2, top, height };
    })()`)) as { visible: CandidateItem[]; moved: boolean; atEnd: boolean; top: number; height: number };
    const beforeSize = entries.size;
    for (const item of state.visible) {
      if (item.candidateId) entries.set(item.candidateId, item);
      else unresolved.push(item.name);
    }
    const signature = `${entries.size}:${state.top}:${state.height}:${state.atEnd}`;
    stableRounds = entries.size === beforeSize && signature === lastSignature ? stableRounds + 1 : 0;
    lastSignature = signature;
    if ((state.atEnd && stableRounds >= 2) || (!state.moved && state.atEnd)) break;
    await sleepRandom(CHAT_LIST_SCROLL_WAIT_MS.min, CHAT_LIST_SCROLL_WAIT_MS.max);
  }
  if (entries.size === 0) throw new Error('会话列表为空，未读取到候选人。');
  if (unresolved.length > 0) throw new Error(`有 ${unresolved.length} 条会话缺少稳定 candidateId，拒绝返回可能无法定位的列表。`);
  await resetChatListScroll(page);
  return [...entries.values()];
}

export async function resetChatListScroll(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const first = document.querySelector('.geek-item-wrap');
    let node = first ? first.parentElement : document.querySelector('.user-list');
    while (node) {
      const style = window.getComputedStyle(node);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'hidden') && node.scrollHeight > node.clientHeight) {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
    const root = document.scrollingElement;
    if (root) root.scrollTop = 0;
  })()`);
  await sleepRandom(220, 420);
}

async function clickChatFilterTab(page: Page, label: string): Promise<void> {
  const labelLiteral = JSON.stringify(label);
  await page.evaluate(`(() => {
    const targetText = ${labelLiteral};
    const container = document.querySelector(".chat-message-filter-left");
    if (!container) {
      throw new Error("未找到聊天筛选容器：.chat-message-filter-left");
    }
    const spans = Array.from(container.querySelectorAll("span"));
    const norm = (v) => (v ?? "").replace(/\\s+/g, "");
    const target = spans.find((el) => norm(el.textContent).includes(targetText));
    if (!target) {
      const labels = spans.map((el) => norm(el.textContent)).filter(Boolean).join(",");
      throw new Error("未找到聊天筛选项：" + targetText + "；当前筛选项：" + (labels || "空"));
    }
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    target.click();
  })()`);
}

async function waitForChatFilterTabSelected(page: Page, label: string): Promise<void> {
  const labelLiteral = JSON.stringify(label);
  await page.waitForFunction(
    `(() => {
      const targetText = ${labelLiteral};
      const container = document.querySelector(".chat-message-filter-left");
      if (!container) return false;
      const norm = (v) => (v ?? "").replace(/\\s+/g, "");
      const tabs = Array.from(container.querySelectorAll("span"));
      const tab = tabs.find((el) => norm(el.textContent).includes(targetText));
      if (!tab) return false;
      const cls = String(tab.className || "");
      const selectedByClass = /active|selected|current|checked/.test(cls);
      const selectedByAria = tab.getAttribute("aria-selected") === "true";
      const selectedByAncestor = !!tab.closest(".active, .selected, .current, .checked");
      return selectedByClass || selectedByAria || selectedByAncestor;
    })()`,
    { timeout: 8_000 },
  );
}

export async function ensureChatListReady(
  page: Page,
  filter: 'all' | 'unread' = 'all',
): Promise<void> {
  await ensurePage(page, {
    name: '沟通列表页',
    targetUrl: BOSS_CHAT_INDEX_URL,
    matches: isBossChatIndexUrl,
  });

  await page.waitForFunction(
    `(() => {
      const filter = document.querySelector(".chat-message-filter-left");
      if (!filter) return false;
      const tabs = Array.from(filter.querySelectorAll("span"));
      return tabs.length >= 2;
    })()`,
    { timeout: 15_000 },
  );

  const filterLabel = filter === 'unread' ? '未读' : '全部';
  await clickChatFilterTab(page, filterLabel);
  await sleepRandom(LIST_FILTER_GAP_MS.min, LIST_FILTER_GAP_MS.max);
  await waitForChatFilterTabSelected(page, filterLabel);
  await waitForCandidateListSettled(page, {
    timeoutMs: 18_000,
    pollMsMin: LIST_POLL_MS.min,
    pollMsMax: LIST_POLL_MS.max,
    minMsBeforeEmptyOk: LIST_MIN_BEFORE_EMPTY_OK_MS,
  });
}

export async function runGetCandidateList(
  opts: { unreadOnly?: boolean } = {},
): Promise<string> {
  const unreadOnly = opts.unreadOnly === true;

  try {
    return await withBossSessionPage(async (page) => {
      await ensureChatListReady(page, unreadOnly ? 'unread' : 'all');

      const candidates = await collectAllChatItems(page);
      const withUnread = candidates.filter((it) => it.unreadCount > 0).length;
      // 未读筛选由 Boss 页面完成；部分版本只显示红点而不渲染数字角标，
      // 因此不能再按 unreadCount 二次过滤导致漏掉候选人。
      const visible = candidates;
      const lines = visible.map((it, idx) => {
        const base = `${idx + 1}. ${it.name}${it.job ? `｜${it.job}` : ''}｜candidateId:${it.candidateId}`;
        const meta = [
          it.unreadCount > 0 ? `未读:${it.unreadCount}` : '',
          it.time ? `时间:${it.time}` : '',
          it.message ? `消息:${it.message}` : '',
        ]
          .filter(Boolean)
          .join('｜');
        return meta ? `${base}｜${meta}` : base;
      });
      const previewText =
        lines.length > 0 ? `候选人明细：\n${lines.join('\n')}` : '候选人明细：暂无。';

      return [
        unreadOnly
          ? `未读筛选：共 ${visible.length} 人（已切换页面「未读」筛选）。`
          : `沟通列表共 ${candidates.length} 人，其中 ${withUnread} 人有未读消息。`,
        previewText,
      ]
        .filter(Boolean)
        .join('\n');
    });
  } catch (e) {
    if (e instanceof Error) {
      throw e;
    }
    throw new Error(`获取候选人列表失败：${String(e)}`);
  }
}

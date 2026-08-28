import type { Frame, Page } from 'puppeteer-core';
import { sleepRandom } from '../browser/index.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { isBossChatIndexUrl } from '../common/auth.js';
import { assertRecommendPageReady, clickGreet, readRecommendList } from './recommend.js';
import { runChatActionOnCurrentConversation } from './action.js';
import { runSendChatMessageOnPage } from './send.js';
import { runOpenCandidateChatById } from './chat.js';
import { matchCandidateProfile, messageFingerprint, parseCandidateProfile, recordAction, hasActionBeenRecorded, type CandidateRequirements, type CandidateProfile } from './candidate_profile.js';

export type AutomationOptions = {
  scope: 'recommend' | 'chat' | 'chat-list';
  requirements?: CandidateRequirements;
  execute?: boolean;
  confirm?: boolean;
  message?: string;
  requestResume?: boolean;
  receiveResume?: boolean;
  batchSize?: number;
  onProgress?: (progress: { phase: string; total: number; processed: number; currentCandidate?: string; matched: number; failed: number }) => void;
};

type Result = { candidate: CandidateProfile; match: ReturnType<typeof matchCandidateProfile>; action: string };
type ChatListEntry = { candidateId: string; name: string };

async function collectAllChatEntries(page: Page): Promise<ChatListEntry[]> {
  const entries = new Map<string, ChatListEntry>();
  const unresolved = new Set<string>();
  let stable = 0;
  let last = '';
  for (let i = 0; i < CHAT_LIST_SCROLL_MAX_ROUNDS; i += 1) {
    const state = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? '').replace(/\\s+/g, ' ').trim();
      const rows = Array.from(document.querySelectorAll('.geek-item-wrap'));
      const visible = rows.map((wrap) => { const row = wrap.querySelector('.geek-item') || wrap; return { name: norm(wrap.querySelector('.geek-name')?.textContent), candidateId: row.getAttribute('data-id') || row.id.replace(/^_/, '') }; }).filter((x) => x.name);
      const root = document.querySelector('.user-list');
      if (!(root instanceof HTMLElement) || root.scrollHeight <= root.clientHeight) return { visible, moved: false, atEnd: true, top: 0, height: 0 };
      const before = root.scrollTop;
      root.scrollTop = Math.min(before + Math.max(180, Math.floor(root.clientHeight * 0.82)), root.scrollHeight);
      return { visible, moved: root.scrollTop !== before, atEnd: root.scrollTop + root.clientHeight >= root.scrollHeight - 2, top: root.scrollTop, height: root.scrollHeight };
    })()`)) as { visible: ChatListEntry[]; moved: boolean; atEnd: boolean; top: number; height: number };
    const before = entries.size;
    for (const entry of state.visible) {
      if (entry.candidateId) entries.set(entry.candidateId, entry);
      else unresolved.add(entry.name);
    }
    const signature = `${entries.size}:${state.top}:${state.height}:${state.atEnd}`;
    stable = entries.size === before && signature === last ? stable + 1 : 0;
    last = signature;
    if (state.atEnd && stable >= 2) break;
    if (!state.moved && state.atEnd) break;
    await sleepRandom(CHAT_LIST_SCROLL_WAIT_MS.min, CHAT_LIST_SCROLL_WAIT_MS.max);
  }
  if (entries.size === 0) throw new Error('会话列表为空，未读取到带稳定 ID 的候选人。');
  if (unresolved.size > 0) throw new Error(`有 ${unresolved.size} 条会话未找到稳定 candidateId，已拒绝按姓名降级处理。`);
  return [...entries.values()];
}

const CHAT_LIST_SCROLL_MAX_ROUNDS = 80;
const CHAT_LIST_SCROLL_WAIT_MS = { min: 450, max: 850 } as const;

async function resetChatListScroll(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const row = document.querySelector('.geek-item-wrap');
    let node = document.querySelector('.user-list') || row?.parentElement || null;
    while (node) {
      const style = window.getComputedStyle(node);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'hidden') && node.scrollHeight > node.clientHeight) {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
    (document.scrollingElement || document.documentElement).scrollTop = 0;
  })()`);
  await sleepRandom(220, 420);
}

async function recommendProfiles(frame: Frame): Promise<CandidateProfile[]> {
  const rows = await frame.evaluate(`(() => {
    const norm = (v) => (v ?? '').replace(/\\s+/g, ' ').trim();
    const cards = Array.from(document.querySelectorAll('.card-list > .card-item, .geek-list > .geek-card'));
    return cards.map((item) => {
      const inner = item.querySelector('.card-inner') || item;
      const name = norm(item.querySelector('.name-wrap .name')?.textContent || item.querySelector('.name')?.textContent);
      const salary = norm(item.querySelector('.salary-wrap span')?.textContent);
      const basicInfo = Array.from(item.querySelectorAll('.base-info span')).map((x) => norm(x.textContent)).filter(Boolean).join(' / ');
      const expect = norm(item.querySelector('.expect-wrap .content')?.textContent || item.querySelector('.expect-wrap .join-text-wrap')?.textContent);
      const experience = norm(item.querySelector('.experience-wrap .join-text-wrap')?.textContent);
      return { name, salary, basicInfo, expect, experience, geekId: inner.getAttribute('data-geekid') || inner.getAttribute('data-geek') || '' };
    }).filter((x) => x.name);
  })()`) as Array<{ name: string; salary: string; basicInfo: string; expect: string; experience: string; geekId: string }>;
  return rows.map((x) => parseCandidateProfile({ ...x, rawText: [x.name, x.salary, x.basicInfo, x.expect, x.experience].join(' / ') }));
}

async function chatProfile(page: Page, candidateId?: string): Promise<CandidateProfile> {
  const data = await page.evaluate(`(() => {
    const root = document.querySelector('.base-info-single-container');
    const norm = (v) => (v ?? '').replace(/\\s+/g, ' ').trim();
    if (!root) throw new Error('请先打开候选人聊天详情。');
    const name = norm(root.querySelector('.name-box')?.textContent);
    const basicInfo = Array.from(root.querySelectorAll('.base-info-single-detial > div')).map((x) => norm(x.textContent)).filter(Boolean).join(' / ');
    const position = norm(root.querySelector('.position-item .position-name')?.textContent);
    const expectation = norm(root.querySelector('.position-item.expect .value.job')?.textContent);
    const rawText = [name, basicInfo, position, expectation, root.innerText].filter(Boolean).join(' / ');
    return { name, basicInfo, expect: expectation, rawText };
  })()`) as { name: string; basicInfo: string; expect: string; rawText: string };
  return parseCandidateProfile({ ...data, geekId: candidateId });
}

export async function runCandidateAutomation(options: AutomationOptions): Promise<string> {
  const req = options.requirements ?? {};
  const execute = options.execute === true;
  if (execute && options.confirm !== true) throw new Error('执行真实操作必须显式设置 confirm=true。');
  const message = (options.message ?? '').trim();
  const batchSize = Math.max(1, Math.min(20, Math.floor(options.batchSize ?? 5)));
  if (execute && (options.scope === 'chat' || options.scope === 'chat-list') && !message) throw new Error('execute=true 时必须提供 message。');
  return withBossSessionPage(async (page) => {
    const results: Result[] = [];
    if (options.scope === 'recommend') {
      const frame = await assertRecommendPageReady(page, '分析候选人');
      const profiles = await recommendProfiles(frame);
      for (const profile of profiles) {
        const match = matchCandidateProfile(profile, req);
        let action = match.matched ? '符合条件' : '不符合条件';
        if (execute && match.matched) {
          await clickGreet(frame, profile.name);
          action = '已打招呼';
          await recordAction(`greet:${profile.geekId || profile.name}`, 'sent');
        }
        results.push({ candidate: profile, match, action });
      }
    } else {
      if (!isBossChatIndexUrl(page.url())) throw new Error('当前不在沟通列表页。');
      const entries = options.scope === 'chat-list' ? await collectAllChatEntries(page) : [];
      if (options.scope === 'chat-list') await resetChatListScroll(page);
      const targets = options.scope === 'chat-list' ? entries : [{ candidateId: '', name: '' }];
      let matchedCount = 0;
      let failedCount = 0;
      options.onProgress?.({ phase: 'collected', total: targets.length, processed: 0, matched: 0, failed: 0 });
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i]!;
        try {
          if (target.candidateId) await runOpenCandidateChatById(page, target.candidateId, target.name);
          const profile = await chatProfile(page, target.candidateId || undefined);
          const match = matchCandidateProfile(profile, req);
          let action = match.matched ? '符合条件' : '不符合条件';
          if (match.matched) matchedCount += 1;
          if (execute) {
          const key = `message:${profile.geekId || target.candidateId || profile.name}`;
          const hash = messageFingerprint(message);
          if (match.matched) {
            if (await hasActionBeenRecorded(key, hash)) action = '已发送过，跳过';
            else {
              const sent = await page.evaluate(`((expected) => Array.from(document.querySelectorAll('.item-myself .text span')).some((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === expected))`, message);
              if (sent) { action = '聊天记录已有相同消息，跳过'; await recordAction(key, 'skipped', hash); }
              else {
                await runSendChatMessageOnPage(page, { text: message });
                if (options.requestResume) await runChatActionOnCurrentConversation(page, { action: 'request-attachment-resume' });
                if (options.receiveResume) await runChatActionOnCurrentConversation(page, { action: 'agree-resume' });
                await recordAction(key, 'sent', hash);
                action = options.requestResume && options.receiveResume ? '已回复、求简历并接收简历' : options.requestResume ? '已回复并求简历' : options.receiveResume ? '已回复并接收简历' : '已回复';
              }
            }
          } else {
            await runChatActionOnCurrentConversation(page, { action: 'not-fit' });
            action = '已标记不合适';
          }
          }
          results.push({ candidate: profile, match, action });
        } catch (error) {
          failedCount += 1;
          const candidate = parseCandidateProfile({ name: target.name, rawText: target.name, geekId: target.candidateId });
          results.push({ candidate, match: { matched: false, reasons: [], unknown: ['读取失败'] }, action: `失败：${error instanceof Error ? error.message : String(error)}` });
        }
        options.onProgress?.({ phase: 'processing', total: targets.length, processed: i + 1, currentCandidate: target.name, matched: matchedCount, failed: failedCount });
        if ((i + 1) % batchSize === 0 && i + 1 < targets.length) await sleepRandom(180, 360);
      }
    }
    return JSON.stringify({ execute, scope: options.scope, results }, null, 2);
  });
}

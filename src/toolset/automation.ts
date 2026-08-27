import type { Frame, Page } from 'puppeteer-core';
import { sleepRandom } from '../browser/index.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { isBossChatIndexUrl } from '../common/auth.js';
import { assertRecommendPageReady, clickGreet, readRecommendList } from './recommend.js';
import { runChatActionOnCurrentConversation } from './action.js';
import { runSendChatMessageOnPage } from './send.js';
import { runOpenCandidateChat } from './chat.js';
import { matchCandidateProfile, messageFingerprint, parseCandidateProfile, recordAction, hasActionBeenRecorded, type CandidateRequirements, type CandidateProfile } from './candidate_profile.js';

export type AutomationOptions = {
  scope: 'recommend' | 'chat' | 'chat-list';
  requirements?: CandidateRequirements;
  execute?: boolean;
  confirm?: boolean;
  message?: string;
  requestResume?: boolean;
  receiveResume?: boolean;
};

type Result = { candidate: CandidateProfile; match: ReturnType<typeof matchCandidateProfile>; action: string };

const CHAT_LIST_SCROLL_MAX_ROUNDS = 80;
const CHAT_LIST_SCROLL_WAIT_MS = { min: 450, max: 850 } as const;

async function collectAllChatNames(page: Page): Promise<string[]> {
  const names = new Set<string>();
  let stableRounds = 0;
  let previousSignature = '';
  for (let round = 0; round < CHAT_LIST_SCROLL_MAX_ROUNDS; round += 1) {
    const state = (await page.evaluate(`(() => {
      const norm = (v) => (v ?? '').replace(/\\s+/g, ' ').trim();
      const rows = Array.from(document.querySelectorAll('.geek-item-wrap'));
      const visibleNames = rows.map((row) => norm(row.querySelector('.geek-name')?.textContent)).filter(Boolean);
      let node = rows[0]?.parentElement ?? null;
      let scroller = null;
      while (node) {
        const style = window.getComputedStyle(node);
        const canScroll = (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
        if (canScroll) { scroller = node; break; }
        node = node.parentElement;
      }
      if (!scroller) {
        const root = document.scrollingElement || document.documentElement;
        const before = root.scrollTop;
        const height = Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0);
        const client = window.innerHeight;
        root.scrollTop = Math.min(before + Math.max(180, Math.floor(client * 0.82)), height);
        const moved = root.scrollTop !== before;
        const atEnd = root.scrollTop + client >= height - 2;
        return { names: visibleNames, moved, atEnd, top: root.scrollTop, height, client };
      }
      const before = scroller.scrollTop;
      const step = Math.max(180, Math.floor(scroller.clientHeight * 0.82));
      scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
      const moved = scroller.scrollTop !== before;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      return { names: visibleNames, moved, atEnd, top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
    })()`)) as { names: string[]; moved: boolean; atEnd: boolean; top: number; height: number; client: number };

    const beforeSize = names.size;
    for (const name of state.names) names.add(name);
    const signature = `${names.size}:${state.top}:${state.height}:${state.atEnd}`;
    if (names.size === beforeSize && signature === previousSignature) stableRounds += 1;
    else stableRounds = 0;
    previousSignature = signature;

    if (state.atEnd && stableRounds >= 2) break;
    if (!state.moved && state.atEnd && stableRounds >= 1) break;
    await sleepRandom(CHAT_LIST_SCROLL_WAIT_MS.min, CHAT_LIST_SCROLL_WAIT_MS.max);
  }
  if (names.size === 0) throw new Error('会话列表为空，未读取到候选人。');
  return [...names];
}

async function resetChatListScroll(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const row = document.querySelector('.geek-item-wrap');
    let node = row?.parentElement ?? null;
    while (node) {
      const style = window.getComputedStyle(node);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
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

async function chatProfile(page: Page): Promise<CandidateProfile> {
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
  return parseCandidateProfile(data);
}

export async function runCandidateAutomation(options: AutomationOptions): Promise<string> {
  const req = options.requirements ?? {};
  const execute = options.execute === true;
  if (execute && options.confirm !== true) throw new Error('执行真实操作必须显式设置 confirm=true。');
  const message = (options.message ?? '').trim();
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
      const names = options.scope === 'chat-list' ? await collectAllChatNames(page) : [];
      if (options.scope === 'chat-list') await resetChatListScroll(page);
      const targets = options.scope === 'chat-list' ? (names as string[]) : [''];
      for (const target of targets) {
        if (target) await runOpenCandidateChat(page, target, true);
        const profile = await chatProfile(page);
        const match = matchCandidateProfile(profile, req);
        let action = match.matched ? '符合条件' : '不符合条件';
        if (execute) {
          const key = `message:${profile.name}`;
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
      }
    }
    return JSON.stringify({ execute, scope: options.scope, results }, null, 2);
  });
}

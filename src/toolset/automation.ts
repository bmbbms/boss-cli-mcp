import type { Frame, Page } from 'puppeteer-core';
import { sleepRandom } from '../browser/index.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { isBossChatIndexUrl } from '../common/auth.js';
import { assertRecommendPageReady, clickGreet, readRecommendList } from './recommend.js';
import { runChatActionOnCurrentConversation } from './action.js';
import { runOpenAndSendMessageIdempotent } from './send.js';
import { runOpenCandidateChatById } from './chat.js';
import { collectAllChatItems } from './list.js';
import { matchCandidateProfile, messageFingerprint, parseCandidateProfile, recordAction, reserveAction, hasActionBeenRecorded, type CandidateRequirements, type CandidateProfile } from './candidate_profile.js';

export type AutomationOptions = {
  scope: 'recommend' | 'chat' | 'chat-list';
  requirements?: CandidateRequirements;
  execute?: boolean;
  confirm?: boolean;
  message?: string;
  requestResume?: boolean;
  receiveResume?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; total: number; processed: number; currentCandidate?: string; matched: number; failed: number }) => void;
};

type Result = { candidate: CandidateProfile; match: ReturnType<typeof matchCandidateProfile>; action: string };
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
          if (!profile.geekId) throw new Error(`候选人「${profile.name}」缺少稳定 geekId，拒绝执行打招呼。`);
          const actionKey = `greet:${profile.geekId}`;
          const reservation = await reserveAction(actionKey, 'greet');
          if (!reservation.acquired) {
            action = '已打过招呼，跳过';
          } else {
            try {
              await clickGreet(frame, profile.name);
              action = '已打招呼';
              await recordAction(actionKey, 'sent', 'greet');
            } catch (error) {
              await recordAction(actionKey, 'failed', 'greet', error instanceof Error ? error.message : String(error));
              throw error;
            }
          }
        }
        results.push({ candidate: profile, match, action });
      }
    } else {
      if (!isBossChatIndexUrl(page.url())) throw new Error('当前不在沟通列表页。');
      const entries = options.scope === 'chat-list' ? await collectAllChatItems(page) : [];
      const targets = options.scope === 'chat-list' ? entries : [{ candidateId: '', name: '' }];
      let matchedCount = 0;
      let failedCount = 0;
      options.onProgress?.({ phase: 'collected', total: targets.length, processed: 0, matched: 0, failed: 0 });
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i]!;
        let reservedActionKey: string | undefined;
        let reservedMessageHash: string | undefined;
        try {
          if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('任务已取消。');
          if (target.candidateId) await runOpenCandidateChatById(page, target.candidateId, target.name, options.signal);
          const profile = await chatProfile(page, target.candidateId || undefined);
          const match = matchCandidateProfile(profile, req);
          let action = match.matched ? '符合条件' : '不符合条件';
          if (match.matched) matchedCount += 1;
          if (execute) {
          const key = `message:${profile.geekId || target.candidateId || profile.name}`;
          const hash = messageFingerprint(message);
          if (match.matched) {
            reservedActionKey = key;
            reservedMessageHash = hash;
            const reservation = await reserveAction(key, hash);
            if (!reservation.acquired || await hasActionBeenRecorded(key, hash)) action = '已发送过，跳过';
            else {
              const sent = await page.evaluate(`((expected) => Array.from(document.querySelectorAll('.item-myself .text span')).some((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === expected))`, message);
              if (sent) { action = '聊天记录已有相同消息，跳过'; await recordAction(key, 'skipped', hash); }
              else {
                const sendResult = await runOpenAndSendMessageIdempotent(page, { text: message, signal: options.signal });
                if (sendResult.status === 'skipped') {
                  action = '聊天记录已有相同消息，跳过';
                  await recordAction(key, 'skipped', hash);
                } else {
                  if (options.requestResume) await runChatActionOnCurrentConversation(page, { action: 'request-attachment-resume' });
                  if (options.receiveResume) await runChatActionOnCurrentConversation(page, { action: 'agree-resume' });
                  await recordAction(key, 'sent', hash);
                  action = options.requestResume && options.receiveResume ? '已回复、求简历并接收简历' : options.requestResume ? '已回复并求简历' : options.receiveResume ? '已回复并接收简历' : '已回复';
                }
              }
            }
          } else {
            await runChatActionOnCurrentConversation(page, { action: 'not-fit' });
            action = '已标记不合适';
          }
          }
          results.push({ candidate: profile, match, action });
        } catch (error) {
          if (reservedActionKey && reservedMessageHash) {
            await recordAction(reservedActionKey, 'failed', reservedMessageHash, error instanceof Error ? error.message : String(error));
          }
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

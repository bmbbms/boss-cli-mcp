import {
  GREET_PAYWALL_WAIT_MAX_MS,
  resumeHeight,
  setTempHeight,
  sleepRandom,
  snapshotBossPageViewport,
} from '../browser/index.js';
import { closeBossModalIfPresent, waitAndCloseBossModalIfPresent } from '../common/boss_modal.js';
import {
  closeBossPaywallPopupIfPresent,
  describeBossPaywallPopupIfPresent,
  waitForBossPaywallPopup,
} from '../common/boss_paywall_popup.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import {
  clickGreetDeepSearch,
  ensureInDeepSearchPage,
  isBossChatAiFormUrl,
  readDeepSearchGeekList,
  renderGeekListSection,
  selectAiFormJob,
} from './deep-search.js';
import {
  clickGreet,
  assertRecommendPageReady,
  markGreetProduced,
  readRecommendList,
  renderRecommendList,
  selectRecommendJob,
} from './recommend.js';
import type { Page } from 'puppeteer-core';
import { recordAction, reserveAction } from './candidate_profile.js';

/** 打招呼前临时拉高父页视口，使 iframe 内更多卡片进入 DOM（与 recommend 列表读取已解耦）。 */
const RECOMMEND_GREET_EXPAND_HEIGHT_PX = 3000;
const RECOMMEND_GREET_EXPAND_SETTLE_MS = { min: 600, max: 1400 } as const;

/** 操作完成后等待并关闭延迟出现的提示弹层（如「当前职位尚未开放」）。 */
const GREET_MODAL_CLEANUP_WAIT_MAX_MS = 4000;

async function assertNoGreetPaywallPopup(page: Page): Promise<void> {
  if (await waitForBossPaywallPopup(page, GREET_PAYWALL_WAIT_MAX_MS)) {
    const paywall = await describeBossPaywallPopupIfPresent(page, 'greet');
    await closeBossPaywallPopupIfPresent(page);
    if (paywall) {
      throw new Error(paywall);
    }
    throw new Error('页面出现 VIP/付费购买弹层，打招呼可能需开通权益或充值直豆。');
  }
}

async function cleanupGreetModalIfPresent(page: Page): Promise<void> {
  await waitAndCloseBossModalIfPresent(page, GREET_MODAL_CLEANUP_WAIT_MAX_MS);
}

export type GreetOptions = {
  candidateTarget: string;
  jobKeyword?: string;
  signal?: AbortSignal;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('任务已取消。');
  }
}

export async function runRecommendGreet(options: GreetOptions): Promise<string> {
  const t = options.candidateTarget.trim();
  const kw = (options.jobKeyword ?? '').trim();
  const signal = options.signal;
  if (!t) {
    throw new Error('请提供打招呼目标（姓名）。');
  }
  try {
    throwIfAborted(signal);
    return await withBossSessionPage(async (page) => {
      throwIfAborted(signal);
      await closeBossModalIfPresent(page);
      const url = page.url();
      if (isBossChatAiFormUrl(url)) {
        await ensureInDeepSearchPage(page);
        let jobLine = '';
        if (kw) {
          const label = await selectAiFormJob(page, kw, signal);
          await ensureInDeepSearchPage(page);
          jobLine = `当前岗位：${label}`;
        }
        const deepCandidates = await readDeepSearchGeekList(page);
        const deepTarget = deepCandidates.find((x) => x.name === t || x.name.includes(t));
        if (!deepTarget?.geekId) throw new Error(`候选人「${t}」缺少稳定 geekId，拒绝执行打招呼。`);
        const actionKey = `greet:${deepTarget.geekId}`;
        const reservation = await reserveAction(actionKey, 'greet');
        if (!reservation.acquired) throw new Error(`候选人「${t}」已打过招呼或正在由其他任务处理。`);
        let greetResult;
        try {
          greetResult = await clickGreetDeepSearch(page, t, signal);
          await assertNoGreetPaywallPopup(page);
          await recordAction(actionKey, 'sent', 'greet');
        } catch (error) {
          await recordAction(actionKey, 'failed', 'greet', error instanceof Error ? error.message : String(error));
          throw error;
        }
        await sleepRandom(380, 1000, signal);
        const after = await readDeepSearchGeekList(page);
        await cleanupGreetModalIfPresent(page);
        const lines = [greetResult.message];
        if (jobLine) {
          lines.unshift(jobLine);
        }
        lines.push('', '当前深度搜索列表：', renderGeekListSection('深度搜索匹配结果', after));
        return lines.join('\n');
      }

      const frame = await assertRecommendPageReady(page, '打招呼');
      const selectedJob = await selectRecommendJob(frame, kw, signal);
      const jobLine = selectedJob ? `当前岗位：${selectedJob}` : '当前岗位：默认';
      const savedViewport = await snapshotBossPageViewport(page);
      try {
        await setTempHeight(page, savedViewport, RECOMMEND_GREET_EXPAND_HEIGHT_PX);
        await sleepRandom(
          RECOMMEND_GREET_EXPAND_SETTLE_MS.min,
          RECOMMEND_GREET_EXPAND_SETTLE_MS.max,
          signal,
        );
        throwIfAborted(signal);
        const before = await readRecommendList(frame);
        const target = before.find((x) => x.name === t || x.name.includes(t));
        if (!target?.geekId) throw new Error(`候选人「${t}」缺少稳定 geekId，拒绝执行打招呼。`);
        const actionKey = `greet:${target.geekId}`;
        const reservation = await reserveAction(actionKey, 'greet');
        if (!reservation.acquired) throw new Error(`候选人「${t}」已打过招呼或正在由其他任务处理。`);
        let greetResult;
        try {
          greetResult = await clickGreet(frame, t, signal);
          await assertNoGreetPaywallPopup(page);
          await recordAction(actionKey, 'sent', 'greet');
        } catch (error) {
          await recordAction(actionKey, 'failed', 'greet', error instanceof Error ? error.message : String(error));
          throw error;
        }
        await sleepRandom(380, 1000, signal);
        const after = await readRecommendList(frame);
        markGreetProduced(before, after);
        await cleanupGreetModalIfPresent(page);
        return [jobLine, greetResult.message, '', '当前推荐列表（来源分组）：', renderRecommendList(after)].join('\n');
      } finally {
        await resumeHeight(page, savedViewport);
      }
    }, { ensureChatShell: false, ensureMenuList: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`执行打招呼失败：${message}`);
  }
}

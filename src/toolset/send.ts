import {
  randomIntInclusive,
  selectAllModifierKey,
  SEND_AFTER_ENTER_MS,
  SEND_INPUT_CLICK_MS,
  SEND_TYPING_GAP_MS,
  sleepRandom,
  typeTextWithRandomKeyDelay,
} from '../browser/index.js';
import { isBossChatIndexUrl } from '../common/auth.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { runRequestAttachmentResume } from './action.js';

export type SendChatMessageOptions = {
  text?: string;
  requestResume?: boolean;
  signal?: AbortSignal;
};

async function hasExactOutgoingMessage(page: import('puppeteer-core').Page, message: string): Promise<boolean> {
  const literal = JSON.stringify(message);
  return (await page.evaluate(`((expected) => Array.from(document.querySelectorAll('.item-myself .text span')).some((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === expected))`, message)) as boolean;
}

async function waitForExactOutgoingMessage(page: import('puppeteer-core').Page, message: string): Promise<void> {
  await page.waitForFunction(
    `((expected) => Array.from(document.querySelectorAll('.item-myself .text span')).some((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === expected))`,
    { timeout: 8_000 },
    message,
  );
}

export async function runSendChatMessageOnPage(
  page: import('puppeteer-core').Page,
  options: SendChatMessageOptions,
): Promise<string> {
  const messageText = (options.text ?? '').trim();
  const signal = options.signal;
  const requestResume = options.requestResume ?? false;

  if (!messageText) {
    throw new Error('请指定 --text <消息> 或 -t <消息>。');
  }

  try {
    const currentUrl = page.url();
    if (!isBossChatIndexUrl(currentUrl)) {
      throw new Error('请先进入聊天列表页（/web/chat/index）并打开候选人聊天。');
    }

    const input = await page.$('#boss-chat-editor-input');
    if (!input) {
      throw new Error('未找到聊天输入框（#boss-chat-editor-input）。');
    }

    await input.click({
      delay: randomIntInclusive(SEND_INPUT_CLICK_MS.min, SEND_INPUT_CLICK_MS.max),
    });
    await sleepRandom(60, 220, signal);
    const selectAllMod = selectAllModifierKey();
    await page.keyboard.down(selectAllMod);
    await page.keyboard.press('KeyA');
    await page.keyboard.up(selectAllMod);
    await sleepRandom(45, 180, signal);
    await page.keyboard.press('Backspace');
    await sleepRandom(80, 260, signal);
    await typeTextWithRandomKeyDelay(
      page,
      messageText,
      SEND_TYPING_GAP_MS.min,
      SEND_TYPING_GAP_MS.max,
      signal,
    );
    await sleepRandom(120, 420, signal);
    await page.keyboard.press('Enter');
    await sleepRandom(SEND_AFTER_ENTER_MS.min, SEND_AFTER_ENTER_MS.max, signal);

    if (!requestResume) {
      return `已发送消息：${messageText}`;
    }

    await sleepRandom(1200, 2800, signal);
    const resumeResult = await runRequestAttachmentResume(page);
    return `已发送消息：${messageText}\n${resumeResult}`;
  } catch (e) {
    if (e instanceof Error) {
      throw e;
    }
    throw new Error(`发送消息失败：${String(e)}`);
  }
}

export async function runOpenAndSendMessageIdempotent(
  page: import('puppeteer-core').Page,
  options: { text: string; signal?: AbortSignal },
): Promise<{ status: 'sent' | 'skipped'; message: string }> {
  const text = options.text.trim();
  if (await hasExactOutgoingMessage(page, text)) {
    return { status: 'skipped', message: `已检测到聊天记录中已有相同消息，跳过发送：${text}` };
  }
  const result = await runSendChatMessageOnPage(page, { text, signal: options.signal });
  try {
    await waitForExactOutgoingMessage(page, text);
  } catch (error) {
    throw new Error(`消息发送后未在聊天记录中确认，禁止自动重试：${error instanceof Error ? error.message : String(error)}`);
  }
  return { status: 'sent', message: result };
}

export async function runSendChatMessage(options: SendChatMessageOptions): Promise<string> {
  return withBossSessionPage((page) => runSendChatMessageOnPage(page, options), {
    retryOnContextDestroyed: false,
  });
}

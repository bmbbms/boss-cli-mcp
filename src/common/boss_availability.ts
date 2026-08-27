import { createHash } from 'node:crypto';

const CHECK_ENTRY_URL = 'https://www.zhipin.com/web/chat/index';
const CHECK_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
const CHECK_TIMEOUT_MS = 20_000;
const VERIFIED_CAPTURE_LABEL = '2026-08-26 boss-online-js snapshot';
const VERIFIED_BOSS_INDEX_VERSION = 'v11173';
const VERIFIED_BOSS_BUNDLE_VERSION = 'v6334';
const VERIFIED_ZHIPIN_SIGN_VERSION = 'v5312';

const CHECK_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
} as const;

const REQUIRED_ENTRY_SCRIPT_URLS = [
  'https://static.zhipin.com/assets/sdk/warlock/warlockdata.min.2.2.15.js',
  'https://static.zhipin.com/assets/sdk/apm/patas-compat.2.1.0.min.js',
  'https://static.zhipin.com/assets/zhipin/chat/mqtt-v1.2.min.js',
  'https://static.zhipin.com/zhipin-boss/index/v11173/static/js/polyfill.js',
  'https://static.zhipin.com/zhipin-boss/index/v11173/static/js/app.js',
  'https://static.zhipin.com/zhipin-boss/index/v11173/static/js/risk-detection.js',
] as const;

const REQUIRED_LOGIN_SCRIPT_URLS = [
  'https://img.bosszhipin.com/static/zhipin/geek/sdk/browser-check-v2.js',
  'https://static.zhipin.com/assets/sdk/apm/patas.2.3.0.min.js',
  'https://static.zhipin.com/assets/sdk/warlock/warlockdata.min.2.2.15.js',
  'https://static.zhipin.com/zhipin-sign/v5312/static/js/iframe-core.7fa9fa18.js',
  'https://static.zhipin.com/zhipin-sign/v5312/static/js/vendors~app.daefb1ca.js',
  'https://static.zhipin.com/zhipin-sign/v5312/static/js/app.e89e7a3f.js',
] as const;

const GUARDED_SCRIPT_HASHES = [
  {
    label: 'browser-check-v2',
    url: 'https://img.bosszhipin.com/static/zhipin/geek/sdk/browser-check-v2.js',
    sha256: '0ba94a338ed00ba353384a091f36fca73c67651cf6fe28c588c5e926aaa0399e',
  },
  {
    label: 'chat apm patas-compat',
    url: 'https://static.zhipin.com/assets/sdk/apm/patas-compat.2.1.0.min.js',
    sha256: '2c8d059c16800f91639bc7eb2040bfa8a211425d02a8b702831c9cd5b2f6315a',
  },
  {
    label: 'login apm patas',
    url: 'https://static.zhipin.com/assets/sdk/apm/patas.2.3.0.min.js',
    sha256: 'cf96ad9e6da919b4a88d623b53d7ba2cc49529df9d12ef7d886164c3482424cc',
  },
  {
    label: 'chat warlock',
    url: 'https://static.zhipin.com/assets/sdk/warlock/warlockdata.min.2.2.15.js',
    sha256: '51bd06ef6a77d5ceecef040c5ff8c44324f425104bb505137302de1e20327345',
  },
  {
    label: 'login warlock',
    url: 'https://static.zhipin.com/assets/sdk/warlock/warlockdata.min.2.2.15.js',
    sha256: '51bd06ef6a77d5ceecef040c5ff8c44324f425104bb505137302de1e20327345',
  },
  {
    label: 'chat mqtt',
    url: 'https://static.zhipin.com/assets/zhipin/chat/mqtt-v1.2.min.js',
    sha256: 'd63db9287a0aba5dc81c3b1fb393303a63b1a6c0dd0aec5bc26ddc84b0dfc67f',
  },
  {
    label: 'boss-index app',
    url: 'https://static.zhipin.com/zhipin-boss/index/v11173/static/js/app.js',
    sha256: '74e8bfe941ade1813ce0e47ec7f264868a33c322b3343af2a2a916bbcd5d8481',
  },
  {
    label: 'boss-index polyfill',
    url: 'https://static.zhipin.com/zhipin-boss/index/v11173/static/js/polyfill.js',
    sha256: '85308c1c4ec6a9f287d7167e916ec4428f1817f5f62b5b4a67a360e7a075d61f',
  },
  {
    label: 'boss-index risk-detection',
    url: 'https://static.zhipin.com/zhipin-boss/index/v11173/static/js/risk-detection.js',
    sha256: '5843779c594f276c45425c3df0fe5ef1555f8c99a938fdd4670da69ed9176082',
  },
  {
    label: 'boss-bundle remoteEntry',
    url: 'https://static.zhipin.com/zhipin-boss/bundle/v6334/static/remoteEntry.js',
    sha256: 'e4702396391e60d63d4a6f7db29eaccc9fe37a6e4ff4f57da4b75d6407120a77',
  },
  {
    label: 'zhipin-sign app',
    url: 'https://static.zhipin.com/zhipin-sign/v5312/static/js/app.e89e7a3f.js',
    sha256: '8cd89ecc89118e959637efe42b61663db7d617fad3435f8f2c27eba2d8dc6af6',
  },
  {
    label: 'zhipin-sign iframe-core',
    url: 'https://static.zhipin.com/zhipin-sign/v5312/static/js/iframe-core.7fa9fa18.js',
    sha256: '2170fa54732f95da0b233a80a5cec6858bb2c8aec15361febe4764200a4eb02d',
  },
  {
    label: 'zhipin-sign vendor',
    url: 'https://static.zhipin.com/zhipin-sign/v5312/static/js/vendors~app.daefb1ca.js',
    sha256: 'a9dde3db277a8cb9c4da030353fd59cdc5a388be022e6f82a3a0389c47b0191d',
  },
] as const;

export class BossAvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossAvailabilityError';
  }
}

function normalizeRemoteUrl(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractAssetUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const attrRe = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrRe)) {
    const raw = match[1];
    if (!raw) {
      continue;
    }
    const url = normalizeRemoteUrl(raw, baseUrl);
    if (url) {
      urls.add(url);
    }
  }
  return Array.from(urls).sort();
}

async function fetchBufferStrict(url: string): Promise<{ buffer: Buffer; finalUrl: string }> {
  const res = await fetch(url, {
    headers: CHECK_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} while fetching ${url}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  return { buffer: body, finalUrl: res.url || url };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

const VERSIONED_SCRIPT_RE = /\/(?:zhipin-boss\/index|zhipin-sign)\/v\d+\//;

function toStableScriptIdentity(url: string): string {
  return url
    .replace(VERSIONED_SCRIPT_RE, (segment) => segment.replace(/\/v\d+\//, '/v*/'))
    .replace(/\/static\/js\/([^/.]+(?:~[^/.]+)?)\.[a-f0-9]{8,}\.js$/i, '/static/js/$1.*.js');
}

function findCurrentScriptUrl(
  assetUrls: readonly string[],
  expectedUrl: string,
): { url: string | null; reason: string | null } {
  if (assetUrls.includes(expectedUrl)) {
    return { url: expectedUrl, reason: null };
  }

  const expectedIdentity = toStableScriptIdentity(expectedUrl);
  if (expectedIdentity === expectedUrl) {
    return { url: null, reason: null };
  }

  const matches = assetUrls.filter((url) => toStableScriptIdentity(url) === expectedIdentity);
  if (matches.length === 0) {
    return { url: null, reason: null };
  }
  if (matches.length > 1) {
    return {
      url: null,
      reason: `多个当前脚本匹配同一个已验证身份 ${expectedIdentity}: ${matches.join(', ')}`,
    };
  }
  return { url: matches[0], reason: null };
}

function formatDisabledMessage(reasons: string[]): string {
  return [
    'Boss CLI 已禁用：Boss 线上前端 JS 与已验证基线不一致。',
    `已验证基线：${VERIFIED_CAPTURE_LABEL}，Boss index ${VERIFIED_BOSS_INDEX_VERSION}，Boss bundle ${VERIFIED_BOSS_BUNDLE_VERSION}，Zhipin sign ${VERIFIED_ZHIPIN_SIGN_VERSION}。`,
    '',
    '触发原因：',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    '处理方式：重新归档 Boss 线上原始 JS，复核反调试/风控策略，然后更新 boss_availability 基线后再发版。',
  ].join('\n');
}

async function assertEntryPageMatches(params: {
  pageLabel: string;
  url: string;
  requiredScripts: readonly string[];
}): Promise<{ reasons: string[]; assetUrls: string[] }> {
  try {
    const reasons: string[] = [];
    const { buffer, finalUrl } = await fetchBufferStrict(params.url);
    if (finalUrl !== params.url) {
      reasons.push(`${params.pageLabel} 发生跳转：${params.url} -> ${finalUrl}`);
    }
    const assetUrls = extractAssetUrls(buffer.toString('utf8'), params.url);

    for (const url of params.requiredScripts) {
      const current = findCurrentScriptUrl(assetUrls, url);
      if (current.reason) {
        reasons.push(`${params.pageLabel} ${current.reason}`);
        continue;
      }
      if (!current.url) {
        reasons.push(`${params.pageLabel} 缺少已验证脚本：${url}`);
      }
    }

    return { reasons, assetUrls };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { reasons: [`无法读取 ${params.pageLabel} ${params.url}：${msg}`], assetUrls: [] };
  }
}

export async function assertBossCliAvailable(): Promise<void> {
  const entryPage = await assertEntryPageMatches({
    pageLabel: 'Boss 聊天入口页',
    url: CHECK_ENTRY_URL,
    requiredScripts: REQUIRED_ENTRY_SCRIPT_URLS,
  });
  const loginPage = await assertEntryPageMatches({
    pageLabel: 'Boss 登录入口页',
    url: CHECK_LOGIN_URL,
    requiredScripts: REQUIRED_LOGIN_SCRIPT_URLS,
  });
  const reasons = [...entryPage.reasons, ...loginPage.reasons];
  const currentAssetUrls = [...entryPage.assetUrls, ...loginPage.assetUrls];

  if (reasons.length > 0) {
    throw new BossAvailabilityError(formatDisabledMessage(reasons));
  }

  for (const guarded of GUARDED_SCRIPT_HASHES) {
    const current = findCurrentScriptUrl(currentAssetUrls, guarded.url);
    if (current.reason) {
      reasons.push(`${guarded.label} ${current.reason}`);
      continue;
    }

    const guardedUrl = current.url ?? guarded.url;
    try {
      const { buffer, finalUrl } = await fetchBufferStrict(guardedUrl);
      if (finalUrl !== guardedUrl) {
        reasons.push(`${guarded.label} 发生跳转：${guardedUrl} -> ${finalUrl}`);
        continue;
      }
      const actualSha256 = sha256(buffer);
      if (actualSha256 !== guarded.sha256) {
        reasons.push(
          `${guarded.label} SHA-256 不一致：url ${guardedUrl}, expected ${guarded.sha256}, actual ${actualSha256}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reasons.push(`${guarded.label} 读取失败：${msg}`);
    }
  }

  if (reasons.length > 0) {
    throw new BossAvailabilityError(formatDisabledMessage(reasons));
  }
}

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { CACHE_DIR, ensureAppDataLayout } from '../config.js';
import { join } from 'node:path';

export type CandidateProfile = {
  geekId?: string;
  name: string;
  gender?: '男' | '女' | '未知';
  age?: number;
  school?: string;
  education?: string;
  workYears?: number;
  position?: string;
  salary?: string;
  location?: string;
  rawText?: string;
};

export type CandidateRequirements = {
  gender?: '男' | '女' | '不限';
  ageMin?: number;
  ageMax?: number;
  educationMin?: string;
  workYearsMin?: number;
  workYearsMax?: number;
  positionKeywords?: string[];
  salaryMin?: number;
  locationKeywords?: string[];
};

export type MatchResult = { matched: boolean; reasons: string[]; unknown: string[] };

const educationRank: Record<string, number> = {
  博士: 5,
  硕士: 4,
  研究生: 4,
  本科: 3,
  大专: 2,
  专科: 2,
  高中: 1,
  中专: 1,
  初中: 0,
};

function text(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

export function parseCandidateProfile(input: Omit<CandidateProfile, 'gender' | 'age' | 'school' | 'education' | 'workYears' | 'position' | 'location'> & { rawText?: string; basicInfo?: string; experience?: string; expect?: string }): CandidateProfile {
  const raw = text([input.rawText, input.basicInfo, input.experience, input.expect, input.salary].filter(Boolean).join(' / '));
  const gender = /女/.test(raw) ? '女' : /男/.test(raw) ? '男' : '未知';
  const ageMatch = raw.match(/(?:年龄\s*[:：]?\s*(\d{2})|(\d{2})\s*岁)/);
  const schoolMatch = raw.match(/([\u4e00-\u9fa5A-Za-z]{2,}(?:大学|学院|职业技术学院))/);
  const eduMatch = raw.match(/博士|硕士|研究生|本科|大专|专科|高中|中专|初中/);
  const workCandidates = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*(?:年以上|年工作经验|年经验|年)/g)];
  const workMatch = workCandidates.find((m) => {
    const tail = raw.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 4);
    return !/应届|毕业|届/.test(tail);
  });
  const locationMatch = raw.match(/(?:现居|所在地|城市|地点)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z]{2,12})/);
  return {
    ...input,
    gender,
    age: ageMatch ? Number(ageMatch[1] ?? ageMatch[2]) : undefined,
    school: schoolMatch?.[1],
    education: eduMatch?.[0],
    workYears: workMatch ? Number(workMatch[1]) : undefined,
    position: input.expect || undefined,
    location: locationMatch?.[1],
    rawText: raw || undefined,
  };
}

export function matchCandidateProfile(profile: CandidateProfile, req: CandidateRequirements = {}): MatchResult {
  const reasons: string[] = [];
  const unknown: string[] = [];
  if (req.gender && req.gender !== '不限') {
    if (!profile.gender || profile.gender === '未知') unknown.push('性别');
    else if (profile.gender !== req.gender) return { matched: false, reasons: [`性别不符：${profile.gender}`], unknown };
    else reasons.push('性别符合');
  }
  if (req.ageMin !== undefined || req.ageMax !== undefined) {
    if (profile.age === undefined) unknown.push('年龄');
    else if (req.ageMin !== undefined && profile.age < req.ageMin || req.ageMax !== undefined && profile.age > req.ageMax) return { matched: false, reasons: [`年龄不符：${profile.age}`], unknown };
    else reasons.push('年龄符合');
  }
  if (req.educationMin) {
    const rank = profile.education ? educationRank[profile.education] : undefined;
    const min = educationRank[req.educationMin];
    if (rank === undefined || min === undefined) unknown.push('学历');
    else if (rank < min) return { matched: false, reasons: [`学历不符：${profile.education}`], unknown };
    else reasons.push('学历符合');
  }
  if (req.workYearsMin !== undefined || req.workYearsMax !== undefined) {
    if (profile.workYears === undefined) unknown.push('工作年限');
    else if (req.workYearsMin !== undefined && profile.workYears < req.workYearsMin || req.workYearsMax !== undefined && profile.workYears > req.workYearsMax) return { matched: false, reasons: [`工作年限不符：${profile.workYears}`], unknown };
    else reasons.push('工作年限符合');
  }
  if (req.positionKeywords?.length) {
    const hay = `${profile.position ?? ''} ${profile.rawText ?? ''}`.toLowerCase();
    if (!req.positionKeywords.some((x) => hay.includes(x.toLowerCase()))) return { matched: false, reasons: ['职位关键词不符'], unknown };
    reasons.push('职位关键词符合');
  }
  if (req.locationKeywords?.length) {
    const hay = `${profile.location ?? ''} ${profile.rawText ?? ''}`.toLowerCase();
    if (!req.locationKeywords.some((x) => hay.includes(x.toLowerCase()))) return { matched: false, reasons: ['地点不符'], unknown };
    reasons.push('地点符合');
  }
  if (req.salaryMin !== undefined) {
    const n = profile.salary?.match(/(\d+(?:\.\d+)?)/)?.[1];
    if (!n) unknown.push('薪资');
    else if (Number(n) < req.salaryMin) return { matched: false, reasons: [`薪资不符：${profile.salary}`], unknown };
    else reasons.push('薪资符合');
  }
  return { matched: unknown.length === 0, reasons, unknown };
}

export type ActionRecord = {
  status: 'reserved' | 'sent' | 'skipped' | 'failed';
  messageHash?: string;
  updatedAt: string;
  attemptId?: string;
  error?: string;
};
type ActionState = Record<string, ActionRecord>;
const stateFile = join(CACHE_DIR, 'candidate-actions.json');
let ledgerLock: Promise<void> = Promise.resolve();
const ledgerLockDir = `${stateFile}.lock`;

async function acquireProcessLedgerLock(): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await mkdir(ledgerLockDir);
      return async () => { await rm(ledgerLockDir, { recursive: true, force: false }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`获取批量动作账本锁超时：${ledgerLockDir}`);
}

async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = ledgerLock;
  let release!: () => void;
  ledgerLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const releaseProcess = await acquireProcessLedgerLock();
  try { return await fn(); } finally { await releaseProcess(); release(); }
}

async function readState(): Promise<ActionState> {
  ensureAppDataLayout();
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as ActionState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function hasActionBeenRecorded(key: string, messageHash?: string): Promise<boolean> {
  const state = await readState();
  const item = state[key];
  return !!item && item.status === 'sent' && (!messageHash || item.messageHash === messageHash);
}

export async function getActionRecord(key: string): Promise<ActionRecord | undefined> {
  const state = await readState();
  return state[key];
}

export async function reserveAction(key: string, messageHash: string): Promise<{ acquired: boolean; record?: ActionRecord }> {
  return withLedgerLock(async () => {
    const state = await readState();
    const previous = state[key];
    if (previous && previous.messageHash === messageHash && (previous.status === 'reserved' || previous.status === 'sent' || previous.status === 'skipped')) {
      return { acquired: false, record: previous };
    }
    const record: ActionRecord = { status: 'reserved', messageHash, attemptId: `${process.pid}-${Date.now()}`, updatedAt: new Date().toISOString() };
    state[key] = record;
    await writeStateAtomically(state);
    return { acquired: true, record };
  });
}

async function writeStateAtomically(state: ActionState): Promise<void> {
  const temp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await rename(temp, stateFile);
}

export async function recordAction(key: string, status: ActionRecord['status'], messageHash?: string, error?: string): Promise<void> {
  await withLedgerLock(async () => {
    const state = await readState();
    state[key] = { status, messageHash, error, updatedAt: new Date().toISOString() };
    await writeStateAtomically(state);
  });
}

export function messageFingerprint(message: string): string {
  let hash = 2166136261;
  for (const ch of message) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

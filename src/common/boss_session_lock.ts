import { open, readFile, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { sleepRandom } from '../browser/timing.js';
import { CACHE_DIR, ensureAppDataLayout } from '../config.js';

const SESSION_LOCK_FILE = join(CACHE_DIR, 'session.lock');
const SESSION_LOCK_WAIT_MAX_MS = 30_000;
const SESSION_LOCK_POLL_MS = 250;

type SessionLockMeta = {
  pid: number;
  createdAt: number;
  hostname: string;
  cwd: string;
  command: string;
};

function buildSessionLockMeta(): SessionLockMeta {
  return {
    pid: process.pid,
    createdAt: Date.now(),
    hostname: hostname(),
    cwd: process.cwd(),
    command: process.argv.join(' ').trim(),
  };
}

async function readSessionLockMeta(): Promise<SessionLockMeta | null> {
  try {
    const raw = await readFile(SESSION_LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionLockMeta>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.command !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      hostname: parsed.hostname,
      cwd: parsed.cwd,
      command: parsed.command,
    };
  } catch {
    return null;
  }
}

async function processExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return code === 'EPERM';
  }
}

async function clearStaleSessionLockIfNeeded(): Promise<void> {
  const meta = await readSessionLockMeta();
  if (!meta) {
    // 锁文件可能正处于创建/写入 metadata 的短暂窗口；无法解析时不能删除，
    // 否则会把仍在使用页面的有效锁误判为 stale，导致多个进程并发操作 Chrome。
    try {
      const info = await stat(SESSION_LOCK_FILE);
      if (Date.now() - info.mtimeMs > SESSION_LOCK_WAIT_MAX_MS) {
        await rm(SESSION_LOCK_FILE, { force: true });
      }
    } catch {
      // 文件在检查期间被持有者清理，继续等待下一轮即可。
    }
    return;
  }
  if (meta.hostname !== hostname()) {
    if (!(await processExists(meta.pid))) {
      await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
    }
    return;
  }
  if (await processExists(meta.pid)) {
    return;
  }
  await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
}

function formatSessionLockOwner(meta: SessionLockMeta | null): string {
  if (!meta) {
    return 'unknown';
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - meta.createdAt) / 1000));
  return [
    'pid=' + meta.pid,
    'host=' + meta.hostname,
    'age=' + ageSeconds + 's',
    meta.command ? 'cmd=' + meta.command : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export async function withBossSessionLock<T>(callback: () => Promise<T>): Promise<T> {
  ensureAppDataLayout();
  const deadline = Date.now() + SESSION_LOCK_WAIT_MAX_MS;

  while (true) {
    try {
      const handle = await open(SESSION_LOCK_FILE, 'wx');
      let lockCreated = false;
      try {
        await handle.writeFile(JSON.stringify(buildSessionLockMeta()), 'utf8');
        lockCreated = true;
      } finally {
        await handle.close().catch(() => {});
      }

      if (!lockCreated) {
        await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
        throw new Error('Boss session lock creation failed.');
      }

      try {
        return await callback();
      } finally {
        await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code !== 'EEXIST') {
        throw error;
      }

      await clearStaleSessionLockIfNeeded();
      if (Date.now() >= deadline) {
        const meta = await readSessionLockMeta();
        throw new Error(
          'Boss session is busy for more than 30s. Lock owner: ' +
            formatSessionLockOwner(meta) +
            '. If stale, delete ' +
            SESSION_LOCK_FILE,
        );
      }
      await sleepRandom(SESSION_LOCK_POLL_MS, SESSION_LOCK_POLL_MS);
    }
  }
}

import { db } from './db';

/**
 * 学習記録の書き出し・読み込み。
 *
 * 記録はこの端末のブラウザの中（IndexedDB）にしかない。サーバーには何も送っていない。
 * その代わり、端末やブラウザを変えると引き継げないので、ファイルで持ち出せるようにしておく。
 */

const FORMAT = 'eiken-pre2-backup';
const VERSION = 1;

export interface BackupFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  counts: Record<string, number>;
  data: {
    attempts: unknown[];
    srs: unknown[];
    days: unknown[];
    writings: unknown[];
    mocks: unknown[];
    kv: unknown[];
  };
}

export async function buildBackup(): Promise<BackupFile> {
  const [attempts, srs, days, writings, mocks, kv] = await Promise.all([
    db.attempts.toArray(),
    db.srs.toArray(),
    db.days.toArray(),
    db.writings.toArray(),
    db.mocks.toArray(),
    db.kv.toArray(),
  ]);
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      attempts: attempts.length,
      days: days.length,
      writings: writings.length,
      mocks: mocks.length,
    },
    // 進行中のセッションや下書きは持ち出さない（別端末で復元すると混乱するため）
    data: {
      attempts,
      srs,
      days,
      writings,
      mocks,
      kv: kv.filter((r) => !String(r.key).startsWith('draft:') && r.key !== 'session' && r.key !== 'mock'),
    },
  };
}

export async function downloadBackup(): Promise<void> {
  const backup = await buildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `eiken-kiroku-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface RestoreResult {
  ok: boolean;
  message: string;
}

/** 読み込みは全置き換え。いまの記録は消えるので、呼ぶ側で必ず確認を取ること */
export async function restoreBackup(text: string): Promise<RestoreResult> {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'ファイルを読めませんでした。JSONが壊れているようです。' };
  }
  if (parsed?.format !== FORMAT) {
    return { ok: false, message: 'このアプリの記録ファイルではないようです。' };
  }
  if (typeof parsed.version !== 'number' || parsed.version > VERSION) {
    return { ok: false, message: '新しいバージョンのファイルです。アプリを更新してください。' };
  }

  const d = parsed.data ?? {};
  const tables = [db.attempts, db.srs, db.days, db.writings, db.mocks, db.kv];
  await db.transaction('rw', tables, async () => {
    await Promise.all([
      db.attempts.clear(),
      db.srs.clear(),
      db.days.clear(),
      db.writings.clear(),
      db.mocks.clear(),
      db.kv.clear(),
    ]);
    await Promise.all([
      db.attempts.bulkAdd((d.attempts ?? []) as never[]),
      db.srs.bulkAdd((d.srs ?? []) as never[]),
      db.days.bulkAdd((d.days ?? []) as never[]),
      db.writings.bulkAdd((d.writings ?? []) as never[]),
      db.mocks.bulkAdd((d.mocks ?? []) as never[]),
      db.kv.bulkAdd((d.kv ?? []) as never[]),
    ]);
  });

  const n = parsed.counts?.attempts ?? (d.attempts as unknown[])?.length ?? 0;
  return { ok: true, message: `${n}問ぶんの記録を読み込みました。` };
}

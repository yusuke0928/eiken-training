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
    /**
     * 単語カードの進捗。旧バージョン（〜R6まで）が書き出したファイルにはこのキー自体が無い。
     * 読み込み側は「配列として存在するか」で新旧を判定するので、フィールドを削除したり
     * 空配列で埋めたりしないこと（空配列だと「単語カードが全部リセットされた」と区別できなくなる）。
     */
    words: unknown[];
  };
}

export async function buildBackup(): Promise<BackupFile> {
  const [attempts, srs, days, writings, mocks, kv, words] = await Promise.all([
    db.attempts.toArray(),
    db.srs.toArray(),
    db.days.toArray(),
    db.writings.toArray(),
    db.mocks.toArray(),
    db.kv.toArray(),
    db.words.toArray(),
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
      words: words.length,
    },
    // 進行中のセッションや下書きは持ち出さない（別端末で復元すると混乱するため）
    data: {
      attempts,
      srs,
      days,
      writings,
      mocks,
      kv: kv.filter((r) => !String(r.key).startsWith('draft:') && r.key !== 'session' && r.key !== 'mock'),
      words,
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
  // words キーが無い＝旧バージョンが書き出したファイル。db.words はトランザクションの
  // スコープには含めておく（Dexie は事前に触るテーブルの宣言が必要）が、hasWords が
  // false のときは中で clear() も bulkAdd() も一切呼ばない。呼ばなければ Dexie は
  // そのテーブルに触らないので、いまの端末の単語カードの進捗はそのまま残る
  const hasWords = Array.isArray(d.words);
  const tables = [db.attempts, db.srs, db.days, db.writings, db.mocks, db.kv, db.words];

  await db.transaction('rw', tables, async () => {
    await Promise.all([
      db.attempts.clear(),
      db.srs.clear(),
      db.days.clear(),
      db.writings.clear(),
      db.mocks.clear(),
      db.kv.clear(),
      ...(hasWords ? [db.words.clear()] : []),
    ]);
    await Promise.all([
      db.attempts.bulkAdd((d.attempts ?? []) as never[]),
      db.srs.bulkAdd((d.srs ?? []) as never[]),
      db.days.bulkAdd((d.days ?? []) as never[]),
      db.writings.bulkAdd((d.writings ?? []) as never[]),
      db.mocks.bulkAdd((d.mocks ?? []) as never[]),
      db.kv.bulkAdd((d.kv ?? []) as never[]),
      ...(hasWords ? [db.words.bulkAdd(d.words as never[])] : []),
    ]);
  });

  const n = parsed.counts?.attempts ?? (d.attempts as unknown[])?.length ?? 0;
  if (hasWords) {
    const w = (d.words as unknown[]).length;
    return { ok: true, message: `${n}問ぶんの記録と、単語カード${w}語ぶんの進捗を読み込みました。` };
  }
  return {
    ok: true,
    message: `${n}問ぶんの記録を読み込みました。単語カードの進捗はこのファイルに含まれていないため、この端末のものをそのまま残しています。`,
  };
}

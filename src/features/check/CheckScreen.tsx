import { useEffect, useRef, useState } from 'react';
import {
  englishVoices,
  onSpeechUnlockChange,
  pickVoices,
  speechSupported,
  speechUnlocked,
} from '../../lib/speech';
import { Button, Screen, TopBar } from '../../ui/primitives';

/**
 * 端末の音まわり自己診断。URL の末尾に #check を付けると開く。
 *
 * iPhone 実機には devtools が無く、「音が出ない」と言われても原因が
 * 読み上げ非対応なのか / 英語の声が入っていないのか / マナーモードなのかを
 * 切り分けられない。この画面を開いてスクショを撮れば、それだけで分かるようにする。
 *
 * ホームからは辿れない（子どもに見せる画面ではない）。URL を直接打って開く。
 *
 * 【R6】この画面は「実機 iPhone で撮ったスクショ1枚で原因が分かる」ことが
 * 存在意義なので、正確さとやさしい文言そのものが機能。以下を守る：
 *   - 表示する内容は、実際にリスニングが使うもの（声・実装）と必ず一致させる
 *   - 「良い／悪い／判定不要（情報だけ）」を色と日本語の言葉の両方で示す
 *     （色だけに頼らない。緑の中に判定不要の行が紛れて見えないようにする）
 *   - 英語も技術も分からない人が読んで、そのまま行動できる文言にする
 */

type Row = { label: string; value: string; ok: boolean | null };

function Rows({ rows }: { rows: Row[] }) {
  return (
    <ul className="flex flex-col gap-px overflow-hidden rounded-2xl border border-line bg-line">
      {rows.map((r) => (
        <li
          key={r.label}
          // 判定不要（ok===null）の行だけ地の色のまま残し、良し悪しの行とはっきり
          // 見た目を分ける。色の上に文字は常に ink / ink-sub（濃い色）を置くので、
          // 塗りが correct-soft / again-soft になってもコントラストは保たれる。
          className={`flex items-start gap-3 px-4 py-3 ${
            r.ok === true ? 'bg-correct-soft' : r.ok === false ? 'bg-again-soft' : 'bg-surface'
          }`}
        >
          <span className="w-[7.5em] shrink-0 text-[13px] text-ink-sub">{r.label}</span>
          <span className="flex-1 break-all text-[13px] font-semibold text-ink">
            {r.ok === true ? '○ ' : r.ok === false ? '× ' : ''}
            {r.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 読み上げを1回ぶん再生し、確実に「終わった」まで見届ける。
 *
 * onend だけに頼ると、端末によっては onend が来ないまま止まり、
 * 「まだ鳴っている」から先に進めなくなる（実際に報告された不具合）。
 * ここでは speechSynthesis.speaking を短い間隔で見張り、鳴り止んだ瞬間を
 * 自分で検知することで、onend が来ない端末でも必ず「終わった」を出す。
 */
function speakOnceForCheck(
  label: string,
  voice: SpeechSynthesisVoice | undefined,
  push: (s: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    push(`${label}を再生します…`);
    const u = new SpeechSynthesisUtterance(
      'Hello. This is a test of the reading voice. Can you hear me?',
    );
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = 'en-US';
    }
    let settled = false;
    let started = false;
    const finish = (msg: string) => {
      if (settled) return;
      settled = true;
      window.clearInterval(poll);
      window.clearTimeout(giveUp);
      push(msg);
      resolve();
    };
    u.onstart = () => {
      started = true;
    };
    u.onend = () => finish(`${label}：鳴り終わりました。ここまで出れば正常です。`);
    u.onerror = (e) => finish(`${label}：エラーで止まりました（${e.error ?? '原因不明'}）。`);
    const poll = window.setInterval(() => {
      if (started && !window.speechSynthesis.speaking) {
        finish(`${label}：鳴り終わりました。ここまで出れば正常です。`);
      }
    }, 300);
    // 15秒たっても始まりも終わりもしなければ、音が出ていないとみなして諦める
    // （待たせ続けてスクショが撮れない、という事態を避ける）
    const giveUp = window.setTimeout(() => {
      finish(
        started
          ? `${label}：15秒たっても鳴り終わりません。音は出ていますか？ 出ていなければ本体横のマナースイッチと音量を確認してください。`
          : `${label}：音が鳴り始めませんでした。この端末では読み上げが使えない可能性があります。`,
      );
    }, 15000);
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
  });
}

export function CheckScreen() {
  const [, force] = useState(0);
  const [speechLog, setSpeechLog] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [micLog, setMicLog] = useState<string[]>([]);
  const [clip, setClip] = useState<string | null>(null);
  const clipRef = useRef<string | null>(null);
  // レンダー本体での ref 代入は避け、コミット後の effect で同期する
  useEffect(() => {
    clipRef.current = clip;
  }, [clip]);

  // 声の一覧は遅れて届くので、届いたら表示を作り直す
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!speechSupported()) return;
    const on = () => force((n) => n + 1);
    window.speechSynthesis.addEventListener('voiceschanged', on);
    // 届く前に「声0個」と赤で出すと、ただ待っているだけなのに壊れて見える。
    // 2秒待ってまだ来なければ、そのとき初めて異常として出す
    const t = window.setTimeout(() => setWaited(true), 2000);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', on);
      window.clearTimeout(t);
    };
  }, []);

  // 「準備状態」の行は speechUnlocked() を直読みしているだけなので、
  // onstart で遅れて true になっても再描画のきっかけが無いと画面に反映されない
  useEffect(() => onSpeechUnlockChange(() => force((n) => n + 1)), []);

  useEffect(
    () => () => {
      if (clipRef.current) URL.revokeObjectURL(clipRef.current);
    },
    [],
  );

  const nav = navigator as Navigator & { standalone?: boolean };
  const voices = speechSupported() ? window.speechSynthesis.getVoices() : [];
  const en = speechSupported() ? englishVoices() : [];
  const picked = speechSupported() ? pickVoices() : {};

  // isSecureContext は localhost を「安全扱い」にするため、http:// のまま
  // 緑で「HTTPS」と出てしまっていた（実態と違う表示）。実際のプロトコルを見せた上で、
  // 機能が使えるかどうか（=isSecureContext）を○×に反映する
  const isHttps = window.location.protocol === 'https:';
  const secureOk = window.isSecureContext;
  const connValue = isHttps
    ? 'HTTPS（安全な接続）'
    : secureOk
      ? 'HTTP（開発中のアドレスなので特別に許可されています。本番はHTTPSになります）'
      : 'HTTP（安全でない接続。マイクなど一部の機能が使えません）';

  const env: Row[] = [
    { label: '接続', value: connValue, ok: secureOk },
    {
      label: '開き方',
      value: nav.standalone ? 'ホーム画面に追加したアイコンから開いている' : 'ブラウザのタブで開いている',
      ok: null,
    },
    { label: '端末（開発者向け情報）', value: navigator.userAgent, ok: null },
  ];

  const pending = voices.length === 0 && !waited;
  const speech: Row[] = [
    { label: '読み上げ機能', value: speechSupported() ? '使える' : 'この端末では使えない', ok: speechSupported() },
    {
      label: '入っている声',
      value: pending ? '読み込み中…' : `全部で${voices.length}個（英語の声は${en.length}個）`,
      ok: pending ? null : en.length > 0,
    },
    {
      label: '使う声（女性役）',
      value: pending
        ? '読み込み中…'
        : picked.W
          ? `${picked.W.name}（${picked.W.lang}）`
          : '見つからない（英語の声が入っていない）',
      ok: pending ? null : !!picked.W,
    },
    {
      label: '使う声（男性役）',
      value: pending
        ? '読み込み中…'
        : picked.M
          ? `${picked.M.name}（${picked.M.lang}）`
          : '見つからない（英語の声が入っていない）',
      ok: pending ? null : !!picked.M,
    },
    {
      label: '準備状態',
      value: speechUnlocked()
        ? '準備できている（すぐ読み上げられる）'
        : 'これから準備される（画面のどこかを1回タップすると自動で準備が始まる。異常ではない）',
      ok: speechUnlocked() ? true : null,
    },
  ];

  const canRecord = typeof MediaRecorder !== 'undefined';
  // HTTP で開くと navigator.mediaDevices ごと消える。存在の確認から入る
  const canGetMic = typeof navigator.mediaDevices?.getUserMedia === 'function';
  const mic: Row[] = [
    {
      label: 'マイクの利用',
      value: canGetMic ? '使える' : 'この端末では使えない',
      ok: canGetMic,
    },
    {
      label: '録音機能',
      value: canRecord ? '使える' : '使えない（iOS は 14.3 以降が必要）',
      ok: canRecord,
    },
  ];

  async function testSpeech() {
    if (testing) return;
    setTesting(true);
    setSpeechLog(['テストを始めます…']);
    if (!speechSupported()) {
      setSpeechLog(['この端末は読み上げに対応していません。']);
      setTesting(false);
      return;
    }
    const push = (s: string) => setSpeechLog((l) => [...l, s]);
    // リスニングと同じ声（pickVoices）を、実際に両方鳴らして確かめる
    const v = pickVoices();
    window.speechSynthesis.cancel();
    await speakOnceForCheck('女性の声', v.W, push);
    await speakOnceForCheck('男性の声', v.M, push);
    push('テストは終わりです。上の2つが「鳴り終わりました」であれば、読み上げは正常に動いています。');
    setTesting(false);
  }

  async function testMic() {
    setMicLog(['マイクの使用許可を求めています…']);
    const push = (s: string) => setMicLog((l) => [...l, s]);
    if (!canRecord) {
      setMicLog(['この端末では録音できません（録音の仕組みが無い）。']);
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const owned = stream;
      push('マイクを使えるようになりました。');
      const mr = new MediaRecorder(owned);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      mr.onstop = () => {
        // mimeType は端末によって空のまま。実際に録れたデータの型のほうが当てになる
        const type = mr.mimeType || chunks[0]?.type || '';
        const blob = new Blob(chunks, { type });
        if (blob.size === 0) {
          push('録音できたデータが0バイトでした。うまく録れていません。');
        } else {
          push(`録音できました（${Math.round(blob.size / 1024)}KB）。下の再生ボタンで確認してください。`);
        }
        // URL の生成・解放は setState の updater ではなくここで行う。
        // React は updater を複数回呼びうる（開発時の StrictMode は明示的に2回）ので、
        // 副作用を updater に入れると二重に生成／解放しかねない
        const url = URL.createObjectURL(blob);
        if (clipRef.current) URL.revokeObjectURL(clipRef.current);
        setClip(url);
        owned.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      push('3秒間 録音します。この間に何か話してみてください。');
      window.setTimeout(() => mr.state !== 'inactive' && mr.stop(), 3000);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      const name = e instanceof Error ? e.name : '';
      const hint =
        name === 'NotAllowedError'
          ? '（マイクの使用が許可されませんでした。設定アプリでこのアプリのマイクを許可してください）'
          : '';
      push(`マイクを使えませんでした ${hint}`);
    }
  }

  // フルページ遷移だと main.tsx の状態（Dexie 接続など）を毎回作り直すことになるので、
  // ハッシュを外すだけにする（main.tsx の hashchange で <App /> に切り替わる）
  const backToApp = () => {
    window.location.hash = '';
  };

  return (
    <Screen>
      <TopBar title="音のチェック（開発用）" onBack={backToApp} hideHome />
      <main className="flex-1 px-5 pb-16 pt-2">
        <p className="mb-5 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-ink">
          下の2つのボタンを押して、画面のスクリーンショットを撮ってください。
          <br />
          読み上げが鳴らないときは、まず<strong>本体横のマナースイッチ</strong>
          と音量を確かめてください。iPhone は消音にしていると読み上げも鳴りません。
        </p>

        <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-sub">この端末について</h2>
        <div className="mb-6">
          <Rows rows={env} />
        </div>

        <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-sub">読み上げ（リスニングで使う音声）</h2>
        <div className="mb-3">
          <Rows rows={speech} />
        </div>
        <Button full onClick={testSpeech} disabled={testing}>
          {testing ? 'テスト中…' : '英語を読み上げてみる'}
        </Button>
        {speechLog.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-ink">
            {speechLog.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}

        <h2 className="mb-2 mt-8 text-[12px] font-bold tracking-wide text-ink-sub">録音（面接で使うマイク）</h2>
        <div className="mb-3">
          <Rows rows={mic} />
        </div>
        <Button full onClick={testMic}>
          3秒 録音してみる
        </Button>
        {micLog.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-ink">
            {micLog.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
        {clip && (
          <div className="mt-3 rounded-2xl border border-line bg-surface p-3">
            <p className="mb-1.5 text-[12px] font-semibold text-ink-sub">再生して聞こえれば録音は正常</p>
            <audio src={clip} controls className="w-full" />
          </div>
        )}

        <a
          href={import.meta.env.BASE_URL}
          onClick={(e) => {
            // href はそのまま残す（右クリック・新規タブでの開き直しの受け皿）。
            // 通常クリックはフルページ遷移を避け、ハッシュを外すだけにする
            e.preventDefault();
            backToApp();
          }}
          className="mt-8 block text-center text-[13px] font-semibold text-primary"
        >
          アプリにもどる
        </a>
      </main>
    </Screen>
  );
}

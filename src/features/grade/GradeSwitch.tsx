import { useState } from 'react';
import { switchGrade } from '../../data/switchGrade';
import { GRADE, GRADE_META } from '../../grade';
import type { Grade } from '../../types';
import { Button, Screen, TopBar } from '../../ui/primitives';
import { ChevronRight } from '../../ui/icons';

/**
 * 級の切り替え確認シート。
 * 切り替えで「何が変わり、何が変わらず、何が終わるか」を3つ並べて見せる。黙って消さない。
 */
export function GradeSwitchSheet({ to, onCancel }: { to: Grade; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toMeta = GRADE_META[to];
  const fromMeta = GRADE_META[GRADE];

  return (
    <div className="fixed inset-0 z-50 flex items-end" role="dialog" aria-label={`${toMeta.short}にきりかえる`}>
      <div className="absolute inset-0 bg-black/25" onClick={busy ? undefined : onCancel} />
      <div className="anim-sheet relative max-h-[90dvh] w-full overflow-y-auto rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
        <p className="mb-3 text-[17px] font-bold text-ink">{toMeta.short}にきりかえる？</p>
        <ul className="mb-5 flex flex-col gap-2.5 text-[14px] leading-relaxed text-ink-sub">
          <li>・問題も模試も、{toMeta.short}のものになるよ</li>
          <li>
            ・面接の練習も{toMeta.short}のものになるよ（{fromMeta.short}に戻せば、また{fromMeta.short}の面接ができる）
          </li>
          <li>
            ・<span className="font-semibold text-ink">{fromMeta.short}の記録は消えない</span>
            。戻せば元どおり見られるよ
          </li>
          <li>
            ・<span className="font-semibold text-ink">やりかけの演習と模試は終わりになるよ</span>
          </li>
        </ul>
        {failed && (
          <p role="alert" className="mb-3 rounded-2xl bg-again-soft px-4 py-3 text-[13px] font-medium text-again">
            きりかえられなかったよ。やりかけは消していないから、そのまま続けられるよ。
          </p>
        )}
        <div className="flex gap-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            やめる
          </Button>
          <div className="flex-1">
            <Button
              full
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailed(false);
                void switchGrade(to).then((ok) => {
                  // 成功時は再読み込みされるのでここには来ない。来たら失敗
                  if (!ok) {
                    setBusy(false);
                    setFailed(true);
                  }
                });
              }}
            >
              {toMeta.short}にきりかえる
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 開こうとした記録・問題が他の級のものだったときの表示。白画面にしない。
 * 記録は DB に残っているので、その級に戻せば見られる、と伝えて一覧へ返す。
 */
export function OtherGradeNotice({
  title,
  of,
  onBack,
}: {
  title: string;
  of: Grade;
  onBack: () => void;
}) {
  return (
    <Screen>
      <TopBar title={title} onBack={onBack} />
      <main className="flex-1 px-5 pt-4 pb-10">
        <div className="mb-5 rounded-3xl border border-line bg-surface p-5">
          <p className="text-[16px] font-bold text-ink">これは{GRADE_META[of].short}のときの記録だよ</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
            {GRADE_META[of].short}にもどすと、また見られるよ。
          </p>
        </div>
        <Button full variant="soft" onClick={onBack}>
          もどる
        </Button>
      </main>
    </Screen>
  );
}

/** もう一方の級 */
export const otherGrade = (): Grade => (GRADE === 'pre2' ? 'g2' : 'pre2');

/**
 * URL 末尾の #grade で開く切り替え画面（#check と同じ作り）。
 * 二次が終わるまではホームから辿れないので、ここが唯一の入口になる。
 */
export function GradeScreen() {
  const [open, setOpen] = useState(false);
  const to = otherGrade();
  return (
    <Screen>
      <TopBar
        title="級のきりかえ"
        hideHome
        onBack={() => {
          window.location.hash = '';
        }}
      />
      <main className="flex-1 px-5 pt-2 pb-10">
        <div className="mb-5 rounded-3xl border border-line bg-surface p-5">
          <p className="text-[12px] text-ink-sub">いまの級</p>
          <p className="mt-1 text-[22px] font-bold text-ink">{GRADE_META[GRADE].label}</p>
        </div>
        <Button full variant="soft" onClick={() => setOpen(true)}>
          {GRADE_META[to].short}にきりかえる
        </Button>
      </main>
      {open && <GradeSwitchSheet to={to} onCancel={() => setOpen(false)} />}
    </Screen>
  );
}

/**
 * カードの文言はここ1か所。二次の前でも後でも、受かっても落ちても自然に読めるよう、
 * 「おつかれさま」のような試験の結果を前提にした言い方は避け、煽らない。
 */
export const GRADE_OFFER_TEXT = '2級の練習もできるよ。きりかえる？';

/** ホームに出す1枚。準2級のとき HomeScreen が出す（日付の条件は無い） */
export function GradeOfferCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 flex w-full items-center gap-3 rounded-2xl bg-accent-soft px-4 py-3 text-left"
    >
      <span className="flex-1 text-[14px] font-semibold text-ink">
        {GRADE_OFFER_TEXT}
      </span>
      <span className="text-ink-faint">
        <ChevronRight size={18} />
      </span>
    </button>
  );
}

/**
 * 中身がまだ無い級の画面。例外や空リストにせず、理由と戻り道を出す。
 * 2級の種データが入る G2-02 以降は、この画面に来る経路が自然に減る。
 */
export function ComingSoonScreen({ onBack }: { onBack: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Screen>
      <TopBar title={GRADE_META[GRADE].label} onBack={onBack} />
      <main className="flex-1 px-5 pt-4 pb-10">
        <div className="mb-5 rounded-3xl border border-line bg-surface p-5">
          <p className="text-[16px] font-bold text-ink">{GRADE_META[GRADE].short}の問題はまだ準備中だよ</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
            できあがるまでは、準2級にもどして続けられるよ。
          </p>
        </div>
        <Button full onClick={() => setOpen(true)}>
          準2級にもどす
        </Button>
      </main>
      {open && <GradeSwitchSheet to="pre2" onCancel={() => setOpen(false)} />}
    </Screen>
  );
}

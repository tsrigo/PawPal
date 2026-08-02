import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, MouseEvent, PointerEvent } from "react";
import { i18n, resolveLanguage } from "../../../shared/i18n";
import { BUILTIN_TASKS, TODAY_POMODORO_SLOT_COUNT } from "../../../shared/constants";
import type { PetState, SpeechBubble, TodayStats } from "../../../shared/types";
import { getPetAsset, getPetAssetVariantCount } from "../assets";
import { useNow, useSnapshot } from "../hooks";

type DragRef = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

const CONTINUOUS_ASSET_STATES = new Set<PetState>(["idle", "focusGuard"]);
const CONTINUOUS_ASSET_ROTATION_MS = 15 * 60 * 1000;

function randomVariant(count: number, previous?: number): number {
  if (count <= 1) return 0;
  let next = Math.floor(Math.random() * count);
  if (previous !== undefined && next === previous) {
    next = (next + 1) % count;
  }
  return next;
}

function formatFocusCountdown(endsAt: number | null, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil(((endsAt ?? now) - now) / 1000));
  return formatDurationSeconds(remainingSeconds);
}

function formatDurationSeconds(totalSeconds: number): string {
  const remainingSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatDistractionElapsed(startedAt: number | null, now: number): string {
  if (!startedAt) return "00:00:00";
  return formatDurationSeconds((now - startedAt) / 1000);
}

export function PetView(): JSX.Element {
  const snapshot = useSnapshot();
  const now = useNow(1000);
  const [bubble, setBubble] = useState<SpeechBubble | null>(null);
  const [assetVariant, setAssetVariant] = useState(0);
  const [assetReplayKey, setAssetReplayKey] = useState(0);
  const [stateSignal, setStateSignal] = useState(0);
  const [pomodoroHovered, setPomodoroHovered] = useState(false);
  const dragRef = useRef<DragRef | null>(null);
  const pomodoroHideTimer = useRef<number | null>(null);
  const labels = i18n(resolveLanguage(snapshot.settings.language)).settings;

  useEffect(() => {
    const offBubble = window.pawpal.onShowBubble(setBubble);
    const offHide = window.pawpal.onHideBubble(() => setBubble(null));
    const offPetState = window.pawpal.onPetState(() => setStateSignal((current) => current + 1));
    return () => {
      offBubble();
      offHide();
      offPetState();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (pomodoroHideTimer.current !== null) {
        window.clearTimeout(pomodoroHideTimer.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(".speech-bubble"));
    const reportHeight = (): void => {
      const height = elements.reduce(
        (largest, element) =>
          Math.max(
            largest,
            Math.ceil(element.getBoundingClientRect().height),
            element.scrollHeight
          ),
        0
      );
      window.pawpal.bubbleHeightChanged(height);
    };
    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [bubble, snapshot.focusGoalInlineOpen]);

  const state = snapshot.petState;
  const altText = `PawPal ${state}`;
  const facingClass = snapshot.petFacing === "left" ? "facing-left" : "facing-right";
  const appearanceId = snapshot.settings.petAppearanceId;
  const asset = getPetAsset(appearanceId, state, assetVariant, assetReplayKey);

  useEffect(() => {
    const variantCount = getPetAssetVariantCount(appearanceId, state);
    setAssetVariant(randomVariant(variantCount));
    setAssetReplayKey(0);
    if (!CONTINUOUS_ASSET_STATES.has(state) || variantCount <= 1) return;
    const timer = window.setInterval(() => {
      setAssetVariant((current) => randomVariant(variantCount, current));
    }, CONTINUOUS_ASSET_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [appearanceId, state, stateSignal]);

  useEffect(() => {
    if (!asset.replayIntervalMs) return;
    const timer = window.setInterval(() => {
      setAssetReplayKey((current) => current + 1);
    }, asset.replayIntervalMs);
    return () => window.clearInterval(timer);
  }, [asset.replayIntervalMs]);

  function startPointer(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };
  }

  function movePointer(event: PointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance > 4) {
      drag.dragging = true;
      window.pawpal.petDragStart({ offsetX: drag.startX, offsetY: drag.startY });
    }
  }

  function stopPointer(event: PointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    if (drag.dragging) {
      window.pawpal.petDragStop();
      return;
    }
    window.pawpal.petClicked();
  }

  function cancelPointer(event: PointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.dragging) window.pawpal.petDragStop();
  }

  function handleMiddleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (event.button === 1) {
      event.preventDefault();
      window.pawpal.petMiddleClicked();
    }
  }

  function showPomodoroTracker(): void {
    if (pomodoroHideTimer.current !== null) {
      window.clearTimeout(pomodoroHideTimer.current);
      pomodoroHideTimer.current = null;
    }
    setPomodoroHovered(true);
  }

  function hidePomodoroTracker(): void {
    if (pomodoroHideTimer.current !== null) window.clearTimeout(pomodoroHideTimer.current);
    pomodoroHideTimer.current = window.setTimeout(() => {
      pomodoroHideTimer.current = null;
      setPomodoroHovered(false);
    }, 700);
  }

  return (
    <main
      className="pet-shell"
      aria-label="PawPal desktop pet"
      onContextMenu={(event) => {
        event.preventDefault();
        window.pawpal.petContextMenu();
      }}
    >
      <div
        className={`pet-stage${pomodoroHovered ? " is-pomodoro-hovered" : ""}`}
        onMouseEnter={showPomodoroTracker}
        onMouseLeave={hidePomodoroTracker}
      >
        {bubble ? (
          <section className="speech-bubble">
            <p>{bubble.message}</p>
            {bubble.actions?.length ? (
              <div className="bubble-actions">
                {bubble.actions.map((action) => (
                  <button
                    className={`bubble-button ${action.kind ?? "secondary"}`}
                    key={action.id}
                    onClick={() => window.pawpal.bubbleAction(action.id)}
                    type="button"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {snapshot.focusGoalInlineOpen ? (
          <InlineGoalPrompt
            deadlineAt={snapshot.focusGoalInlineDeadlineAt}
            now={now}
            labels={labels}
          />
        ) : null}

        {snapshot.focusActive ? (
          <div className="focus-badge">
            <span>
              {snapshot.blockingMode === "focusWarning"
                ? labels.distraction
                : snapshot.focusPhase === "break"
                  ? labels.break
                  : labels.focus}
            </span>
            <strong>
              {snapshot.blockingMode === "focusWarning"
                ? formatDistractionElapsed(snapshot.timers.distractionStartedAt, now)
                : formatFocusCountdown(snapshot.timers.focusEndsAt, now)}
            </strong>
            {snapshot.settings.focusPomodoroCount > 1 ? (
              <em>
                {snapshot.focusCycleCurrent}/{snapshot.settings.focusPomodoroCount}
              </em>
            ) : null}
            {snapshot.activeTaskId ? (
              <small className="focus-badge__task">
                {[...BUILTIN_TASKS, ...snapshot.settings.tasks].find((t) => t.id === snapshot.activeTaskId)?.name ?? ""}
              </small>
            ) : null}
          </div>
        ) : snapshot.activeTaskId && snapshot.taskTimerStartedAt ? (
          (() => {
            const activeTask = [...BUILTIN_TASKS, ...snapshot.settings.tasks].find(
              (t) => t.id === snapshot.activeTaskId
            );
            const leisureCountdown = activeTask?.type === "leisure" && snapshot.leisureEndsAt !== null;
            return (
              <div className={`task-badge${leisureCountdown ? " task-badge--leisure" : ""}`}>
                <span>{activeTask?.name ?? ""}</span>
                <strong>
                  {leisureCountdown
                    ? formatFocusCountdown(snapshot.leisureEndsAt, now)
                    : formatDurationSeconds((now - snapshot.taskTimerStartedAt!) / 1000)}
                </strong>
              </div>
            );
          })()
        ) : null}

        <button
          className={`pet-button state-${state} ${facingClass} ${
            asset.isPlaceholder ? "placeholder-asset" : ""
          }`}
          onAuxClick={handleMiddleClick}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          onPointerCancel={cancelPointer}
          onPointerDown={startPointer}
          onPointerMove={movePointer}
          onPointerUp={stopPointer}
          type="button"
        >
          <img draggable={false} src={asset.src} alt={altText} />
        </button>

        <PomodoroTracker
          records={snapshot.stats.pomodoros}
          labels={labels}
          onMouseEnter={showPomodoroTracker}
          onMouseLeave={hidePomodoroTracker}
        />
      </div>
    </main>
  );
}

function PomodoroTracker({
  records,
  labels,
  onMouseEnter,
  onMouseLeave
}: {
  records: TodayStats["pomodoros"];
  labels: ReturnType<typeof i18n>["settings"];
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}): JSX.Element {
  const completedCount = records.length;
  const progressMessage =
    completedCount === 0
      ? labels.pomodoroFirst
      : completedCount === TODAY_POMODORO_SLOT_COUNT - 1
        ? labels.pomodoroAlmost
        : completedCount >= TODAY_POMODORO_SLOT_COUNT
          ? labels.pomodoroAllDone
          : labels.pomodoroProgress(completedCount, TODAY_POMODORO_SLOT_COUNT);

  return (
    <aside
      className="pomodoro-tracker"
      aria-label={labels.pomodoroTracker}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="pomodoro-tracker__head">
        <span>{labels.pomodoroTracker}</span>
        <strong>
          {completedCount}/{TODAY_POMODORO_SLOT_COUNT}
        </strong>
      </div>
      <div className="pomodoro-tracker__grid">
        {Array.from({ length: TODAY_POMODORO_SLOT_COUNT }, (_, index) => {
          const record = records[index];
          const name = record?.name ?? labels.pomodoroDefault(index + 1);
          return (
            <div
              aria-label={name}
              className={`pomodoro-slot${record ? " is-complete" : ""}`}
              key={record ? `${record.completedAt}-${index}` : `empty-${index}`}
              role="img"
              title={name}
            >
              <span>{index + 1}</span>
            </div>
          );
        })}
      </div>
      {completedCount > TODAY_POMODORO_SLOT_COUNT ? (
        <small className="pomodoro-tracker__overflow">
          +{completedCount - TODAY_POMODORO_SLOT_COUNT}
        </small>
      ) : null}
      <p className="pomodoro-tracker__message" aria-live="polite">
        {progressMessage}
      </p>
    </aside>
  );
}

function InlineGoalPrompt({
  deadlineAt,
  now,
  labels
}: {
  deadlineAt: number | null;
  now: number;
  labels: ReturnType<typeof i18n>["settings"];
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const remainingSeconds = deadlineAt
    ? Math.max(0, Math.ceil((deadlineAt - now) / 1000))
    : 0;

  function commit(): void {
    window.pawpal.submitInlineGoal(value);
  }

  return (
    <section className="speech-bubble inline-goal" aria-label={labels.inlineGoalPrompt}>
      <p>{labels.inlineGoalPrompt}</p>
      <input
        ref={inputRef}
        className="inline-goal__input"
        type="text"
        value={value}
        placeholder={labels.inlineGoalPlaceholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <div className="bubble-actions">
        <button
          type="button"
          className="bubble-button primary"
          onClick={commit}
        >
          {labels.startFocus}
        </button>
        <button
          type="button"
          className="bubble-button secondary"
          onClick={() => window.pawpal.skipInlineGoal()}
        >
          {labels.inlineGoalSkip}
        </button>
      </div>
      {deadlineAt ? (
        <small className="inline-goal__countdown">
          {remainingSeconds}
          {labels.inlineGoalCountdownSuffix}
        </small>
      ) : null}
    </section>
  );
}

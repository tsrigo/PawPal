import { useEffect, useRef, useState } from "react";
import type { JSX, MouseEvent, PointerEvent } from "react";
import { i18n, resolveLanguage } from "../../../shared/i18n";
import { BUILTIN_TASKS } from "../../../shared/constants";
import type { PetState, SpeechBubble } from "../../../shared/types";
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
  const dragRef = useRef<DragRef | null>(null);
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

  return (
    <main
      className="pet-shell"
      aria-label="PawPal desktop pet"
      onContextMenu={(event) => {
        event.preventDefault();
        window.pawpal.petContextMenu();
      }}
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
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { i18n, LANGUAGE_OPTIONS, resolveLanguage } from "../../../shared/i18n";
import { petAppearanceOptions, resolvePetAppearanceId } from "../../../shared/petAppearances";
import type { DemoTrigger, FocusGoalInput, PetAppearanceId, Settings, TodayStats } from "../../../shared/types";
import { getPetAsset } from "../assets";
import { distractionHelp, formatDistractionState, formatTimer, formatTimestamp, localeFor } from "../format";
import { useNow, useSnapshot } from "../hooks";

type SettingsCopy = ReturnType<typeof i18n>["settings"];

function Row({
  label,
  hint,
  control
}: {
  label: string;
  hint?: string;
  control: JSX.Element;
}): JSX.Element {
  return (
    <div className="pref-row">
      <div className="pref-row__label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="pref-row__control">{control}</div>
    </div>
  );
}

function ToggleControl({
  checked,
  onChange,
  ariaLabel
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`pref-toggle${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="pref-toggle__thumb" />
    </button>
  );
}

function NumberControl({
  value,
  min,
  max,
  unit,
  onChange
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (next: number) => void;
}): JSX.Element {
  return (
    <div className="pref-stepper">
      <button
        type="button"
        className="pref-stepper__btn"
        aria-label="−"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
      />
      <span className="pref-stepper__unit">{unit}</span>
      <button
        type="button"
        className="pref-stepper__btn"
        aria-label="+"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}

function SelectControl({
  value,
  options,
  onChange
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <select className="pref-select" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ChipsControl({
  value,
  onChange,
  labels
}: {
  value: string[];
  onChange: (next: string[]) => void;
  labels: SettingsCopy;
}): JSX.Element {
  const [draft, setDraft] = useState("");

  function commit(raw: string): void {
    const trimmed = raw.trim().replace(/,$/, "").trim();
    if (!trimmed) return;
    if (value.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  }

  return (
    <div className="pref-chips">
      <div className="pref-chips__list">
        {value.map((entry) => (
          <span key={entry} className="pref-chip">
            {entry}
            <button
              type="button"
              aria-label={labels.removeListItem(entry)}
              onClick={() => onChange(value.filter((item) => item !== entry))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="pref-chips__input"
          placeholder={labels.addListItem}
          value={draft}
          onChange={(event) => {
            const next = event.target.value;
            if (next.endsWith(",")) commit(next);
            else setDraft(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(draft);
            }
            if (event.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commit(draft)}
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  unit
}: {
  label: string;
  value: number;
  unit?: string;
}): JSX.Element {
  return (
    <div className="stat-card">
      <span className="stat-card__label">{label}</span>
      <strong className="stat-card__value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </strong>
    </div>
  );
}

function formatStatsDuration(ms: number, labels: SettingsCopy): string {
  const minutes = ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
  return `${minutes}${labels.minuteUnit}`;
}

function topEntries(source: Record<string, number>, limit = 3): Array<[string, number]> {
  return Object.entries(source)
    .filter(([, duration]) => duration > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

function formatHourLabel(hour: string): string {
  return `${hour}:00`;
}

function StatsList({
  title,
  entries,
  labels
}: {
  title: string;
  entries: Array<[string, number]>;
  labels: SettingsCopy;
}): JSX.Element {
  return (
    <div className="stats-panel">
      <h3 className="stats-panel__title">{title}</h3>
      {entries.length ? (
        <ol className="stats-list">
          {entries.map(([name, duration]) => (
            <li key={name}>
              <span title={name}>{name}</span>
              <strong>{formatStatsDuration(duration, labels)}</strong>
            </li>
          ))}
        </ol>
      ) : (
        <p className="stats-empty">{labels.noStatsYet}</p>
      )}
    </div>
  );
}

function StatsOverview({ stats, labels }: { stats: TodayStats; labels: SettingsCopy }): JSX.Element {
  const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
  const maxHourDuration = Math.max(
    1,
    ...hours.map((hour) => (stats.focusByHour[hour] ?? 0) + (stats.distractionByHour[hour] ?? 0))
  );
  const topHours = topEntries(
    Object.fromEntries(
      hours.map((hour) => [formatHourLabel(hour), (stats.focusByHour[hour] ?? 0) + (stats.distractionByHour[hour] ?? 0)])
    )
  );

  return (
    <section className="prefs__analytics" aria-label={labels.focusDistribution}>
      <div className="analytics-summary">
        <div>
          <span>{labels.focusTime}</span>
          <strong>{formatStatsDuration(stats.focusMs, labels)}</strong>
        </div>
        <div>
          <span>{labels.distractionTime}</span>
          <strong>{formatStatsDuration(stats.distractionMs, labels)}</strong>
        </div>
      </div>

      <div className="stats-panel stats-panel--wide">
        <div className="stats-panel__head">
          <h3 className="stats-panel__title">{labels.focusDistribution}</h3>
          <span>{labels.distractionDistribution}</span>
        </div>
        <div className="hour-bars">
          {hours.map((hour) => {
            const focus = stats.focusByHour[hour] ?? 0;
            const distraction = stats.distractionByHour[hour] ?? 0;
            const total = focus + distraction;
            return (
              <div className="hour-bar" key={hour} title={`${formatHourLabel(hour)} ${formatStatsDuration(total, labels)}`}>
                <span>{formatHourLabel(hour)}</span>
                <div className="hour-bar__track">
                  <i
                    className="hour-bar__focus"
                    style={{ width: `${(focus / maxHourDuration) * 100}%` }}
                  />
                  <i
                    className="hour-bar__distraction"
                    style={{ width: `${(distraction / maxHourDuration) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="analytics-grid">
        <StatsList title={labels.topFocusWindows} entries={topEntries(stats.focusByWindow)} labels={labels} />
        <StatsList title={labels.topDistractionWindows} entries={topEntries(stats.distractionByWindow)} labels={labels} />
        <StatsList title={labels.topHours} entries={topHours} labels={labels} />
      </div>
    </section>
  );
}

function createGoalDraft(count: number, source?: FocusGoalInput | null): FocusGoalInput {
  return {
    bigGoalTitle: source?.bigGoalTitle ?? "",
    smallGoalTitles: Array.from({ length: count }, (_, index) => source?.smallGoalTitles[index] ?? "")
  };
}

function currentGoalText(snapshot: ReturnType<typeof useSnapshot>): string | null {
  const session = snapshot.goalSession;
  if (!session) return null;
  return session.smallGoals[session.currentSmallGoalIndex]?.title || session.bigGoal.title;
}

export function SettingsView(): JSX.Element {
  const snapshot = useSnapshot();
  const { settings, stats } = snapshot;
  const [draft, setDraft] = useState(settings);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState<FocusGoalInput>(() =>
    createGoalDraft(settings.focusPomodoroCount, snapshot.goalDraft)
  );
  const [smallGoalsOpen, setSmallGoalsOpen] = useState(false);
  const [goalError, setGoalError] = useState("");
  const now = useNow();
  const savedSettingsKey = JSON.stringify(settings);
  const language = resolveLanguage(draft.language);
  const labels = i18n(language).settings;

  const petAvatar = useMemo(
    () => getPetAsset(resolvePetAppearanceId(draft.petAppearanceId), "happy"),
    [draft.petAppearanceId]
  );

  useEffect(() => {
    setDraft(settings);
    setSettingsDirty(false);
  }, [savedSettingsKey, settings]);

  useEffect(() => {
    setGoalDraft((current) =>
      createGoalDraft(settings.focusPomodoroCount, snapshot.goalDraft ?? current)
    );
  }, [settings.focusPomodoroCount, snapshot.goalDraft]);

  useEffect(() => {
    if (!settingsDirty) return;
    const timer = window.setTimeout(() => {
      window.pawpal.updateSettings(draft);
      setSettingsDirty(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft, settingsDirty]);

  function updateDraft(partial: Partial<Settings>): void {
    setDraft((current) => ({ ...current, ...partial }));
    setSettingsDirty(true);
  }

  function updateGoalDraft(partial: Partial<FocusGoalInput>): void {
    setGoalDraft((current) => ({
      ...current,
      ...partial
    }));
    setGoalError("");
  }

  function updateSmallGoal(index: number, value: string): void {
    setGoalDraft((current) => {
      const nextSmallGoals = [...current.smallGoalTitles];
      nextSmallGoals[index] = value;
      return { ...current, smallGoalTitles: nextSmallGoals };
    });
    setGoalError("");
  }

  function startWithGoals(): void {
    const next = createGoalDraft(draft.focusPomodoroCount, goalDraft);
    if (!next.bigGoalTitle.trim() || !next.smallGoalTitles[0]?.trim()) {
      setGoalError(labels.goalRequired);
      return;
    }
    window.pawpal.startFocusWithGoals(next);
  }

  const currentApp = snapshot.distraction.activeApp.trim();
  const canAddCurrentApp =
    Boolean(currentApp) &&
    !draft.distractionBlockedApps.some((entry) => entry.toLowerCase() === currentApp.toLowerCase());
  const goalPanelOpen = snapshot.focusGoalInputOpen || Boolean(snapshot.goalSession);
  const visibleSmallGoalCount = smallGoalsOpen ? draft.focusPomodoroCount : 1;
  const activeGoalText = currentGoalText(snapshot);

  return (
    <main className="prefs">
      <header className="prefs__head">
        <img className="prefs__avatar" src={petAvatar.src} alt="" />
        <div className="prefs__intro">
          <p className="prefs__eyebrow">PawPal</p>
          <h1 className="prefs__title">{labels.today}</h1>
        </div>
      </header>

      <section className="prefs__stats" aria-label={labels.today}>
        <StatCard label={labels.breaks} value={stats.breaksTaken} unit={labels.countUnit} />
        <StatCard label={labels.waters} value={stats.watersLogged} unit={labels.countUnit} />
        <StatCard label={labels.focusMin} value={stats.focusMinutes} unit={labels.minuteUnit} />
        <StatCard label={labels.warnings} value={stats.focusWarnings} unit={labels.countUnit} />
      </section>

      <StatsOverview stats={stats} labels={labels} />

      {!draft.onboardingDismissed ? (
        <aside className="prefs__welcome">
          <p>
            <strong>{labels.welcomeTitle}.</strong> {labels.welcomeCopy}
          </p>
          <button
            type="button"
            className="text-link"
            onClick={() => updateDraft({ onboardingDismissed: true })}
          >
            {labels.dismissWelcome}
          </button>
        </aside>
      ) : null}

      <section className="prefs__group">
        <h2 className="prefs__group-title">{labels.appearance}</h2>
        <Row
          label={labels.language}
          control={
            <SelectControl
              value={language}
              options={[...LANGUAGE_OPTIONS]}
              onChange={(value) => updateDraft({ language: resolveLanguage(value) })}
            />
          }
        />
        <div className="pref-block">
          <span className="pref-block__label">{labels.petAppearance}</span>
          <div className="pet-picker">
            {petAppearanceOptions(language).map((option) => (
              <PetCard
                key={option.value}
                appearanceId={option.value}
                label={option.label}
                selected={resolvePetAppearanceId(draft.petAppearanceId) === option.value}
                onSelect={() =>
                  updateDraft({ petAppearanceId: resolvePetAppearanceId(option.value) })
                }
              />
            ))}
          </div>
        </div>
      </section>

      <section className="prefs__group">
        <h2 className="prefs__group-title">{labels.reminders}</h2>
        <Row
          label={labels.enableBreakReminder}
          control={
            <ToggleControl
              checked={draft.breakReminderEnabled}
              onChange={(breakReminderEnabled) => updateDraft({ breakReminderEnabled })}
              ariaLabel={labels.enableBreakReminder}
            />
          }
        />
        <Row
          label={labels.breakInterval}
          control={
            <NumberControl
              value={draft.breakIntervalMinutes}
              min={1}
              max={180}
              unit={labels.minuteUnit}
              onChange={(breakIntervalMinutes) => updateDraft({ breakIntervalMinutes })}
            />
          }
        />
        <Row
          label={labels.enableHydrationReminder}
          control={
            <ToggleControl
              checked={draft.hydrationReminderEnabled}
              onChange={(hydrationReminderEnabled) => updateDraft({ hydrationReminderEnabled })}
              ariaLabel={labels.enableHydrationReminder}
            />
          }
        />
        <Row
          label={labels.hydrationInterval}
          control={
            <NumberControl
              value={draft.hydrationIntervalMinutes}
              min={1}
              max={240}
              unit={labels.minuteUnit}
              onChange={(hydrationIntervalMinutes) => updateDraft({ hydrationIntervalMinutes })}
            />
          }
        />
      </section>

      <section className="prefs__group">
        <h2 className="prefs__group-title">{labels.focus}</h2>
        {goalPanelOpen ? (
          <div className="goal-panel">
            <div className="goal-panel__head">
              <div>
                <h3>{labels.goalPlanning}</h3>
                <p>{activeGoalText ? `${labels.currentGoal}: ${activeGoalText}` : labels.goalInputHint}</p>
              </div>
              {!snapshot.focusActive ? (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    window.pawpal.clearGoalDraft();
                    setGoalDraft(createGoalDraft(draft.focusPomodoroCount));
                  }}
                >
                  {labels.clearGoalDraft}
                </button>
              ) : null}
            </div>
            {!snapshot.focusActive ? (
              <>
                <label className="goal-field">
                  <span>{labels.bigGoal}</span>
                  <input
                    value={goalDraft.bigGoalTitle}
                    placeholder={labels.bigGoalPlaceholder}
                    onChange={(event) => updateGoalDraft({ bigGoalTitle: event.target.value })}
                  />
                </label>
                <div className="goal-fieldset">
                  <div className="goal-fieldset__head">
                    <span>{labels.smallGoals}</span>
                    {draft.focusPomodoroCount > 1 ? (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => setSmallGoalsOpen((open) => !open)}
                      >
                        {smallGoalsOpen ? labels.collapseSmallGoals : labels.expandSmallGoals}
                      </button>
                    ) : null}
                  </div>
                  {Array.from({ length: visibleSmallGoalCount }, (_, index) => (
                    <label className="goal-field" key={index}>
                      <span>{index + 1}</span>
                      <input
                        value={goalDraft.smallGoalTitles[index] ?? ""}
                        placeholder={labels.smallGoalPlaceholder(index + 1)}
                        onChange={(event) => updateSmallGoal(index, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
                {goalError ? <p className="goal-panel__error">{goalError}</p> : null}
                <div className="prefs__inline-actions">
                  <button type="button" className="pref-button is-primary" onClick={startWithGoals}>
                    {labels.startWithGoals}
                  </button>
                </div>
              </>
            ) : snapshot.goalSession ? (
              <ol className="goal-status-list">
                <li>
                  <span>{snapshot.goalSession.bigGoal.title}</span>
                  <strong>
                    {snapshot.goalSession.bigGoal.status === "completed"
                      ? labels.goalCompletedStatus
                      : labels.goalInProgressStatus}
                  </strong>
                </li>
                {snapshot.goalSession.smallGoals.map((goal, index) => (
                  <li key={goal.id} className={index === snapshot.goalSession?.currentSmallGoalIndex ? "is-current" : ""}>
                    <span>{goal.title}</span>
                    <strong>
                      {goal.status === "completed"
                        ? labels.goalCompletedStatus
                        : labels.goalInProgressStatus}
                    </strong>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
        <Row
          label={labels.focusDuration}
          control={
            <NumberControl
              value={draft.focusDurationMinutes}
              min={1}
              max={120}
              unit={labels.minuteUnit}
              onChange={(focusDurationMinutes) => updateDraft({ focusDurationMinutes })}
            />
          }
        />
        <Row
          label={labels.focusBreakDuration}
          control={
            <NumberControl
              value={draft.focusBreakMinutes}
              min={1}
              max={60}
              unit={labels.minuteUnit}
              onChange={(focusBreakMinutes) => updateDraft({ focusBreakMinutes })}
            />
          }
        />
        <Row
          label={labels.pomodoroCount}
          control={
            <NumberControl
              value={draft.focusPomodoroCount}
              min={1}
              max={12}
              unit={labels.countUnit}
              onChange={(focusPomodoroCount) => updateDraft({ focusPomodoroCount })}
            />
          }
        />
        <Row
          label={labels.enableDistractionDetection}
          hint={
            draft.distractionDetectionEnabled
              ? labels.detectionFocusHelp
              : labels.detectionOffHelp
          }
          control={
            <ToggleControl
              checked={draft.distractionDetectionEnabled}
              onChange={(distractionDetectionEnabled) => updateDraft({ distractionDetectionEnabled })}
              ariaLabel={labels.enableDistractionDetection}
            />
          }
        />
        {draft.distractionDetectionEnabled ? (
          <>
            <Row
              label={labels.detectionGrace}
              control={
                <NumberControl
                  value={draft.distractionGraceSeconds}
                  min={0}
                  max={120}
                  unit={labels.secondUnit}
                  onChange={(distractionGraceSeconds) => updateDraft({ distractionGraceSeconds })}
                />
              }
            />
            <Row
              label={labels.blockedApps}
              control={
                <ChipsControl
                  value={draft.distractionBlockedApps}
                  labels={labels}
                  onChange={(distractionBlockedApps) => updateDraft({ distractionBlockedApps })}
                />
              }
            />
            <Row
              label={labels.blockedKeywords}
              control={
                <ChipsControl
                  value={draft.distractionBlockedKeywords}
                  labels={labels}
                  onChange={(distractionBlockedKeywords) => updateDraft({ distractionBlockedKeywords })}
                />
              }
            />
          </>
        ) : null}
        <div className="prefs__inline-actions">
          {snapshot.focusActive ? (
            <button type="button" className="pref-button" onClick={window.pawpal.stopFocus}>
              {labels.stopFocus}
            </button>
          ) : goalPanelOpen ? null : (
            <button type="button" className="pref-button is-primary" onClick={window.pawpal.startFocus}>
              {labels.startFocus}
            </button>
          )}
        </div>
      </section>

      {!window.pawpal.isPackaged && (
        <section className="prefs__group">
          <h2 className="prefs__group-title">{labels.testTools}</h2>
          <div className="test-tools">
            <DemoChip trigger="break" label={labels.demoBreak} />
            <DemoChip trigger="hydration" label={labels.demoWater} />
            <DemoChip trigger="focusWarning" label={labels.demoFocusWarning} />
            <DemoChip trigger="happy" label={labels.demoHappy} />
            <button type="button" className="pref-chip-button" onClick={window.pawpal.resetToday}>
              {labels.resetToday}
            </button>
          </div>
        </section>
      )}

      <section className="prefs__group prefs__group--quiet">
        <button
          type="button"
          className="prefs__disclosure"
          onClick={() => setDiagnosticsOpen((open) => !open)}
          aria-expanded={diagnosticsOpen}
        >
          <span>{labels.diagnostics}</span>
          <span className="prefs__disclosure-caret">{diagnosticsOpen ? "▾" : "▸"}</span>
        </button>
        {diagnosticsOpen ? (
          <div className="prefs__diag">
            <DiagGroup title={labels.runtime}>
              <DiagCard label={labels.state} value={snapshot.petState} />
              <DiagCard
                label={labels.mode}
                value={
                  snapshot.focusActive
                    ? labels.focus
                    : labels.idle
                }
              />
              <DiagCard label={labels.reminder} value={snapshot.blockingMode ?? labels.none} />
              <DiagCard
                label={labels.dog}
                value={snapshot.dogVisible ? labels.visible : labels.hidden}
              />
            </DiagGroup>

            <DiagGroup title={labels.distraction}>
              <DiagCard
                label={labels.status}
                value={formatDistractionState(snapshot.distraction.state, labels)}
              />
              <DiagCard
                label={labels.matched}
                value={snapshot.distraction.matchedRule ?? labels.none}
              />
              <DiagCard
                label={labels.app}
                value={snapshot.distraction.activeApp || labels.none}
              />
              <DiagCard
                label={labels.checked}
                value={formatTimestamp(snapshot.distraction.lastCheckedAt, language, labels)}
              />
            </DiagGroup>
            <div className="prefs__diag-actions">
              <button
                type="button"
                className="pref-button"
                disabled={!canAddCurrentApp}
                onClick={() => window.pawpal.blockCurrentApp()}
              >
                {labels.addCurrentApp}
              </button>
            </div>

            {snapshot.distraction.activeWindowTitle ? (
              <p className="prefs__diag-note">{snapshot.distraction.activeWindowTitle}</p>
            ) : null}
            <p className="prefs__diag-hint">{distractionHelp(snapshot, labels)}</p>

            <DiagGroup title={labels.timers}>
              <DiagCard
                label={labels.break}
                value={formatTimer(snapshot.timers.breakDueAt, now, language, labels)}
              />
              <DiagCard
                label={labels.water}
                value={formatTimer(snapshot.timers.hydrationDueAt, now, language, labels)}
              />
              <DiagCard
                label={labels.focusEnd}
                value={formatTimer(snapshot.timers.focusEndsAt, now, language, labels)}
              />
              <DiagCard
                label={labels.updated}
                value={new Intl.DateTimeFormat(localeFor(language), {
                  hour: "2-digit",
                  minute: "2-digit"
                }).format(now)}
              />
            </DiagGroup>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function PetCard({
  appearanceId,
  label,
  selected,
  onSelect
}: {
  appearanceId: PetAppearanceId;
  label: string;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const asset = useMemo(() => getPetAsset(appearanceId, "idle"), [appearanceId]);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`pet-card${selected ? " is-selected" : ""}`}
      onClick={onSelect}
    >
      <span className="pet-card__preview">
        <img src={asset.src} alt="" />
      </span>
      <span className="pet-card__name">{label}</span>
    </button>
  );
}

function DemoChip({ trigger, label }: { trigger: DemoTrigger; label: string }): JSX.Element {
  return (
    <button
      type="button"
      className="pref-chip-button"
      onClick={() => window.pawpal.triggerDemo(trigger)}
    >
      {label}
    </button>
  );
}

function DiagGroup({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="diag-group">
      <h3 className="diag-group__title">{title}</h3>
      <div className="diag-group__grid">{children}</div>
    </section>
  );
}

function DiagCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="diag-card">
      <span className="diag-card__label">{label}</span>
      <span className="diag-card__value">{value}</span>
    </div>
  );
}

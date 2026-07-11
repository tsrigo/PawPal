import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { i18n, LANGUAGE_OPTIONS, resolveLanguage } from "../../../shared/i18n";
import { petAppearanceOptions, resolvePetAppearanceId } from "../../../shared/petAppearances";
import { BUILTIN_TASKS, createEmptyTaskStat, todayKey } from "../../../shared/constants";
import type {
  DemoTrigger,
  FocusGoalInput,
  PetAppearanceId,
  Schedule,
  Settings,
  StatsHistory,
  Task,
  TaskStat,
  TaskType,
  TodayStats
} from "../../../shared/types";
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

function mergeWindowMaps(...maps: Array<Record<string, number> | undefined>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [key, duration] of Object.entries(map)) {
      merged[key] = (merged[key] ?? 0) + duration;
    }
  }
  return merged;
}

function lastNDateKeys(n: number, today = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (n - 1 - i));
    return todayKey(d);
  });
}

// Monday is the first day of the week (matches zh-CN locale convention).
function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

// Local "YYYY-MM-DD" key for a date (alias for the shared todayKey helper).
function toYearMonthDay(date: Date): string {
  return todayKey(date);
}

function startOfMonth(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function rangeDateKeys(start: Date, end: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const stop = new Date(end);
  stop.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= stop.getTime()) {
    keys.push(todayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

type StatsDimension = "today" | "yesterday" | "thisWeek" | "thisMonth" | "last7" | "last30";

function dimensionDateKeys(dimension: StatsDimension, now = new Date()): string[] {
  switch (dimension) {
    case "today":
      return lastNDateKeys(1, now);
    case "yesterday":
      return rangeDateKeys(addDays(now, -1), addDays(now, -1));
    case "thisWeek": {
      const start = startOfWeek(now);
      return rangeDateKeys(start, now);
    }
    case "thisMonth": {
      const start = startOfMonth(now);
      return rangeDateKeys(start, now);
    }
    case "last7":
      return lastNDateKeys(7, now);
    case "last30":
      return lastNDateKeys(30, now);
    default:
      return lastNDateKeys(7, now);
  }
}

function isSingleDayDimension(dimension: StatsDimension): boolean {
  return dimension === "today" || dimension === "yesterday";
}

function mergeTaskStat(a: TaskStat | undefined, b: TaskStat | undefined): TaskStat {
  return {
    focusMs: (a?.focusMs ?? 0) + (b?.focusMs ?? 0),
    distractionMs: (a?.distractionMs ?? 0) + (b?.distractionMs ?? 0),
    activeMs: (a?.activeMs ?? 0) + (b?.activeMs ?? 0),
    focusByWindow: mergeWindowMaps(a?.focusByWindow, b?.focusByWindow),
    distractionByWindow: mergeWindowMaps(a?.distractionByWindow, b?.distractionByWindow),
    activeByWindow: mergeWindowMaps(a?.activeByWindow, b?.activeByWindow)
  };
}

function formatDayLabel(key: string): string {
  const [, m, d] = key.split("-");
  return `${m}/${d}`;
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

type ActivityCompositionRow = {
  id: string;
  name: string;
  totalMs: number;
  focusMs: number;
  activeMs: number;
  distractionMs: number;
};

const ACTIVITY_COLORS = ["#4f9d83", "#b67d3a", "#5278a8", "#c65f46", "#7d6da8", "#879761"];

function activityStatTotal(stat: TaskStat): number {
  return Math.max(stat.activeMs, stat.focusMs + stat.distractionMs);
}

function ActivityComposition({
  stats,
  tasks,
  labels
}: {
  stats: TodayStats;
  tasks: Task[];
  labels: SettingsCopy;
}): JSX.Element {
  const allTasks = useMemo(() => [...BUILTIN_TASKS, ...tasks], [tasks]);
  const rows = useMemo<ActivityCompositionRow[]>(() => {
    const taskRows = allTasks
      .map((task): ActivityCompositionRow | null => {
        const stat = stats.taskStats[task.id];
        if (!stat) return null;
        const totalMs = activityStatTotal(stat);
        if (totalMs <= 0) return null;
        return {
          id: task.id,
          name: task.name,
          totalMs,
          focusMs: stat.focusMs,
          activeMs: stat.activeMs,
          distractionMs: stat.distractionMs
        };
      })
      .filter((row): row is ActivityCompositionRow => Boolean(row));

    const assignedFocusMs = taskRows.reduce((sum, row) => sum + row.focusMs, 0);
    const assignedDistractionMs = taskRows.reduce((sum, row) => sum + row.distractionMs, 0);
    const unassignedFocusMs = Math.max(0, stats.focusMs - assignedFocusMs);
    const unassignedDistractionMs = Math.max(0, stats.distractionMs - assignedDistractionMs);
    if (unassignedFocusMs > 0 || unassignedDistractionMs > 0) {
      taskRows.push({
        id: "__unassigned__",
        name: labels.unassignedActivity,
        totalMs: unassignedFocusMs + unassignedDistractionMs,
        focusMs: unassignedFocusMs,
        activeMs: 0,
        distractionMs: unassignedDistractionMs
      });
    }

    return taskRows.sort((left, right) => right.totalMs - left.totalMs);
  }, [allTasks, labels.unassignedActivity, stats]);

  const totalMs = rows.reduce((sum, row) => sum + row.totalMs, 0);

  return (
    <section className="prefs__analytics" aria-label={labels.activityComposition}>
      <div className="stats-panel stats-panel--wide activity-composition">
        <div className="stats-panel__head">
          <h3 className="stats-panel__title">{labels.activityComposition}</h3>
          <span>{formatStatsDuration(totalMs, labels)}</span>
        </div>
        {rows.length ? (
          <div className="activity-composition__list">
            {rows.map((row, index) => {
              const share = totalMs > 0 ? (row.totalMs / totalMs) * 100 : 0;
              const details = [
                row.focusMs > 0 ? `${labels.taskFocus} ${formatStatsDuration(row.focusMs, labels)}` : null,
                row.activeMs > 0 ? `${labels.taskActive} ${formatStatsDuration(row.activeMs, labels)}` : null,
                row.distractionMs > 0
                  ? `${labels.taskDistraction} ${formatStatsDuration(row.distractionMs, labels)}`
                  : null
              ].filter(Boolean);
              return (
                <div className="activity-row" key={row.id}>
                  <div className="activity-row__head">
                    <span title={row.name}>{row.name}</span>
                    <strong>
                      {formatStatsDuration(row.totalMs, labels)}
                      <small>{Math.round(share)}%</small>
                    </strong>
                  </div>
                  <div className="activity-row__bar" aria-hidden="true">
                    <i
                      style={{
                        width: `${share}%`,
                        backgroundColor: ACTIVITY_COLORS[index % ACTIVITY_COLORS.length]
                      }}
                    />
                  </div>
                  {details.length ? <small className="activity-row__detail">{details.join(" / ")}</small> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="stats-empty">{labels.noStatsYet}</p>
        )}
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

const TASK_TYPE_OPTIONS: { value: TaskType; labelKey: "taskTypeDeepWork" | "taskTypeMisc" | "taskTypeLeisure" }[] = [
  { value: "deepWork", labelKey: "taskTypeDeepWork" },
  { value: "misc", labelKey: "taskTypeMisc" },
  { value: "leisure", labelKey: "taskTypeLeisure" }
];

function formatElapsed(ms: number, labels: SettingsCopy): string {
  if (ms <= 0) return `0${labels.minuteUnit}`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function TaskSection({
  snapshot,
  tasks,
  stats,
  labels,
  now
}: {
  snapshot: ReturnType<typeof useSnapshot>;
  tasks: Task[];
  stats: TodayStats;
  labels: SettingsCopy;
  now: number;
}): JSX.Element {
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskType, setNewTaskType] = useState<TaskType>("deepWork");

  const allTasks = [...BUILTIN_TASKS, ...tasks];
  const { activeTaskId, taskTimerStartedAt } = snapshot;
  const autoSwitch = snapshot.settings.autoTaskSwitchEnabled;

  function taskStatLine(task: Task): JSX.Element | null {
    const stat = stats.taskStats[task.id];
    if (!stat) return null;
    const parts: string[] = [];
    if (stat.focusMs > 0) parts.push(`${labels.taskFocus} ${formatStatsDuration(stat.focusMs, labels)}`);
    if (stat.distractionMs > 0) parts.push(`${labels.taskDistraction} ${formatStatsDuration(stat.distractionMs, labels)}`);
    if (stat.activeMs > 0) parts.push(`${labels.taskActive} ${formatStatsDuration(stat.activeMs, labels)}`);
    if (!parts.length) return null;
    return <small className="task-stat-line">{parts.join(" · ")}</small>;
  }

  function taskWindowList(task: Task): JSX.Element | null {
    const stat = stats.taskStats[task.id];
    if (!stat) return null;
    const entries = topEntries(
      mergeWindowMaps(stat.activeByWindow, stat.focusByWindow, stat.distractionByWindow),
      4
    );
    if (!entries.length) return null;
    return (
      <div className="task-window-block">
        <small className="task-window-title">{labels.taskWindows}</small>
        <ul className="task-window-list">
          {entries.map(([name, duration]) => (
            <li key={name}>
              <span title={name}>{name}</span>
              <strong>{formatStatsDuration(duration, labels)}</strong>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function taskRules(task: Task): JSX.Element | null {
    if (!autoSwitch) return null;
    if (task.isBuiltin) {
      if (task.type !== "leisure") return null;
      return (
        <div className="task-rules-block">
          <small className="task-window-title">{labels.taskMatchRules}</small>
          <small className="task-rules-hint">{labels.leisureAutoMatchHint}</small>
        </div>
      );
    }
    return (
      <div className="task-rules-block">
        <small className="task-window-title">{labels.taskMatchRules}</small>
        <ChipsControl
          value={task.matchRules ?? []}
          labels={labels}
          onChange={(rules) => window.pawpal.setTaskRules(task.id, rules)}
        />
      </div>
    );
  }

  return (
    <section className="prefs__group">
      <h2 className="prefs__group-title">{labels.tasksSection}</h2>

      <Row
        label={labels.autoTaskSwitch}
        hint={labels.autoTaskSwitchHint}
        control={
          <ToggleControl
            checked={autoSwitch}
            ariaLabel={labels.autoTaskSwitch}
            onChange={(autoTaskSwitchEnabled) => window.pawpal.updateSettings({ autoTaskSwitchEnabled })}
          />
        }
      />

      <div className="task-list">
        <div className="task-item task-item--none">
          <button
            type="button"
            className={`task-name-btn${!activeTaskId ? " is-active" : ""}`}
            onClick={() => window.pawpal.activateTask(null)}
          >
            {labels.noActiveTask}
          </button>
        </div>
        {allTasks.map((task) => {
          const isActive = activeTaskId === task.id;
          const liveMs = isActive && taskTimerStartedAt !== null ? now - taskTimerStartedAt : null;
          return (
            <div key={task.id} className={`task-item${isActive ? " is-active" : ""}`}>
              <button
                type="button"
                className={`task-name-btn${isActive ? " is-active" : ""}`}
                onClick={() => window.pawpal.activateTask(isActive ? null : task.id)}
              >
                <span className="task-item__name">{task.name}</span>
                <span className="task-item__type">
                  {labels[TASK_TYPE_OPTIONS.find((o) => o.value === task.type)?.labelKey ?? "taskTypeDeepWork"]}
                </span>
                {isActive && liveMs !== null ? (
                  <span className="task-item__timer">{formatElapsed(liveMs, labels)}</span>
                ) : null}
              </button>
              {taskStatLine(task)}
              {taskWindowList(task)}
              {taskRules(task)}
              {!task.isBuiltin ? (
                <button
                  type="button"
                  className="task-remove-btn"
                  aria-label={`Remove ${task.name}`}
                  onClick={() => window.pawpal.removeTask(task.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="task-add-row">
        <input
          className="task-name-input"
          placeholder={labels.taskNamePlaceholder}
          value={newTaskName}
          onChange={(e) => setNewTaskName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newTaskName.trim()) {
              window.pawpal.addTask(newTaskName.trim(), newTaskType);
              setNewTaskName("");
            }
          }}
        />
        <select
          className="task-type-select"
          value={newTaskType}
          onChange={(e) => setNewTaskType(e.target.value as TaskType)}
        >
          {TASK_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {labels[opt.labelKey]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="pref-button"
          disabled={!newTaskName.trim()}
          onClick={() => {
            if (!newTaskName.trim()) return;
            window.pawpal.addTask(newTaskName.trim(), newTaskType);
            setNewTaskName("");
          }}
        >
          {labels.addTask}
        </button>
      </div>
    </section>
  );
}

function ScheduleSection({
  schedules,
  tasks,
  labels
}: {
  schedules: Schedule[];
  tasks: Task[];
  labels: SettingsCopy;
}): JSX.Element {
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTime, setDraftTime] = useState("09:00");
  const [draftTaskId, setDraftTaskId] = useState<string>("");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const taskOptions = [
    { value: "", label: labels.taskTypeMisc },
    ...[...BUILTIN_TASKS, ...tasks]
      .filter((t) => t.id !== "__leisure__")
      .map((t) => ({ value: t.id, label: t.name }))
  ];

  function toggleDay(days: number[], day: number): number[] {
    return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
  }

  // 42-cell grid (6 weeks) starting from the Sunday of the first week of the cursor month.
  const today = new Date();
  const todayKey = toYearMonthDay(today);
  const calendarDays = useMemo(() => {
    const firstOfMonth = new Date(cursor.year, cursor.month, 1);
    const startOffset = firstOfMonth.getDay(); // 0 = Sunday
    const start = new Date(cursor.year, cursor.month, 1 - startOffset);
    const cells: Array<{ date: Date; key: string; inMonth: boolean }> = [];
    for (let i = 0; i < 42; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      cells.push({
        date,
        key: toYearMonthDay(date),
        inMonth: date.getMonth() === cursor.month
      });
    }
    return cells;
  }, [cursor]);

  const schedulesForCell = useMemo(() => {
    const map = new Map<string, Schedule[]>();
    for (const cell of calendarDays) {
      const dow = cell.date.getDay();
      const hits = schedules
        .filter((s) => s.enabled)
        .filter((s) => s.daysOfWeek.length === 0 || s.daysOfWeek.includes(dow))
        .sort((a, b) => a.time.localeCompare(b.time));
      map.set(cell.key, hits);
    }
    return map;
  }, [calendarDays, schedules]);

  const monthHasSchedules = Array.from(schedulesForCell.values()).some((list) => list.length > 0);

  function addMonths(delta: number): void {
    setCursor((current) => {
      const d = new Date(current.year, current.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  return (
    <section className="prefs__group">
      <h2 className="prefs__group-title">{labels.schedulesSection}</h2>
      <p className="prefs__hint">{labels.scheduleHint}</p>

      <div className="schedule-view-toggle">
        <button
          type="button"
          className={view === "list" ? "is-active" : ""}
          onClick={() => setView("list")}
        >
          {labels.scheduleViewList}
        </button>
        <button
          type="button"
          className={view === "calendar" ? "is-active" : ""}
          onClick={() => setView("calendar")}
        >
          {labels.scheduleViewCalendar}
        </button>
      </div>

      {view === "list" ? (
        <>
          {schedules.length ? (
            <div className="schedule-list">
              {schedules.map((schedule) => (
                <div key={schedule.id} className={`schedule-item${schedule.enabled ? "" : " is-disabled"}`}>
                  <div className="schedule-item__row">
                    <input
                      className="schedule-item__title"
                      type="text"
                      value={schedule.title}
                      placeholder={labels.scheduleTitle}
                      onChange={(e) =>
                        window.pawpal.updateSchedule(schedule.id, { title: e.target.value })
                      }
                    />
                    <input
                      className="schedule-item__time"
                      type="time"
                      value={schedule.time}
                      onChange={(e) =>
                        window.pawpal.updateSchedule(schedule.id, { time: e.target.value })
                      }
                    />
                    <select
                      className="schedule-item__task"
                      value={schedule.taskId ?? ""}
                      onChange={(e) =>
                        window.pawpal.updateSchedule(schedule.id, { taskId: e.target.value || null })
                      }
                    >
                      {taskOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={`schedule-item__toggle${schedule.enabled ? " is-active" : ""}`}
                      aria-label={labels.scheduleEnabled}
                      onClick={() =>
                        window.pawpal.updateSchedule(schedule.id, { enabled: !schedule.enabled })
                      }
                    >
                      {schedule.enabled ? "●" : "○"}
                    </button>
                    <button
                      type="button"
                      className="schedule-item__delete"
                      aria-label={labels.scheduleDelete}
                      onClick={() => window.pawpal.removeSchedule(schedule.id)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="schedule-item__days">
                    {labels.dayLabels.map((label, day) => (
                      <button
                        type="button"
                        key={day}
                        className={`schedule-day${
                          schedule.daysOfWeek.length === 0 || schedule.daysOfWeek.includes(day)
                            ? " is-active"
                            : ""
                        }`}
                        onClick={() =>
                          window.pawpal.updateSchedule(schedule.id, {
                            daysOfWeek: toggleDay(schedule.daysOfWeek, day)
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                    <small className="schedule-item__repeat-hint">
                      {schedule.daysOfWeek.length === 0 ? labels.scheduleEveryDay : null}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="schedule-add-row">
            <input
              className="schedule-name-input"
              type="text"
              placeholder={labels.scheduleTitle}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addSchedule();
              }}
            />
            <input
              className="schedule-time-input"
              type="time"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
            />
            <select
              className="schedule-task-select"
              value={draftTaskId}
              onChange={(e) => setDraftTaskId(e.target.value)}
            >
              {taskOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="pref-button"
              onClick={() => addSchedule()}
            >
              {labels.scheduleAdd}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="calendar-nav">
            <button type="button" aria-label={labels.schedulePrevMonth} onClick={() => addMonths(-1)}>
              ‹
            </button>
            <strong>{labels.monthNames[cursor.month]} {cursor.year}</strong>
            <button type="button" aria-label={labels.scheduleNextMonth} onClick={() => addMonths(1)}>
              ›
            </button>
            <button
              type="button"
              className="calendar-nav__today"
              onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}
            >
              {labels.scheduleToday}
            </button>
          </div>
          <div className="calendar-grid">
            {labels.dayLabels.map((label) => (
              <div className="calendar-cell calendar-cell--head" key={label}>
                {label}
              </div>
            ))}
            {calendarDays.map((cell) => {
              const hits = schedulesForCell.get(cell.key) ?? [];
              const isToday = cell.key === todayKey;
              return (
                <div
                  key={cell.key}
                  className={`calendar-cell${cell.inMonth ? "" : " is-outside"}${isToday ? " is-today" : ""}`}
                >
                  <span className="calendar-cell__date">{cell.date.getDate()}</span>
                  {hits.slice(0, 3).map((s) => (
                    <div className="calendar-cell__event" key={s.id} title={`${s.time} ${s.title}`}>
                      <small>{s.time}</small> {s.title}
                    </div>
                  ))}
                  {hits.length > 3 ? (
                    <small className="calendar-cell__more">+{hits.length - 3}</small>
                  ) : null}
                </div>
              );
            })}
          </div>
          {!monthHasSchedules ? (
            <p className="stats-empty">{labels.scheduleCalendarEmpty}</p>
          ) : null}
        </>
      )}
    </section>
  );

  function addSchedule(): void {
    window.pawpal.addSchedule({
      title: draftTitle.trim() || labels.untitledSchedule,
      time: draftTime,
      taskId: draftTaskId || null,
      daysOfWeek: []
    });
    setDraftTitle("");
  }
}

function HistorySection({
  statsHistory,
  todayStats,
  tasks,
  labels
}: {
  statsHistory: StatsHistory;
  todayStats: TodayStats;
  tasks: Task[];
  labels: SettingsCopy;
}): JSX.Element {
  const [dimension, setDimension] = useState<StatsDimension>("today");
  const [exportMsg, setExportMsg] = useState("");
  const merged = useMemo(
    () => ({ ...statsHistory, [todayStats.date]: todayStats }),
    [statsHistory, todayStats]
  );
  const dateKeys = useMemo(() => dimensionDateKeys(dimension), [dimension]);
  const days = useMemo(() => dateKeys.map((key) => merged[key]), [dateKeys, merged]);
  const singleDay = isSingleDayDimension(dimension);
  const totalFocus = days.reduce((sum, d) => sum + (d?.focusMs ?? 0), 0);
  const totalDistraction = days.reduce((sum, d) => sum + (d?.distractionMs ?? 0), 0);
  const hasData = totalFocus + totalDistraction > 0;

  // Merged hourly distribution across the selected days (used for single-day view).
  const hourly = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
    const focusByHour: Record<string, number> = {};
    const distractionByHour: Record<string, number> = {};
    for (const hour of hours) {
      focusByHour[hour] = days.reduce((sum, d) => sum + (d?.focusByHour[hour] ?? 0), 0);
      distractionByHour[hour] = days.reduce((sum, d) => sum + (d?.distractionByHour[hour] ?? 0), 0);
    }
    const maxHour = Math.max(
      1,
      ...hours.map((hour) => focusByHour[hour] + distractionByHour[hour])
    );
    return { hours, focusByHour, distractionByHour, maxHour };
  }, [days]);

  // Multi-day per-day totals (used for non-single-day views).
  const maxDay = Math.max(1, ...days.map((d) => (d?.focusMs ?? 0) + (d?.distractionMs ?? 0)));

  const taskTotals = useMemo<Array<[string, number]>>(() => {
    return [...BUILTIN_TASKS, ...tasks]
      .map((task): [string, number] => {
        const total = days.reduce(
          (acc, d) => mergeTaskStat(acc, d?.taskStats?.[task.id]),
          createEmptyTaskStat()
        );
        return [task.name, total.focusMs + total.activeMs];
      })
      .filter(([, ms]) => ms > 0)
      .sort((a, b) => b[1] - a[1]);
  }, [days, tasks]);

  const dimensionButtons: Array<{ id: StatsDimension; label: string }> = [
    { id: "today", label: labels.dimensionToday },
    { id: "yesterday", label: labels.dimensionYesterday },
    { id: "thisWeek", label: labels.dimensionThisWeek },
    { id: "thisMonth", label: labels.dimensionThisMonth },
    { id: "last7", label: labels.dimensionLast7 },
    { id: "last30", label: labels.dimensionLast30 }
  ];

  return (
    <section className="prefs__analytics" aria-label={labels.historySection}>
      <div className="prefs__group-head">
        <h3 className="stats-panel__title">{labels.historySection}</h3>
        <div className="range-toggle">
          {dimensionButtons.map((btn) => (
            <button
              type="button"
              key={btn.id}
              className={dimension === btn.id ? "is-active" : ""}
              onClick={() => setDimension(btn.id)}
            >
              {btn.label}
            </button>
          ))}
          <button
            type="button"
            className="range-toggle__export"
            onClick={async () => {
              const result = await window.pawpal.exportWorklog();
              if (result.canceled) return;
              setExportMsg(result.ok && result.path ? labels.exportDone(result.path) : labels.exportFailed);
            }}
          >
            {labels.exportWorklog}
          </button>
        </div>
      </div>
      {exportMsg ? <p className="export-msg">{exportMsg}</p> : null}

      <div className="analytics-summary">
        <div>
          <span>{labels.focusTime}</span>
          <strong>{formatStatsDuration(totalFocus, labels)}</strong>
        </div>
        <div>
          <span>{labels.distractionTime}</span>
          <strong>{formatStatsDuration(totalDistraction, labels)}</strong>
        </div>
      </div>

      {hasData ? (
        <>
          <div className="stats-panel stats-panel--wide">
            <div className="stats-panel__head">
              <h3 className="stats-panel__title">
                {singleDay ? labels.hourlyChartTitle : labels.focusDistribution}
              </h3>
              <span>{labels.distractionDistribution}</span>
            </div>
            {singleDay ? (
              <div className="hour-bars">
                {hourly.hours.map((hour) => {
                  const focus = hourly.focusByHour[hour];
                  const distraction = hourly.distractionByHour[hour];
                  const total = focus + distraction;
                  return (
                    <div
                      className="hour-bar"
                      key={hour}
                      title={`${formatHourLabel(hour)} ${formatStatsDuration(total, labels)}`}
                    >
                      <span>{formatHourLabel(hour)}</span>
                      <div className="hour-bar__track">
                        <i
                          className="hour-bar__focus"
                          style={{ width: `${(focus / hourly.maxHour) * 100}%` }}
                        />
                        <i
                          className="hour-bar__distraction"
                          style={{ width: `${(distraction / hourly.maxHour) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="hour-bars day-bars">
                {dateKeys.map((key, index) => {
                  const day = days[index];
                  const focus = day?.focusMs ?? 0;
                  const distraction = day?.distractionMs ?? 0;
                  const total = focus + distraction;
                  return (
                    <div
                      className="hour-bar"
                      key={key}
                      title={`${formatDayLabel(key)} ${formatStatsDuration(total, labels)}`}
                    >
                      <span>{formatDayLabel(key)}</span>
                      <div className="hour-bar__track">
                        <i className="hour-bar__focus" style={{ width: `${(focus / maxDay) * 100}%` }} />
                        <i
                          className="hour-bar__distraction"
                          style={{ width: `${(distraction / maxDay) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <StatsList title={labels.weeklyTaskTotals} entries={taskTotals} labels={labels} />
        </>
      ) : (
        <p className="stats-empty">{labels.noStatsYet}</p>
      )}
    </section>
  );
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
    if (!next.bigGoalTitle.trim()) {
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

      <ActivityComposition
        stats={stats}
        tasks={snapshot.settings.tasks}
        labels={labels}
      />

      <StatsOverview stats={stats} labels={labels} />

      <HistorySection
        statsHistory={snapshot.statsHistory}
        todayStats={stats}
        tasks={snapshot.settings.tasks}
        labels={labels}
      />

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
        <Row
          label={labels.enableFocusReminder}
          hint={labels.focusReminderHint}
          control={
            <ToggleControl
              checked={draft.focusReminderEnabled}
              onChange={(focusReminderEnabled) => updateDraft({ focusReminderEnabled })}
              ariaLabel={labels.enableFocusReminder}
            />
          }
        />
        <Row
          label={labels.focusReminderInterval}
          control={
            <NumberControl
              value={draft.focusReminderIntervalMinutes}
              min={1}
              max={180}
              unit={labels.minuteUnit}
              onChange={(focusReminderIntervalMinutes) => updateDraft({ focusReminderIntervalMinutes })}
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

      <TaskSection
        snapshot={snapshot}
        tasks={draft.tasks}
        stats={stats}
        labels={labels}
        now={now}
      />

      <ScheduleSection
        schedules={snapshot.schedules}
        tasks={draft.tasks}
        labels={labels}
      />

      {!window.pawpal.isPackaged && (
        <section className="prefs__group">
          <h2 className="prefs__group-title">{labels.testTools}</h2>
          <div className="test-tools">
            <DemoChip trigger="break" label={labels.demoBreak} />
            <DemoChip trigger="hydration" label={labels.demoWater} />
            <DemoChip trigger="focusWarning" label={labels.demoFocusWarning} />
            <DemoChip trigger="focusReminder" label={labels.demoFocusReminder} />
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

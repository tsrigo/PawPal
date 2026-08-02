import { writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, screen, Tray } from "electron";
import Store from "electron-store";
import {
  BUILTIN_TASKS,
  createEmptyStats,
  createEmptyTaskStat,
  DEFAULT_SETTINGS,
  TODAY_POMODORO_SLOT_COUNT,
  todayKey
} from "../shared/constants";
import { i18n, pick, resolveLanguage } from "../shared/i18n";
import { resolvePetAppearanceId } from "../shared/petAppearances";
import type {
  AppSnapshot,
  BlockingMode,
  DistractionStatus,
  DemoTrigger,
  FocusGoal,
  FocusGoalInput,
  FocusGoalSession,
  FocusPhase,
  PetFacing,
  PetState,
  PomodoroRecord,
  Schedule,
  Settings,
  StatsHistory,
  SpeechBubble,
  Task,
  TaskStat,
  TaskType,
  TodayStats
} from "../shared/types";
import {
  APP_NAME,
  BREAK_RUN_DURATION_MS,
  BREAK_RUN_TICK_MS,
  DISTRACTION_CHECK_INTERVAL_MS,
  DISTRACTION_WARNING_COOLDOWN_MS,
  IS_DEV,
  PET_WINDOW,
  PRELOAD_PATH,
  RENDERER_HTML_PATH,
  SETTINGS_WINDOW,
  STORE_NAME,
  TASK_IDLE_THRESHOLD_MS
} from "./config";
import {
  classifyDistraction,
  classifyTask,
  isPermissionError,
  readActiveWindow,
  supportsActiveWindowDetection
} from "./distraction";
import type { ActiveWindowInfo } from "./distraction";
import { createTrayImage } from "./trayIcon";

type PetPosition = {
  x: number;
  y: number;
};

type StoreSchema = {
  settings: Settings;
  stats: TodayStats;
  statsHistory: StatsHistory;
  goalDraft?: FocusGoalInput | null;
  goalSession?: FocusGoalSession | null;
  petPosition?: PetPosition;
  schedules: Schedule[];
};

app.setName(APP_NAME);

const store = new Store<StoreSchema>({
  name: STORE_NAME,
  defaults: {
    settings: DEFAULT_SETTINGS,
    stats: createEmptyStats(),
    statsHistory: {},
    goalDraft: null,
    goalSession: null,
    schedules: []
  }
});

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let petState: PetState = "idle";
let petFacing: PetFacing = "right";
let blockingMode: BlockingMode = null;
let focusActive = false;
let focusPhase: FocusPhase = null;
let focusCycleCurrent = 0;
let focusStartedAt: number | null = null;
let breakRunTimer: NodeJS.Timeout | null = null;
let breakRunCountdownTimer: NodeJS.Timeout | null = null;
let breakRunMovementTimer: NodeJS.Timeout | null = null;
let breakTimer: NodeJS.Timeout | null = null;
let hydrationTimer: NodeJS.Timeout | null = null;
let focusReminderTimer: NodeJS.Timeout | null = null;
let focusTimer: NodeJS.Timeout | null = null;
let distractionTimer: NodeJS.Timeout | null = null;
let distractionStartupTimer: NodeJS.Timeout | null = null;
let breakDueAt: number | null = null;
let hydrationDueAt: number | null = null;
let focusReminderDueAt: number | null = null;
let focusEndsAt: number | null = null;
let focusRemainingMs: number | null = null;
let focusSegmentStartedAt: number | null = null;
let distractionStartedAt: number | null = null;
let distractionWindow: ActiveWindowInfo | null = null;
let lastFocusWindow: ActiveWindowInfo | null = null;
let bubbleTimer: NodeJS.Timeout | null = null;
let dragTimer: NodeJS.Timeout | null = null;
let breakRunVelocity: PetPosition = { x: 0, y: 0 };
let breakRunFormatter: ((seconds: number) => string) | null = null;
let nextBreakRunTurnAt = 0;
let breakMutedToday = false;
let dragOffset: PetPosition = { x: 0, y: 0 };
let focusGoalInputOpen = false;
let focusGoalInlineOpen = false;
let focusGoalInlineTimer: NodeJS.Timeout | null = null;
let focusGoalInlineDeadlineAt: number | null = null;
const TASK_WINDOW_SAMPLE_INTERVAL_MS = 15_000;
const AUTO_SWITCH_PIN_MS = 300_000;
let activeTaskId: string | null = null;
let taskTimerStartedAt: number | null = null;
let taskLastFlushAt: number | null = null;
let taskSaveTimer: NodeJS.Timeout | null = null;
let lastTaskWindowKey: string | null = null;
let autoSwitchSuppressedUntil = 0;
let autoSwitchTimer: NodeJS.Timeout | null = null;
let leisureEndsAt: number | null = null;
let leisureTimer: NodeJS.Timeout | null = null;
let statsRolloverTimer: NodeJS.Timeout | null = null;
let scheduleCheckTimer: NodeJS.Timeout | null = null;
const SCHEDULE_CHECK_INTERVAL_MS = 30_000;
let triggeredScheduleId: string | null = null;
let distractionStatus: DistractionStatus = {
  state: "idle",
  activeApp: "",
  activeWindowTitle: "",
  matchedRule: null,
  lastCheckedAt: null,
  lastWarningAt: null,
  error: null
};

function getAllTasks(): Task[] {
  return [...BUILTIN_TASKS, ...getSettings().tasks];
}

function idleMs(): number {
  return powerMonitor.getSystemIdleTime() * 1000;
}

function flushTaskActiveMs(): void {
  if (!activeTaskId || taskLastFlushAt === null) return;
  const now = Date.now();
  const intervalStart = taskLastFlushAt;
  const elapsed = now - intervalStart;
  taskLastFlushAt = now;
  if (elapsed <= 0) return;
  let credited = elapsed;
  const idle = idleMs();
  if (idle >= TASK_IDLE_THRESHOLD_MS) {
    const idleStart = now - idle;
    credited = Math.max(0, Math.min(elapsed, idleStart - intervalStart));
  }
  if (credited <= 0) return;
  const windowKey = lastTaskWindowKey ?? "Unknown";
  updateStats((stats) => {
    const prev = stats.taskStats[activeTaskId!] ?? createEmptyTaskStat();
    return {
      ...stats,
      taskStats: {
        ...stats.taskStats,
        [activeTaskId!]: {
          ...prev,
          activeMs: prev.activeMs + credited,
          activeByWindow: addDuration(prev.activeByWindow, windowKey, credited)
        }
      }
    };
  });
}

async function sampleTaskWindow(): Promise<void> {
  if (!activeTaskId || taskLastFlushAt === null) return;
  if (supportsActiveWindowDetection()) {
    try {
      const active = await readActiveWindow();
      lastTaskWindowKey = windowStatsKey(active);
      maybeAutoSwitchTask(active);
    } catch {
      // keep previous window key
    }
  }
  flushTaskActiveMs();
}

function maybeAutoSwitchTask(active: ActiveWindowInfo): void {
  const settings = getSettings();
  if (!settings.autoTaskSwitchEnabled) return;
  if (focusActive) return;
  if (Date.now() < autoSwitchSuppressedUntil) return;
  const matchedId = classifyTask(active, [...settings.tasks, ...BUILTIN_TASKS], settings);
  if (!matchedId || matchedId === activeTaskId) return;
  activateTask(matchedId, "auto");
}

function scheduleAutoTaskSwitch(): void {
  if (autoSwitchTimer) {
    clearInterval(autoSwitchTimer);
    autoSwitchTimer = null;
  }
  if (!getSettings().autoTaskSwitchEnabled || !supportsActiveWindowDetection()) return;
  autoSwitchTimer = setInterval(() => {
    if (activeTaskId || focusActive) return;
    void readActiveWindow()
      .then(maybeAutoSwitchTask)
      .catch(() => {});
  }, TASK_WINDOW_SAMPLE_INTERVAL_MS);
}

function startTaskSampling(): void {
  if (taskSaveTimer) clearInterval(taskSaveTimer);
  lastTaskWindowKey = null;
  taskSaveTimer = setInterval(() => void sampleTaskWindow(), TASK_WINDOW_SAMPLE_INTERVAL_MS);
  void sampleTaskWindow();
}

function showTaskSwitcher(): void {
  const labels = text();
  const tasks = getAllTasks();
  const noTaskAction: import("../shared/types").BubbleAction = {
    id: "task:switch:null",
    label: labels.bubble.noTask,
    kind: !activeTaskId ? "primary" : "secondary"
  };
  const taskActions: import("../shared/types").BubbleAction[] = tasks.map((task) => ({
    id: `task:switch:${task.id}`,
    label: task.name,
    kind: activeTaskId === task.id ? "primary" : "secondary"
  }));
  showBubble({
    id: "task-switcher",
    message: labels.bubble.switchTask,
    actions: [noTaskAction, ...taskActions],
    autoDismissMs: 10_000
  });
}

function activateTask(id: string | null, source: "manual" | "auto" = "manual"): void {
  if (source === "manual") autoSwitchSuppressedUntil = Date.now() + AUTO_SWITCH_PIN_MS;
  clearLeisureTimer();
  if (activeTaskId && taskTimerStartedAt) {
    const sessionStartedAt = taskTimerStartedAt;
    const prevTaskId = activeTaskId;
    const prevTaskName = getAllTasks().find((t) => t.id === prevTaskId)?.name ?? "";
    flushTaskActiveMs();
    taskTimerStartedAt = null;
    taskLastFlushAt = null;
    if (prevTaskName) {
      const sessionMs = Date.now() - sessionStartedAt;
      const minutes = Math.round(sessionMs / 60_000);
      showBubble({
        id: "task-stopped",
        message: text().bubble.taskStopped(prevTaskName, minutes),
        autoDismissMs: 3000
      });
    }
  }
  if (taskSaveTimer) {
    clearInterval(taskSaveTimer);
    taskSaveTimer = null;
  }
  lastTaskWindowKey = null;

  activeTaskId = id;

  if (id) {
    const task = getAllTasks().find((t) => t.id === id);
    if (task && (task.type !== "deepWork" || !focusActive)) {
      taskTimerStartedAt = Date.now();
      taskLastFlushAt = taskTimerStartedAt;
      startTaskSampling();
      if (task.type === "leisure") {
        promptLeisureDuration();
      } else {
        showBubble({
          id: "task-started",
          message: text().bubble.taskStarted(task.name),
          autoDismissMs: 2000
        });
      }
    }
  }

  publishSnapshot();
  updateTrayMenu();
}

function clearLeisureTimer(): void {
  if (leisureTimer) {
    clearTimeout(leisureTimer);
    leisureTimer = null;
  }
  leisureEndsAt = null;
}

function promptLeisureDuration(): void {
  const labels = text();
  showBubble({
    id: "leisure-duration",
    message: labels.bubble.leisurePrompt,
    actions: [
      { id: "leisure:limit:15", label: `15${labels.settings.minuteUnit}`, kind: "primary" },
      { id: "leisure:limit:30", label: `30${labels.settings.minuteUnit}` },
      { id: "leisure:limit:60", label: `60${labels.settings.minuteUnit}` },
      { id: "leisure:limit:0", label: labels.bubble.leisureNoLimit, kind: "secondary" }
    ],
    autoDismissMs: 12_000
  });
}

function triggerLeisureTimeUp(): void {
  clearLeisureTimer();
  ensurePetWindowVisible();
  setPetState("sad");
  const labels = text();
  showBubble({
    id: "leisure-timeup",
    message: labels.bubble.leisureTimeUp,
    actions: [
      { id: "leisure:limit:15", label: labels.bubble.leisureExtend },
      { id: "task:switch:null", label: labels.bubble.leisureStop, kind: "primary" }
    ]
  });
  publishSnapshot();
}

function getSettings(): Settings {
  const stored = store.get("settings");
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    language: resolveLanguage(stored.language),
    petAppearanceId: resolvePetAppearanceId(stored.petAppearanceId)
  };
}

function text(): ReturnType<typeof i18n> {
  return i18n(getSettings().language);
}

function setSettings(next: Settings): void {
  const normalized = {
    ...next,
    language: resolveLanguage(next.language),
    petAppearanceId: resolvePetAppearanceId(next.petAppearanceId)
  };
  store.set("settings", normalized);
  sendToAll("settings:updated", normalized);
  settingsWindow?.setTitle(`${APP_NAME} ${text().menu.settings}`);
  scheduleReminderTimers();
  scheduleDistractionDetection();
  scheduleAutoTaskSwitch();
  updateTrayMenu();
}

function addCurrentAppToBlockedApps(): void {
  const appName = distractionStatus.activeApp.trim();
  if (!appName) return;
  const settings = getSettings();
  if (settings.distractionBlockedApps.some((entry) => entry.toLowerCase() === appName.toLowerCase())) {
    return;
  }
  setSettings({
    ...settings,
    distractionBlockedApps: [...settings.distractionBlockedApps, appName]
  });
}

function getStatsHistory(): StatsHistory {
  return store.get("statsHistory", {});
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeDurationMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, duration]) => [key, normalizeNumber(duration)] as const)
      .filter(([, duration]) => duration > 0)
  );
}

function normalizeTaskStat(value: unknown): TaskStat {
  const v = value && typeof value === "object" ? (value as Partial<TaskStat>) : {};
  return {
    focusMs: normalizeNumber(v.focusMs),
    distractionMs: normalizeNumber(v.distractionMs),
    activeMs: normalizeNumber(v.activeMs),
    focusByWindow: normalizeDurationMap(v.focusByWindow),
    distractionByWindow: normalizeDurationMap(v.distractionByWindow),
    activeByWindow: normalizeDurationMap(v.activeByWindow)
  };
}

function normalizeTaskStats(value: unknown): Record<string, TaskStat> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([id, stat]) => [id, normalizeTaskStat(stat)])
  );
}

function normalizePomodoros(value: unknown): PomodoroRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Partial<PomodoroRecord>;
    const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 160) : "";
    const completedAt =
      typeof candidate.completedAt === "number" && Number.isFinite(candidate.completedAt) && candidate.completedAt > 0
        ? candidate.completedAt
        : 0;
    if (!name || !completedAt) return [];
    return [{ name, completedAt }];
  });
}

function normalizeStats(stats: Partial<TodayStats> | undefined, date = todayKey()): TodayStats {
  const base = createEmptyStats(typeof stats?.date === "string" ? stats.date : date);
  const focusMs = normalizeNumber(stats?.focusMs) || normalizeNumber(stats?.focusMinutes) * 60_000;
  const distractionMs = normalizeNumber(stats?.distractionMs);
  return {
    ...base,
    ...stats,
    date: base.date,
    breaksTaken: normalizeNumber(stats?.breaksTaken),
    watersLogged: normalizeNumber(stats?.watersLogged),
    focusMs,
    distractionMs,
    focusMinutes: Math.round(focusMs / 60_000),
    focusWarnings: normalizeNumber(stats?.focusWarnings),
    focusByHour: normalizeDurationMap(stats?.focusByHour),
    distractionByHour: normalizeDurationMap(stats?.distractionByHour),
    focusByWindow: normalizeDurationMap(stats?.focusByWindow),
    distractionByWindow: normalizeDurationMap(stats?.distractionByWindow),
    goalsCompleted: normalizeNumber(stats?.goalsCompleted),
    smallGoalsCompleted: normalizeNumber(stats?.smallGoalsCompleted),
    pomodoros: normalizePomodoros(stats?.pomodoros),
    taskStats: normalizeTaskStats(stats?.taskStats)
  };
}

function isSameStats(left: TodayStats | undefined, right: TodayStats): boolean {
  return Boolean(left && JSON.stringify(normalizeStats(left)) === JSON.stringify(normalizeStats(right)));
}

function saveStatsToHistory(stats: TodayStats): void {
  if (!stats.date) return;
  const history = getStatsHistory();
  const normalized = normalizeStats(stats);
  if (isSameStats(history[normalized.date], normalized)) return;
  store.set("statsHistory", {
    ...history,
    [normalized.date]: normalized
  });
}

function getStats(): TodayStats {
  const today = todayKey();
  const stats = normalizeStats(store.get("stats", createEmptyStats()));
  if (stats.date !== today) {
    saveStatsToHistory(stats);
    const current = normalizeStats(getStatsHistory()[today] ?? createEmptyStats(today), today);
    store.set("stats", current);
    saveStatsToHistory(current);
    return current;
  }
  store.set("stats", stats);
  saveStatsToHistory(stats);
  return stats;
}

function updateStats(mutator: (stats: TodayStats) => TodayStats): void {
  const next = normalizeStats(mutator(getStats()));
  store.set("stats", next);
  saveStatsToHistory(next);
  sendToAll("stats:updated", next);
}

function resetTodayStats(): void {
  breakMutedToday = false;
  const reset = createEmptyStats();
  store.set("stats", reset);
  saveStatsToHistory(reset);
  sendToAll("stats:updated", reset);
}

function scheduleStatsRollover(): void {
  if (statsRolloverTimer) clearTimeout(statsRolloverTimer);
  const nextDay = new Date();
  nextDay.setHours(24, 0, 0, 50);
  statsRolloverTimer = setTimeout(() => {
    statsRolloverTimer = null;
    getStats();
    publishSnapshot();
    scheduleStatsRollover();
  }, Math.max(1_000, nextDay.getTime() - Date.now()));
}

function normalizeGoalTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function createGoal(title: string, now = Date.now()): FocusGoal {
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    title,
    status: "inProgress",
    createdAt: now,
    updatedAt: now
  };
}

function normalizeGoalInput(input: FocusGoalInput, settings = getSettings()): FocusGoalInput | null {
  const bigGoalTitle = normalizeGoalTitle(input.bigGoalTitle);
  const count = Math.max(1, settings.focusPomodoroCount);
  const smallGoalTitles = Array.from({ length: count }, (_, index) =>
    normalizeGoalTitle(input.smallGoalTitles[index] ?? "")
  );
  if (!bigGoalTitle) return null;
  return { bigGoalTitle, smallGoalTitles };
}

function getGoalDraft(): FocusGoalInput | null {
  return store.get("goalDraft", null) ?? null;
}

function setGoalDraft(next: FocusGoalInput | null): void {
  store.set("goalDraft", next);
}

function getGoalSession(): FocusGoalSession | null {
  return store.get("goalSession", null) ?? null;
}

function setGoalSession(next: FocusGoalSession | null): void {
  store.set("goalSession", next);
}

function currentGoalText(): string | null {
  const session = getGoalSession();
  if (!session) return null;
  const currentSmallGoal = session.smallGoals[session.currentSmallGoalIndex];
  return currentSmallGoal?.title || session.bigGoal.title || null;
}

function currentPomodoroName(slotNumber: number): string {
  const goal = currentGoalText();
  if (goal) return goal;
  const task = activeTaskId ? getAllTasks().find((entry) => entry.id === activeTaskId) : null;
  if (task?.name) return task.name;
  return text().settings.pomodoroDefault(slotNumber);
}

function pomodoroEncouragement(completedCount: number): string {
  const labels = text().settings;
  if (completedCount === TODAY_POMODORO_SLOT_COUNT - 1) return labels.pomodoroAlmost;
  if (completedCount >= TODAY_POMODORO_SLOT_COUNT) return labels.pomodoroAllDone;
  if (completedCount === 1) return labels.pomodoroFirstDone;
  return labels.pomodoroProgress(completedCount, TODAY_POMODORO_SLOT_COUNT);
}

function recordCompletedPomodoro(): number {
  const current = getStats();
  const name = currentPomodoroName(current.pomodoros.length + 1);
  const record: PomodoroRecord = { name, completedAt: Date.now() };
  let completedCount = current.pomodoros.length;
  updateStats((stats) => {
    const pomodoros = [...stats.pomodoros, record];
    completedCount = pomodoros.length;
    return { ...stats, pomodoros };
  });
  return completedCount;
}

function startGoalSession(input: FocusGoalInput): FocusGoalSession | null {
  const normalized = normalizeGoalInput(input);
  if (!normalized) return null;
  const now = Date.now();
  const session: FocusGoalSession = {
    id: `goal-session-${now}`,
    bigGoal: createGoal(normalized.bigGoalTitle, now),
    smallGoals: normalized.smallGoalTitles.map((title) => createGoal(title || normalized.bigGoalTitle, now)),
    currentSmallGoalIndex: 0,
    startedAt: now
  };
  setGoalDraft(normalized);
  setGoalSession(session);
  focusGoalInputOpen = false;
  return session;
}

function markGoalStatus(scope: "big" | "small", status: "completed" | "inProgress"): void {
  const session = getGoalSession();
  if (!session) return;
  const now = Date.now();
  if (scope === "big") {
    const wasCompleted = session.bigGoal.status === "completed";
    const nextSession: FocusGoalSession = {
      ...session,
      bigGoal: {
        ...session.bigGoal,
        status,
        updatedAt: now,
        completedAt: status === "completed" ? now : undefined
      },
      completedAt: status === "completed" ? now : session.completedAt
    };
    setGoalSession(nextSession);
    if (status === "completed" && !wasCompleted) {
      updateStats((stats) => ({ ...stats, goalsCompleted: stats.goalsCompleted + 1 }));
      setGoalDraft(null);
    }
    return;
  }

  const index = session.currentSmallGoalIndex;
  const target = session.smallGoals[index];
  if (!target) return;
  const wasCompleted = target.status === "completed";
  const nextSmallGoals = [...session.smallGoals];
  nextSmallGoals[index] = {
    ...target,
    status,
    updatedAt: now,
    completedAt: status === "completed" ? now : undefined
  };
  setGoalSession({ ...session, smallGoals: nextSmallGoals });
  if (status === "completed" && !wasCompleted) {
    updateStats((stats) => ({ ...stats, smallGoalsCompleted: stats.smallGoalsCompleted + 1 }));
  }
}

const KNOWN_BROWSERS = ["msedge", "chrome", "firefox", "opera", "brave", "vivaldi", "arc", "safari", "iexplore"];

function browserSiteLabel(title: string): string {
  const label = title.replace(/\s+[-—–]\s+[^-—–]+$/u, "").trim() || title;
  const lower = label.toLowerCase();
  const titleLower = title.toLowerCase();
  const keyword = getSettings()
    .distractionBlockedKeywords.map((k) => k.trim())
    .filter(Boolean)
    .find((k) => lower.includes(k.toLowerCase()) || titleLower.includes(k.toLowerCase()));
  return keyword ?? label;
}

function windowStatsKey(active: ActiveWindowInfo | null): string {
  const appName = (active?.appName ?? "").trim();
  const title = (active?.windowTitle ?? "").trim();
  if (!appName && !title) return "Unknown";
  const appLower = appName.toLowerCase();
  if (KNOWN_BROWSERS.some((b) => appLower.includes(b)) && title) return browserSiteLabel(title);
  return appName || title || "Unknown";
}

function addDuration(target: Record<string, number>, key: string, durationMs: number): Record<string, number> {
  if (durationMs <= 0) return target;
  return {
    ...target,
    [key]: (target[key] ?? 0) + durationMs
  };
}

function nextHourBoundary(timestamp: number): number {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date.getTime();
}

function addHourlyDuration(
  target: Record<string, number>,
  startedAt: number,
  endedAt: number
): Record<string, number> {
  let next = { ...target };
  let cursor = startedAt;
  while (cursor < endedAt) {
    const segmentEnd = Math.min(endedAt, nextHourBoundary(cursor));
    const hour = String(new Date(cursor).getHours()).padStart(2, "0");
    next = addDuration(next, hour, segmentEnd - cursor);
    cursor = segmentEnd;
  }
  return next;
}

function recordStatsSpan(
  kind: "focus" | "distraction",
  startedAt: number | null,
  endedAt: number,
  active: ActiveWindowInfo | null
): void {
  if (!startedAt || endedAt <= startedAt) return;
  const durationMs = endedAt - startedAt;
  const windowKey = windowStatsKey(active);
  updateStats((stats) => {
    const taskId = activeTaskId;
    const prevTask = taskId ? (stats.taskStats[taskId] ?? createEmptyTaskStat()) : null;
    if (kind === "focus") {
      const focusMs = stats.focusMs + durationMs;
      return {
        ...stats,
        focusMs,
        focusMinutes: Math.round(focusMs / 60_000),
        focusByHour: addHourlyDuration(stats.focusByHour, startedAt, endedAt),
        focusByWindow: addDuration(stats.focusByWindow, windowKey, durationMs),
        taskStats: taskId && prevTask ? {
          ...stats.taskStats,
          [taskId]: {
            ...prevTask,
            focusMs: prevTask.focusMs + durationMs,
            focusByWindow: addDuration(prevTask.focusByWindow, windowKey, durationMs)
          }
        } : stats.taskStats
      };
    }
    return {
      ...stats,
      distractionMs: stats.distractionMs + durationMs,
      distractionByHour: addHourlyDuration(stats.distractionByHour, startedAt, endedAt),
      distractionByWindow: addDuration(stats.distractionByWindow, windowKey, durationMs),
      taskStats: taskId && prevTask ? {
        ...stats.taskStats,
        [taskId]: {
          ...prevTask,
          distractionMs: prevTask.distractionMs + durationMs,
          distractionByWindow: addDuration(prevTask.distractionByWindow, windowKey, durationMs)
        }
      } : stats.taskStats
    };
  });
}

function snapshot(): AppSnapshot {
  return {
    settings: getSettings(),
    stats: getStats(),
    statsHistory: getStatsHistory(),
    timers: {
      breakDueAt,
      hydrationDueAt,
      focusReminderDueAt,
      focusEndsAt,
      focusRemainingMs,
      distractionStartedAt
    },
    distraction: distractionStatus,
    petState,
    petFacing,
    blockingMode,
    dogVisible: Boolean(petWindow?.isVisible()),
    focusActive,
    focusPhase,
    focusCycleCurrent,
    goalSession: getGoalSession(),
    goalDraft: getGoalDraft(),
    focusGoalInputOpen,
    focusGoalInlineOpen,
    focusGoalInlineDeadlineAt,
    activeTaskId,
    taskTimerStartedAt: activeTaskId ? taskTimerStartedAt : null,
    leisureEndsAt,
    schedules: store.get("schedules")
  };
}

function sendToPet<T>(channel: string, payload?: T): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send(channel, payload);
}

function sendToAll<T>(channel: string, payload?: T): void {
  sendToPet(channel, payload);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

function publishSnapshot(): void {
  sendToAll("app:snapshot", snapshot());
}

function setPetState(next: PetState): void {
  petState = next;
  sendToAll("pet:set-state", next);
}

function setPetFacing(next: PetFacing): void {
  if (petFacing === next) return;
  petFacing = next;
  publishSnapshot();
}

function showBubble(bubble: SpeechBubble): void {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  setPetWindowHeight(PET_WINDOW.height);
  sendToPet("pet:show-bubble", bubble);
  if (bubble.autoDismissMs) {
    bubbleTimer = setTimeout(() => hideBubble(), bubble.autoDismissMs);
  }
}

function hideBubble(): void {
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  sendToPet("pet:hide-bubble");
  setPetWindowHeight(PET_WINDOW.compactHeight);
}

function rendererUrl(route: "pet" | "settings"): string {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return `${devServer}#${route}`;
  return RENDERER_HTML_PATH;
}

function loadRenderer(win: BrowserWindow, route: "pet" | "settings"): void {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void win.loadURL(rendererUrl(route));
    return;
  }
  void win.loadFile(rendererUrl(route), { hash: route });
}

function clampBoundsToWorkArea(bounds: Electron.Rectangle): Electron.Rectangle {
  const center = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  };
  const workArea = screen.getDisplayNearestPoint(center).workArea;
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height)
  };
}

function initialPetBounds(): Electron.Rectangle {
  const workArea = screen.getPrimaryDisplay().workArea;
  const stored = store.get("petPosition");
  const petStageWidth = 220;
  const petCenterOffset = PET_WINDOW.width - petStageWidth / 2;
  const previousPetCenterOffset = petStageWidth / 2;
  const fallback = {
    width: PET_WINDOW.width,
    height: PET_WINDOW.compactHeight,
    x: Math.round(workArea.x + workArea.width / 2 - petCenterOffset),
    y: workArea.y + workArea.height - PET_WINDOW.compactHeight
  };

  if (!stored) return fallback;
  // The previous layout centered the dog in a 220px window. Preserve the dog's
  // screen position after moving it to the right side of the wider overlay window.
  const restoredX = stored.x - (petCenterOffset - previousPetCenterOffset);
  return clampBoundsToWorkArea({
    ...fallback,
    x: restoredX,
    y: stored.y
  });
}

function persistPetPosition(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  store.set("petPosition", { x: bounds.x, y: bounds.y });
}

function setPetWindowHeight(height: number): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const current = petWindow.getBounds();
  const workArea = screen.getDisplayNearestPoint({
    x: current.x + Math.round(current.width / 2),
    y: current.y + Math.round(current.height / 2)
  }).workArea;
  const safeHeight = Math.min(Math.max(Math.round(height), PET_WINDOW.compactHeight), workArea.height);
  if (current.height === safeHeight) return;
  const next = clampBoundsToWorkArea({
    ...current,
    height: safeHeight,
    y: current.y + current.height - safeHeight
  });
  petWindow.setBounds(next);
}

function fitPetWindowToBubble(contentHeight: number): void {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
    setPetWindowHeight(PET_WINDOW.compactHeight);
    return;
  }
  setPetWindowHeight(
    Math.max(
      PET_WINDOW.height,
      PET_WINDOW.bubbleBottom + Math.ceil(contentHeight) + PET_WINDOW.bubbleMargin
    )
  );
}

function createPetWindow(): void {
  const bounds = initialPetBounds();
  petWindow = new BrowserWindow({
    width: PET_WINDOW.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: !IS_DEV
    }
  });

  petWindow.setAlwaysOnTop(true, "floating");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadRenderer(petWindow, "pet");
  petWindow.once("ready-to-show", () => {
    petWindow?.showInactive();
    updateTrayMenu();
    publishSnapshot();
  });
  petWindow.on("show", () => {
    updateTrayMenu();
    publishSnapshot();
  });
  petWindow.on("hide", () => {
    updateTrayMenu();
    publishSnapshot();
  });
  petWindow.on("closed", () => {
    petWindow = null;
    updateTrayMenu();
    publishSnapshot();
  });
}

function ensurePetWindowVisible(): void {
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  if (petWindow && !petWindow.isVisible()) {
    petWindow.showInactive();
    petWindow.setAlwaysOnTop(true, "floating");
  }
  updateTrayMenu();
  publishSnapshot();
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    publishSnapshot();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WINDOW.width,
    height: SETTINGS_WINDOW.height,
    title: `${APP_NAME} ${text().menu.settings}`,
    resizable: true,
    minWidth: SETTINGS_WINDOW.width,
    maxWidth: SETTINGS_WINDOW.width,
    minHeight: 400,
    show: false,
    backgroundColor: "#faf6ee",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: !IS_DEV
    }
  });

  loadRenderer(settingsWindow, "settings");
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
    publishSnapshot();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

const INLINE_GOAL_AUTO_SKIP_MS = 10_000;

function clearFocusGoalInlineState(): void {
  if (focusGoalInlineTimer) {
    clearTimeout(focusGoalInlineTimer);
    focusGoalInlineTimer = null;
  }
  focusGoalInlineOpen = false;
  focusGoalInlineDeadlineAt = null;
  setPetWindowHeight(PET_WINDOW.compactHeight);
}

function requestFocusGoalInput(): void {
  if (focusActive || blockingMode) return;
  ensurePetWindowVisible();
  clearFocusGoalInlineState();
  focusGoalInlineOpen = true;
  focusGoalInlineDeadlineAt = Date.now() + INLINE_GOAL_AUTO_SKIP_MS;
  // This prompt is rendered from snapshot state rather than showBubble(), so
  // reserve its expanded area before React paints it.
  setPetWindowHeight(PET_WINDOW.height);
  focusGoalInlineTimer = setTimeout(() => {
    // Auto-skip: start focus without a goal after 10s of no input.
    focusGoalInlineOpen = false;
    focusGoalInlineDeadlineAt = null;
    focusGoalInlineTimer = null;
    publishSnapshot();
    startFocusMode();
  }, INLINE_GOAL_AUTO_SKIP_MS);
  publishSnapshot();
}

function submitInlineGoal(title: string): void {
  if (!focusGoalInlineOpen) return;
  clearFocusGoalInlineState();
  publishSnapshot();
  const trimmed = title.trim();
  if (trimmed) {
    startFocusMode({ bigGoalTitle: trimmed, smallGoalTitles: [] });
  } else {
    startFocusMode();
  }
}

function skipInlineGoal(): void {
  if (!focusGoalInlineOpen) return;
  clearFocusGoalInlineState();
  publishSnapshot();
  startFocusMode();
}

function beginFocusEntry(): void {
  if (focusActive || blockingMode) return;
  if (activeTaskId) {
    startFocusMode();
    return;
  }
  requestFocusGoalInput();
}

function createTray(): void {
  tray = new Tray(createTrayImage());
  tray.setToolTip(APP_NAME);
  tray.on("click", () => {
    tray?.popUpContextMenu();
  });
  updateTrayMenu();
}

function actionMenuItems(): Electron.MenuItemConstructorOptions[] {
  const dogVisible = Boolean(petWindow?.isVisible());
  const labels = text().menu;
  return [
    {
      label: dogVisible ? labels.hideDog : labels.showDog,
      click: () => {
        if (!petWindow) createPetWindow();
        if (!petWindow) return;
        if (petWindow.isVisible()) petWindow.hide();
        else {
          petWindow.showInactive();
          petWindow.setAlwaysOnTop(true, "floating");
        }
        updateTrayMenu();
        sendToAll("app:snapshot", snapshot());
      }
    },
    {
      label: focusActive ? labels.stopFocusMode : labels.startFocusMode,
      click: () => {
        if (focusActive) stopFocusMode(true);
        else beginFocusEntry();
      }
    },
    ...(app.isPackaged
      ? []
      : [
          { type: "separator" as const },
          { label: labels.demoBreakReminder, click: () => triggerDemo("break") },
          { label: labels.demoHydrationReminder, click: () => triggerDemo("hydration") },
          { label: labels.demoFocusWarning, click: () => triggerDemo("focusWarning") },
          { label: labels.demoHappyReaction, click: () => triggerDemo("happy") }
        ]),
    { type: "separator" },
    {
      label: text().menu.switchTask,
      submenu: [
        {
          label: text().menu.noTask,
          type: "radio" as const,
          checked: !activeTaskId,
          click: () => activateTask(null)
        },
        ...getAllTasks().map((task) => ({
          label: (activeTaskId === task.id ? "• " : "") + task.name,
          type: "radio" as const,
          checked: activeTaskId === task.id,
          click: () => activateTask(task.id)
        }))
      ]
    },
    { label: labels.settings, click: createSettingsWindow }
  ];
}

function updateApplicationMenu(): void {
  const labels = text().menu;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        ...actionMenuItems(),
        { type: "separator" },
        { role: "quit", label: labels.quit }
      ]
    },
    { role: "editMenu" },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateTrayMenu(): void {
  updateApplicationMenu();
  if (!tray) return;
  const labels = text().menu;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: APP_NAME, enabled: false },
    { type: "separator" },
    ...actionMenuItems(),
    { type: "separator" },
    {
      label: labels.quit,
      click: () => {
        app.quit();
      }
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function showPetContextMenu(): void {
  const labels = text().menu;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: labels.settings, click: createSettingsWindow },
    {
      label: focusActive ? labels.stopFocusMode : labels.startFocusMode,
      click: () => {
        if (focusActive) stopFocusMode(false);
        else beginFocusEntry();
      }
    },
    ...(app.isPackaged
      ? []
      : [
          { type: "separator" as const },
          { label: labels.demoBreakReminder, click: () => triggerDemo("break") },
          { label: labels.demoHydrationReminder, click: () => triggerDemo("hydration") },
          { label: labels.demoFocusWarning, click: () => triggerDemo("focusWarning") },
          { label: labels.demoHappyReaction, click: () => triggerDemo("happy") }
        ]),
    { type: "separator" },
    {
      label: labels.hideDog,
      click: () => {
        petWindow?.hide();
        updateTrayMenu();
        sendToAll("app:snapshot", snapshot());
      }
    }
  ];

  Menu.buildFromTemplate(template).popup({ window: petWindow ?? undefined });
}

function movePetWithCursor(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const current = petWindow.getBounds();
  const bounds = clampBoundsToWorkArea({
    width: PET_WINDOW.width,
    height: current.height,
    x: cursor.x - dragOffset.x,
    y: cursor.y - dragOffset.y
  });
  petWindow.setBounds(bounds);
}

function startPetDrag(offset: { offsetX: number; offsetY: number }): void {
  if (blockingMode === "breakRun" || !petWindow || petWindow.isDestroyed()) return;
  dragOffset = {
    x: Math.min(Math.max(Math.round(offset.offsetX), 0), PET_WINDOW.width),
    y: Math.min(Math.max(Math.round(offset.offsetY), 0), petWindow.getBounds().height)
  };
  if (dragTimer) clearInterval(dragTimer);
  movePetWithCursor();
  dragTimer = setInterval(movePetWithCursor, 16);
}

function stopPetDrag(): void {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  persistPetPosition();
  sendToAll("app:snapshot", snapshot());
}

function clearBreakRunTimers(): void {
  if (breakRunTimer) {
    clearTimeout(breakRunTimer);
    breakRunTimer = null;
  }
  if (breakRunCountdownTimer) {
    clearInterval(breakRunCountdownTimer);
    breakRunCountdownTimer = null;
  }
  if (breakRunMovementTimer) {
    clearInterval(breakRunMovementTimer);
    breakRunMovementTimer = null;
  }
}

function showBreakRunCountdown(endsAt: number): void {
  const labels = text();
  const remainingSeconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const formatter = breakRunFormatter ?? pick(labels.bubble.breakRun);
  showBubble({
    id: "break-run",
    message: formatter(remainingSeconds),
    actions: [{ id: "break-run:done", label: labels.actions.breakRunDone, kind: "primary" }]
  });
}

function chooseBreakRunVelocity(): PetPosition {
  const speed = 3.5 + Math.random() * 2.9;
  const angle = Math.random() * Math.PI * 2;
  return {
    x: Math.cos(angle) * speed,
    y: Math.sin(angle) * speed
  };
}

function movePetForBreakRun(): void {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;

  const bounds = petWindow.getBounds();
  const workArea = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  }).workArea;
  const now = Date.now();
  const minX = workArea.x + 8;
  const maxX = workArea.x + workArea.width - PET_WINDOW.width - 8;
  const minY = workArea.y + 8;
  const maxY = workArea.y + workArea.height - bounds.height - 8;

  if (now >= nextBreakRunTurnAt && Math.random() < 0.45) {
    breakRunVelocity = chooseBreakRunVelocity();
  }

  let nextX = bounds.x + breakRunVelocity.x;
  let nextY = bounds.y + breakRunVelocity.y;

  if (nextX <= minX) {
    nextX = minX;
    breakRunVelocity.x = Math.abs(breakRunVelocity.x);
  }
  if (nextX >= maxX) {
    nextX = maxX;
    breakRunVelocity.x = -Math.abs(breakRunVelocity.x);
  }
  if (nextY <= minY) {
    nextY = minY;
    breakRunVelocity.y = Math.abs(breakRunVelocity.y);
  }
  if (nextY >= maxY) {
    nextY = maxY;
    breakRunVelocity.y = -Math.abs(breakRunVelocity.y);
  }

  if (now >= nextBreakRunTurnAt) {
    nextBreakRunTurnAt = now + 350 + Math.round(Math.random() * 850);
  }

  setPetFacing(breakRunVelocity.x >= 0 ? "right" : "left");
  petWindow.setBounds({
    ...bounds,
    x: Math.round(nextX),
    y: Math.round(nextY)
  });
}

function finishBreakRun(): void {
  clearBreakRunTimers();
  breakRunFormatter = null;
  blockingMode = null;
  hideBubble();
  showBubble({ id: "break-run-complete", message: pick(text().bubble.breakRunComplete), autoDismissMs: 2200 });
  setPetState("breakDone");
  setTimeout(() => {
    if (!blockingMode && !focusActive) {
      hideBubble();
      setPetState("idle");
      scheduleReminderTimers();
    }
  }, 2300);
  publishSnapshot();
}

function startBreakRun(): void {
  ensurePetWindowVisible();
  clearBreakRunTimers();
  blockingMode = "breakRun";
  breakDueAt = null;
  breakRunFormatter = pick(text().bubble.breakRun);
  breakRunVelocity = chooseBreakRunVelocity();
  nextBreakRunTurnAt = Date.now();
  setPetState("breakRunning");
  setPetFacing(breakRunVelocity.x >= 0 ? "right" : "left");
  const endsAt = Date.now() + BREAK_RUN_DURATION_MS;
  showBreakRunCountdown(endsAt);
  breakRunCountdownTimer = setInterval(() => showBreakRunCountdown(endsAt), 1000);
  breakRunMovementTimer = setInterval(movePetForBreakRun, BREAK_RUN_TICK_MS);
  breakRunTimer = setTimeout(finishBreakRun, BREAK_RUN_DURATION_MS);
  publishSnapshot();
}

function scheduleReminderTimers(): void {
  if (breakTimer) clearTimeout(breakTimer);
  if (hydrationTimer) clearTimeout(hydrationTimer);
  breakDueAt = null;
  hydrationDueAt = null;

  const settings = getSettings();
  if (settings.breakReminderEnabled && !breakMutedToday) {
    breakDueAt = Date.now() + settings.breakIntervalMinutes * 60 * 1000;
    breakTimer = setTimeout(
      () => triggerBreakReminder(false),
      settings.breakIntervalMinutes * 60 * 1000
    );
  }
  if (settings.hydrationReminderEnabled) {
    hydrationDueAt = Date.now() + settings.hydrationIntervalMinutes * 60 * 1000;
    hydrationTimer = setTimeout(
      () => triggerHydrationReminder(false),
      settings.hydrationIntervalMinutes * 60 * 1000
    );
  }
  publishSnapshot();
  scheduleFocusReminder();
}

function setDistractionStatus(partial: Partial<DistractionStatus>): void {
  distractionStatus = { ...distractionStatus, ...partial };
  publishSnapshot();
}

async function checkDistractionNow(): Promise<void> {
  const settings = getSettings();
  if (!settings.distractionDetectionEnabled) return;

  try {
    const active = await readActiveWindow();
    const matchedRule = classifyDistraction(active, settings);
    const now = Date.now();

    setDistractionStatus({
      state: "watching",
      activeApp: active.appName,
      activeWindowTitle: active.windowTitle,
      matchedRule,
      lastCheckedAt: now,
      error: null
    });

    if (!focusActive || focusPhase !== "focus" || blockingMode) return;
    if (!matchedRule) {
      lastFocusWindow = active;
      return;
    }
    if (
      distractionStatus.lastWarningAt &&
      now - distractionStatus.lastWarningAt < DISTRACTION_WARNING_COOLDOWN_MS
    ) {
      return;
    }

    pauseFocusForDistraction(active, matchedRule.replace(/^(app|keyword):/, ""));
  } catch (error) {
    setDistractionStatus({
      state: isPermissionError(error) ? "permission-needed" : "error",
      error: error instanceof Error ? error.message : String(error),
      lastCheckedAt: Date.now()
    });
  }
}

function scheduleDistractionDetection(): void {
  if (distractionTimer) {
    clearInterval(distractionTimer);
    distractionTimer = null;
  }
  if (distractionStartupTimer) {
    clearTimeout(distractionStartupTimer);
    distractionStartupTimer = null;
  }

  const settings = getSettings();
  if (!settings.distractionDetectionEnabled || (focusActive && focusPhase !== "focus")) {
    setDistractionStatus({
      state: "idle",
      matchedRule: null,
      error: null
    });
    return;
  }

  const detectionSupported = supportsActiveWindowDetection();

  setDistractionStatus({
    state: detectionSupported ? "watching" : "unsupported",
    error: detectionSupported ? null : text().system.unsupportedDistraction
  });

  if (!detectionSupported) return;

  const firstCheckDelay = focusActive && focusPhase === "focus" ? Math.max(0, settings.distractionGraceSeconds * 1000) : 0;
  distractionStartupTimer = setTimeout(() => {
    void checkDistractionNow();
    distractionTimer = setInterval(() => void checkDistractionNow(), DISTRACTION_CHECK_INTERVAL_MS);
  }, firstCheckDelay);
}

function resumeLongTermState(): void {
  blockingMode = null;
  hideBubble();
  if (focusActive) {
    setPetState("focusGuard");
    sendToAll("app:snapshot", snapshot());
    return;
  }
  setPetState("idle");
  sendToAll("app:snapshot", snapshot());
}

function happyFeedback(message: string | null = pick(text().bubble.woof), after?: () => void): void {
  if (blockingMode) return;
  const returnState = focusActive ? "focusGuard" : "idle";
  setPetState("happy");
  if (message) {
    showBubble({ id: "happy", message, autoDismissMs: 1800 });
  }
  setTimeout(() => {
    hideBubble();
    setPetState(returnState);
    after?.();
  }, 1900);
}

function triggerBreakReminder(fromDemo: boolean): void {
  if (blockingMode === "focusWarning" || blockingMode === "breakRun") return;
  if (!fromDemo && (focusActive || breakMutedToday)) {
    scheduleReminderTimers();
    return;
  }
  ensurePetWindowVisible();
  blockingMode = "break";
  breakDueAt = null;
  publishSnapshot();
  setPetState("breakPrompt");
  const labels = text();
  showBubble({
    id: "break",
    message: pick(labels.bubble.breakReminder),
    actions: [
      { id: "break:done", label: labels.actions.breakDone, kind: "primary" },
      { id: "break:snooze", label: labels.actions.breakSnooze },
      { id: "break:mute", label: labels.actions.breakMute, kind: "danger" }
    ]
  });
}

function triggerHydrationReminder(fromDemo: boolean): void {
  if (blockingMode || (!fromDemo && focusActive)) {
    scheduleReminderTimers();
    return;
  }
  ensurePetWindowVisible();
  blockingMode = "hydration";
  hydrationDueAt = null;
  publishSnapshot();
  setPetState("hydrationPrompt");
  const labels = text();
  showBubble({
    id: "hydration",
    message: pick(labels.bubble.hydrationReminder),
    actions: [
      { id: "hydration:done", label: labels.actions.hydrationDone, kind: "primary" },
      { id: "hydration:snooze", label: labels.actions.hydrationSnooze }
    ]
  });
}

function scheduleFocusReminder(): void {
  if (focusReminderTimer) {
    clearTimeout(focusReminderTimer);
    focusReminderTimer = null;
  }
  focusReminderDueAt = null;
  const settings = getSettings();
  if (!settings.focusReminderEnabled || focusActive || blockingMode) return;
  const ms = settings.focusReminderIntervalMinutes * 60 * 1000;
  focusReminderDueAt = Date.now() + ms;
  focusReminderTimer = setTimeout(() => triggerFocusReminder(false), ms);
  publishSnapshot();
}

function triggerFocusReminder(fromDemo: boolean): void {
  focusReminderTimer = null;
  focusReminderDueAt = null;
  if (blockingMode || (!fromDemo && focusActive)) {
    scheduleFocusReminder();
    return;
  }
  ensurePetWindowVisible();
  const settings = getSettings();
  const labels = text();
  // Keep the reminder recurring at the configured interval. Previously, ignoring
  // the bubble or letting it auto-dismiss permanently stopped future reminders.
  if (!fromDemo) scheduleFocusReminder();
  // Gentle, non-blocking reminder: does not set blockingMode so it won't trap the user.
  publishSnapshot();
  showBubble({
    id: "focus-reminder",
    message: labels.bubble.focusReminder(settings.focusReminderIntervalMinutes),
    actions: [
      { id: "focus:reminder-start", label: labels.actions.focusReminderStart, kind: "primary" },
      { id: "focus:reminder-snooze", label: labels.actions.focusReminderSnooze }
    ],
    autoDismissMs: 20_000
  });
}

// --- Schedules ---

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function addSchedule(data: { title: string; time: string; taskId: string | null; daysOfWeek: number[] }): Schedule {
  const schedule: Schedule = {
    id: generateId("sch"),
    title: data.title.trim() || text().settings.untitledSchedule,
    time: data.time,
    taskId: data.taskId,
    daysOfWeek: data.daysOfWeek,
    enabled: true
  };
  const schedules = store.get("schedules");
  store.set("schedules", [...schedules, schedule]);
  publishSnapshot();
  return schedule;
}

function updateSchedule(id: string, partial: Partial<Omit<Schedule, "id">>): void {
  const schedules = store.get("schedules");
  const next = schedules.map((item) => (item.id === id ? { ...item, ...partial } : item));
  store.set("schedules", next);
  publishSnapshot();
}

function removeSchedule(id: string): void {
  const schedules = store.get("schedules");
  store.set("schedules", schedules.filter((item) => item.id !== id));
  publishSnapshot();
}

function startScheduleCheck(): void {
  if (scheduleCheckTimer) clearInterval(scheduleCheckTimer);
  // Run an initial check shortly after launch so a missed slot within the current minute fires once.
  checkSchedules();
  scheduleCheckTimer = setInterval(checkSchedules, SCHEDULE_CHECK_INTERVAL_MS);
}

function checkSchedules(): void {
  const schedules = store.get("schedules");
  if (!schedules.length) return;
  const now = new Date();
  const today = todayKey(now);
  const dayOfWeek = now.getDay();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const nowHM = `${hh}:${mm}`;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (schedule.lastTriggeredDate === today) continue;
    if (schedule.time !== nowHM) continue;
    const matchesDay = schedule.daysOfWeek.length === 0 || schedule.daysOfWeek.includes(dayOfWeek);
    if (!matchesDay) continue;
    triggerSchedule(schedule, today);
    break; // one trigger per tick is enough
  }
}

function triggerSchedule(schedule: Schedule, today: string): void {
  // Mark triggered so it won't fire again today, even before the user responds.
  updateSchedule(schedule.id, { lastTriggeredDate: today });
  if (focusActive || blockingMode) return; // don't interrupt an active session
  ensurePetWindowVisible();
  triggeredScheduleId = schedule.id;
  publishSnapshot();
  const labels = text();
  showBubble({
    id: `schedule:${schedule.id}`,
    message: labels.bubble.schedulePrompt(schedule.title),
    actions: [
      { id: `schedule:start:${schedule.id}`, label: labels.actions.scheduleStart, kind: "primary" },
      { id: `schedule:skip:${schedule.id}`, label: labels.actions.scheduleSkip }
    ],
    autoDismissMs: 60_000
  });
}

function handleScheduleAction(actionId: string, kind: "start" | "skip"): void {
  const id = actionId.slice(`schedule:${kind}:`.length);
  hideBubble();
  triggeredScheduleId = null;
  if (kind === "start") {
    const schedule = store.get("schedules").find((item) => item.id === id);
    if (!schedule) return;
    if (schedule.taskId) activateTask(schedule.taskId, "manual");
    startFocusMode(); // activeTaskId is set, so goal entry is skipped and time is attributed to the task
  }
  publishSnapshot();
}

function pauseFocusForDistraction(active: ActiveWindowInfo, rule?: string): void {
  if (!focusActive || focusPhase !== "focus" || blockingMode === "focusWarning") return;
  const now = Date.now();
  focusRemainingMs = Math.max(0, (focusEndsAt ?? now) - now);
  recordStatsSpan("focus", focusSegmentStartedAt, now, lastFocusWindow);
  focusSegmentStartedAt = null;
  clearFocusTimer();
  focusEndsAt = null;
  distractionStartedAt = now;
  distractionWindow = active;
  blockingMode = "focusWarning";
  setDistractionStatus({ lastWarningAt: now });
  updateStats((stats) => ({ ...stats, focusWarnings: stats.focusWarnings + 1 }));
  setPetState("focusAlert");
  sendToAll("app:snapshot", snapshot());
  const labels = text();
  const goalText = currentGoalText();
  showBubble({
    id: "focus-warning",
    message: goalText ? labels.bubble.goalDistraction(goalText) : pick(labels.bubble.focusWarning)(rule ?? "?"),
    actions: [
      { id: "focus:back", label: labels.actions.focusBack, kind: "primary" },
      { id: "focus:end", label: labels.actions.focusEnd }
    ]
  });
}

function resumeFocusFromDistraction(): void {
  if (!focusActive || focusPhase !== "focus") return;
  const now = Date.now();
  recordStatsSpan("distraction", distractionStartedAt, now, distractionWindow);
  distractionStartedAt = null;
  distractionWindow = null;
  blockingMode = null;
  setDistractionStatus({ lastWarningAt: null });
  focusSegmentStartedAt = now;
  focusEndsAt = now + Math.max(0, focusRemainingMs ?? getSettings().focusDurationMinutes * 60_000);
  focusRemainingMs = null;
  clearFocusTimer();
  focusTimer = setTimeout(() => completeFocusInterval(), Math.max(0, focusEndsAt - now));
  sendToAll("app:snapshot", snapshot());
  setPetState("focusGuard");
  showBubble({ id: "focus-back", message: pick(text().bubble.focusBack), autoDismissMs: 1800 });
  setTimeout(() => {
    if (focusActive && !blockingMode) hideBubble();
  }, 1900);
}

function triggerFocusWarning(rule?: string): void {
  if (blockingMode === "breakRun") return;
  if (focusActive && focusPhase === "focus" && blockingMode !== "focusWarning") {
    pauseFocusForDistraction(distractionWindow ?? lastFocusWindow ?? { appName: "", windowTitle: "" }, rule);
    return;
  }
  ensurePetWindowVisible();
  if (!focusActive) startFocusMode();
  blockingMode = "focusWarning";
  updateStats((stats) => ({ ...stats, focusWarnings: stats.focusWarnings + 1 }));
  setPetState("focusAlert");
  sendToAll("app:snapshot", snapshot());
  const labels = text();
  const goalText = currentGoalText();
  showBubble({
    id: "focus-warning",
    message: goalText ? labels.bubble.goalDistraction(goalText) : pick(labels.bubble.focusWarning)(rule ?? "?"),
    actions: [
      { id: "focus:back", label: labels.actions.focusBack, kind: "primary" },
      { id: "focus:end", label: labels.actions.focusEnd }
    ]
  });
}

function clearFocusTimer(): void {
  if (focusTimer) {
    clearTimeout(focusTimer);
    focusTimer = null;
  }
}

function showCurrentGoalReminder(settings = getSettings()): void {
  const session = getGoalSession();
  if (!session) return;
  const currentSmallGoal = session.smallGoals[session.currentSmallGoalIndex];
  const message = currentSmallGoal?.title
    ? text().bubble.smallGoalStart(currentSmallGoal.title)
    : text().bubble.bigGoalStart(session.bigGoal.title);
  showBubble({
    id: "goal-start",
    message,
    autoDismissMs: Math.min(60_000, settings.focusDurationMinutes * 60_000)
  });
}

function promptSmallGoalCompletion(): void {
  const session = getGoalSession();
  const smallGoal = session?.smallGoals[session.currentSmallGoalIndex];
  if (!session || !smallGoal) {
    beginPomodoroBreak(getSettings());
    return;
  }
  blockingMode = "goalPrompt";
  setPetState("focusDone");
  sendToAll("app:snapshot", snapshot());
  showBubble({
    id: "goal-small-complete",
    message: text().bubble.smallGoalComplete(smallGoal.title),
    actions: [
      { id: "goal:small-completed", label: text().actions.goalCompleted, kind: "primary" },
      { id: "goal:small-progress", label: text().actions.goalInProgress }
    ]
  });
}

function promptBigGoalCompletion(): void {
  const session = getGoalSession();
  if (!session) {
    stopFocusMode(true);
    return;
  }
  blockingMode = "goalPrompt";
  setPetState("focusDone");
  sendToAll("app:snapshot", snapshot());
  showBubble({
    id: "goal-big-complete",
    message: text().bubble.bigGoalComplete(session.bigGoal.title),
    actions: [
      { id: "goal:big-completed", label: text().actions.goalCompleted, kind: "primary" },
      { id: "goal:big-progress", label: text().actions.goalInProgress }
    ]
  });
}

function beginFocusInterval(settings = getSettings()): void {
  focusPhase = "focus";
  focusStartedAt = Date.now();
  focusSegmentStartedAt = focusStartedAt;
  focusRemainingMs = null;
  distractionStartedAt = null;
  distractionWindow = null;
  lastFocusWindow = null;
  focusEndsAt = focusStartedAt + settings.focusDurationMinutes * 60 * 1000;
  setPetState("focusGuard");
  showCurrentGoalReminder(settings);
  clearFocusTimer();
  focusTimer = setTimeout(() => completeFocusInterval(), settings.focusDurationMinutes * 60 * 1000);
  scheduleDistractionDetection();
  sendToAll("app:snapshot", snapshot());
}

function beginPomodoroBreak(settings = getSettings(), completionMessage?: string): void {
  focusPhase = "break";
  focusStartedAt = null;
  focusSegmentStartedAt = null;
  focusRemainingMs = null;
  distractionStartedAt = null;
  distractionWindow = null;
  lastFocusWindow = null;
  focusEndsAt = Date.now() + settings.focusBreakMinutes * 60 * 1000;
  blockingMode = null;
  scheduleDistractionDetection();
  setPetState("focusDone");
  showBubble({
    id: "pomodoro-break",
    message: completionMessage ?? pick(text().bubble.focusBreakStart)(settings.focusBreakMinutes),
    autoDismissMs: 4500
  });
  clearFocusTimer();
  focusTimer = setTimeout(() => promptResumeNextGoal(), settings.focusBreakMinutes * 60 * 1000);
  sendToAll("app:snapshot", snapshot());
}

function promptResumeNextGoal(): void {
  if (!focusActive || focusPhase !== "break") return;
  clearFocusTimer();
  focusEndsAt = null;
  blockingMode = "goalPrompt";
  const session = getGoalSession();
  const nextGoal = session?.smallGoals[session.currentSmallGoalIndex];
  setPetState("focusDone");
  ensurePetWindowVisible();
  showBubble({
    id: "pomodoro-resume",
    message: nextGoal?.title
      ? text().bubble.resumeNextGoal(nextGoal.title)
      : text().bubble.resumeNextGoalGeneric,
    actions: [
      { id: "goal:resume", label: text().actions.goalResume, kind: "primary" },
      { id: "goal:stop", label: text().actions.focusEnd }
    ]
  });
  sendToAll("app:snapshot", snapshot());
}

function completeFocusInterval(): void {
  if (!focusActive || focusPhase !== "focus") return;
  const settings = getSettings();
  recordStatsSpan("focus", focusSegmentStartedAt, Date.now(), lastFocusWindow);
  focusSegmentStartedAt = null;
  const completedCount = recordCompletedPomodoro();
  beginPomodoroBreak(settings, pomodoroEncouragement(completedCount));
}

function startFocusMode(input?: FocusGoalInput): void {
  if (focusActive || blockingMode) return;
  if (!input?.bigGoalTitle && activeTaskId) {
    const task = getAllTasks().find((t) => t.id === activeTaskId);
    if (task) {
      input = { bigGoalTitle: task.name, smallGoalTitles: input?.smallGoalTitles ?? [] };
    }
  }
  if (input && !startGoalSession(input)) {
    requestFocusGoalInput();
    return;
  }
  if (activeTaskId && taskTimerStartedAt) {
    flushTaskActiveMs();
    taskTimerStartedAt = null;
    taskLastFlushAt = null;
    lastTaskWindowKey = null;
    if (taskSaveTimer) { clearInterval(taskSaveTimer); taskSaveTimer = null; }
  }
  ensurePetWindowVisible();
  const settings = getSettings();
  // Focus reminder is irrelevant while focusing — clear it.
  if (focusReminderTimer) {
    clearTimeout(focusReminderTimer);
    focusReminderTimer = null;
  }
  focusReminderDueAt = null;
  // Inline goal prompt is no longer needed once focus begins.
  clearFocusGoalInlineState();
  focusActive = true;
  focusPhase = "focus";
  focusCycleCurrent = 1;
  focusStartedAt = null;
  blockingMode = null;
  beginFocusInterval(settings);
  updateTrayMenu();
}

function stopFocusMode(completed: boolean): void {
  if (!focusActive) return;
  const now = Date.now();
  const shouldCountPartialFocus = !completed && focusPhase === "focus";
  if (blockingMode === "focusWarning") {
    recordStatsSpan("distraction", distractionStartedAt, now, distractionWindow);
  } else if (shouldCountPartialFocus) {
    recordStatsSpan("focus", focusSegmentStartedAt, now, lastFocusWindow);
  }
  focusActive = false;
  focusPhase = null;
  focusCycleCurrent = 0;
  focusStartedAt = null;
  focusSegmentStartedAt = null;
  focusRemainingMs = null;
  distractionStartedAt = null;
  distractionWindow = null;
  lastFocusWindow = null;
  blockingMode = null;
  clearFocusTimer();
  focusEndsAt = null;
  scheduleDistractionDetection();
  scheduleFocusReminder();
  sendToAll("app:snapshot", snapshot());
  setPetState("focusDone");
  showBubble({
    id: "focus-complete",
    message: completed ? pick(text().bubble.focusComplete) : pick(text().bubble.focusCancelled),
    autoDismissMs: 2800
  });
  setTimeout(() => {
    if (!focusActive && !blockingMode) {
      hideBubble();
      setPetState("idle");
    }
  }, 2900);
  if (activeTaskId) {
    const task = getAllTasks().find((t) => t.id === activeTaskId);
    if (task && task.type !== "deepWork") {
      taskTimerStartedAt = Date.now();
      taskLastFlushAt = taskTimerStartedAt;
      startTaskSampling();
    }
  }
  updateTrayMenu();
}

function triggerDemo(trigger: DemoTrigger): void {
  ensurePetWindowVisible();
  if (trigger === "break") triggerBreakReminder(true);
  if (trigger === "hydration") triggerHydrationReminder(true);
  if (trigger === "focusWarning") triggerFocusWarning("Twitter");
  if (trigger === "focusReminder") triggerFocusReminder(true);
  if (trigger === "happy") happyFeedback(pick(text().bubble.woof));
}

function handleBubbleAction(actionId: string): void {
  if (actionId === "goal:small-completed" || actionId === "goal:small-progress") {
    markGoalStatus("small", actionId === "goal:small-completed" ? "completed" : "inProgress");
    const session = getGoalSession();
    if (session) {
      setGoalSession({
        ...session,
        currentSmallGoalIndex: Math.min(session.currentSmallGoalIndex + 1, session.smallGoals.length - 1)
      });
    }
    blockingMode = null;
    beginPomodoroBreak(getSettings());
    return;
  }
  if (actionId === "goal:resume") {
    if (!focusActive || focusPhase !== "break") return;
    blockingMode = null;
    focusCycleCurrent += 1;
    beginFocusInterval(getSettings());
    return;
  }
  if (actionId === "goal:stop") {
    if (!focusActive || focusPhase !== "break") return;
    stopFocusMode(false);
    return;
  }
  if (actionId === "goal:big-completed" || actionId === "goal:big-progress") {
    markGoalStatus("big", actionId === "goal:big-completed" ? "completed" : "inProgress");
    blockingMode = null;
    stopFocusMode(true);
    return;
  }
  if (actionId === "break-run:done") {
    finishBreakRun();
    return;
  }
  if (actionId === "break:done") {
    updateStats((stats) => ({ ...stats, breaksTaken: stats.breaksTaken + 1 }));
    startBreakRun();
    return;
  }
  if (actionId === "break:snooze") {
    resumeLongTermState();
    if (breakTimer) clearTimeout(breakTimer);
    breakDueAt = Date.now() + 10 * 60 * 1000;
    breakTimer = setTimeout(() => triggerBreakReminder(false), 10 * 60 * 1000);
    publishSnapshot();
    return;
  }
  if (actionId === "break:mute") {
    breakMutedToday = true;
    breakDueAt = null;
    blockingMode = null;
    sendToAll("app:snapshot", snapshot());
    setPetState("sad");
    showBubble({ id: "break-muted", message: pick(text().bubble.breakIgnore), autoDismissMs: 2600 });
    setTimeout(resumeLongTermState, 2700);
    return;
  }
  if (actionId === "hydration:done") {
    updateStats((stats) => ({ ...stats, watersLogged: stats.watersLogged + 1 }));
    blockingMode = null;
    sendToAll("app:snapshot", snapshot());
    setPetState("drinking");
    hideBubble();
    setTimeout(() => {
      if (blockingMode) return;
      setPetState("hydrationDone");
      showBubble({ id: "hydration-complete", message: pick(text().bubble.hydrationDone), autoDismissMs: 1800 });
      setTimeout(() => {
        hideBubble();
        setPetState(focusActive ? "focusGuard" : "idle");
        scheduleReminderTimers();
      }, 1900);
    }, 2400);
    return;
  }
  if (actionId === "hydration:snooze") {
    resumeLongTermState();
    if (hydrationTimer) clearTimeout(hydrationTimer);
    hydrationDueAt = Date.now() + 15 * 60 * 1000;
    hydrationTimer = setTimeout(() => triggerHydrationReminder(false), 15 * 60 * 1000);
    publishSnapshot();
    return;
  }
  if (actionId === "focus:back") {
    resumeFocusFromDistraction();
    return;
  }
  if (actionId === "focus:end") {
    stopFocusMode(false);
    return;
  }
  if (actionId === "focus:reminder-start") {
    hideBubble();
    beginFocusEntry();
    return;
  }
  if (actionId === "focus:reminder-snooze") {
    hideBubble();
    scheduleFocusReminder();
    return;
  }
  if (actionId.startsWith("leisure:limit:")) {
    const minutes = Number(actionId.slice("leisure:limit:".length)) || 0;
    clearLeisureTimer();
    hideBubble();
    if (minutes > 0) {
      leisureEndsAt = Date.now() + minutes * 60_000;
      leisureTimer = setTimeout(triggerLeisureTimeUp, minutes * 60_000);
    }
    publishSnapshot();
    return;
  }
  if (actionId.startsWith("task:switch:")) {
    const taskId = actionId.slice("task:switch:".length);
    hideBubble();
    activateTask(taskId === "null" ? null : taskId);
    return;
  }
  if (actionId.startsWith("schedule:start:")) {
    handleScheduleAction(actionId, "start");
    return;
  }
  if (actionId.startsWith("schedule:skip:")) {
    handleScheduleAction(actionId, "skip");
    return;
  }
}

function registerPowerMonitor(): void {
  const onPause = (): void => {
    if (activeTaskId && taskLastFlushAt !== null) flushTaskActiveMs();
    taskLastFlushAt = null;
  };
  const onResume = (): void => {
    if (activeTaskId && taskTimerStartedAt !== null) {
      taskLastFlushAt = Date.now();
      void sampleTaskWindow();
    }
  };
  powerMonitor.on("suspend", onPause);
  powerMonitor.on("lock-screen", onPause);
  powerMonitor.on("resume", onResume);
  powerMonitor.on("unlock-screen", onResume);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildWorklogCsv(): string {
  const history: StatsHistory = { ...getStatsHistory() };
  const today = getStats();
  history[today.date] = today;
  const settings = getSettings();
  const taskNames = new Map<string, string>(
    [...BUILTIN_TASKS, ...settings.tasks].map((task) => [task.id, task.name])
  );
  const toMin = (ms: number): number => Math.round(ms / 60_000);

  const rows: string[] = ["Date,Task,Focus (min),Distraction (min),Active (min),Focus warnings,Breaks,Waters"];
  for (const date of Object.keys(history).sort()) {
    const day = normalizeStats(history[date], date);
    rows.push(
      [
        date,
        "(all)",
        toMin(day.focusMs),
        toMin(day.distractionMs),
        "",
        day.focusWarnings,
        day.breaksTaken,
        day.watersLogged
      ]
        .map(csvCell)
        .join(",")
    );
    for (const [taskId, stat] of Object.entries(day.taskStats)) {
      if (stat.focusMs <= 0 && stat.distractionMs <= 0 && stat.activeMs <= 0) continue;
      rows.push(
        [date, taskNames.get(taskId) ?? taskId, toMin(stat.focusMs), toMin(stat.distractionMs), toMin(stat.activeMs), "", "", ""]
          .map(csvCell)
          .join(",")
      );
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}

async function exportWorklog(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  const result = await dialog.showSaveDialog({
    title: "Export worklog",
    defaultPath: `pawpal-worklog-${todayKey()}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await writeFile(result.filePath, `﻿${buildWorklogCsv()}`, "utf8");
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function registerIpc(): void {
  ipcMain.handle("app:get-snapshot", () => snapshot());
  ipcMain.on("pet:clicked", () => {
    if (blockingMode) return;
    happyFeedback(null);
  });
  ipcMain.on("pet:middle-clicked", showTaskSwitcher);
  ipcMain.on("pet:context-menu", showPetContextMenu);
  ipcMain.on("pet:drag-start", (_event, offset: { offsetX: number; offsetY: number }) =>
    startPetDrag(offset)
  );
  ipcMain.on("pet:drag-stop", stopPetDrag);
  ipcMain.on("pet:bubble-height", (event, height: number) => {
    if (!petWindow || event.sender !== petWindow.webContents) return;
    fitPetWindowToBubble(height);
  });
  ipcMain.on("bubble:action", (_event, actionId: string) => handleBubbleAction(actionId));
  ipcMain.on("settings:update", (_event, partial: Partial<Settings>) => {
    setSettings({ ...getSettings(), ...partial });
  });
  ipcMain.on("demo:trigger", (_event, trigger: DemoTrigger) => triggerDemo(trigger));
  ipcMain.on("focus:start", beginFocusEntry);
  ipcMain.on("focus:start-with-goals", (_event, input: FocusGoalInput) => startFocusMode(input));
  ipcMain.on("focus:stop", () => stopFocusMode(false));
  ipcMain.on("focus:submit-inline-goal", (_event, title: string) => submitInlineGoal(title));
  ipcMain.on("focus:skip-inline-goal", () => skipInlineGoal());
  ipcMain.on("goal:clear-draft", () => {
    setGoalDraft(null);
    setGoalSession(null);
    focusGoalInputOpen = true;
    publishSnapshot();
  });
  ipcMain.on("distraction:block-current-app", addCurrentAppToBlockedApps);
  ipcMain.on("stats:reset-today", resetTodayStats);
  ipcMain.handle("stats:export-worklog", () => exportWorklog());
  ipcMain.on("task:activate", (_event, taskId: string | null) => {
    activateTask(taskId);
  });
  ipcMain.on("task:add", (_event, name: string, type: TaskType) => {
    const trimmed = name.trim().slice(0, 50);
    if (!trimmed) return;
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const task: Task = { id, name: trimmed, type };
    const settings = getSettings();
    setSettings({ ...settings, tasks: [...settings.tasks, task] });
  });
  ipcMain.on("task:remove", (_event, taskId: string) => {
    const settings = getSettings();
    setSettings({ ...settings, tasks: settings.tasks.filter((t) => t.id !== taskId) });
    if (activeTaskId === taskId) activateTask(null);
  });
  ipcMain.on("task:set-rules", (_event, taskId: string, rules: string[]) => {
    const settings = getSettings();
    setSettings({
      ...settings,
      tasks: settings.tasks.map((t) =>
        t.id === taskId
          ? { ...t, matchRules: rules.map((r) => r.trim()).filter(Boolean).slice(0, 20) }
          : t
      )
    });
  });
  ipcMain.on("schedule:add", (_event, data: { title: string; time: string; taskId: string | null; daysOfWeek: number[] }) => {
    addSchedule(data);
  });
  ipcMain.on("schedule:update", (_event, id: string, partial: Partial<Omit<Schedule, "id">>) => {
    updateSchedule(id, partial);
  });
  ipcMain.on("schedule:remove", (_event, id: string) => {
    removeSchedule(id);
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: "pawpal-asset", privileges: { bypassCSP: true, supportFetchAPI: true } }
]);

app.whenReady().then(() => {
  protocol.handle("pawpal-asset", (request) => {
    let relativePath = "";
    try {
      const url = new URL(request.url);
      relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return new Response("Invalid asset URL", { status: 404 });
    }

    const base = app.isPackaged ? process.resourcesPath : process.cwd();
    const assetRoot = resolve(base, "pet_assets");
    const assetPath = resolve(base, relativePath);
    const isInsideAssetRoot = assetPath === assetRoot || assetPath.startsWith(`${assetRoot}${sep}`);

    if (!isInsideAssetRoot) {
      return new Response("Asset not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(assetPath).href);
  });

  getStats();
  scheduleStatsRollover();
  registerIpc();
  registerPowerMonitor();
  createPetWindow();
  createTray();
  scheduleReminderTimers();
  scheduleDistractionDetection();
  scheduleAutoTaskSwitch();
  startScheduleCheck();
  if (IS_DEV) {
    createSettingsWindow();
  }

  app.on("activate", () => {
    if (!petWindow) createPetWindow();
  });
});

app.on("before-quit", () => {
  flushTaskActiveMs();
  for (const timer of [
    breakRunTimer,
    breakRunCountdownTimer,
    breakRunMovementTimer,
    breakTimer,
    hydrationTimer,
    focusTimer,
    distractionTimer,
    distractionStartupTimer,
    bubbleTimer,
    dragTimer,
    taskSaveTimer,
    autoSwitchTimer,
    leisureTimer,
    statsRolloverTimer
  ]) {
    if (timer) clearTimeout(timer);
  }
});

app.on("window-all-closed", () => {
  // Keep the menu-bar utility alive after the settings window is closed.
});

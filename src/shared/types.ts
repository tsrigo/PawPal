export type Language = "zh-CN" | "en";

export type TaskType = "deepWork" | "misc" | "leisure";

export type Task = {
  id: string;
  name: string;
  type: TaskType;
  isBuiltin?: boolean;
  matchRules?: string[];
};

export type TaskStat = {
  focusMs: number;
  distractionMs: number;
  activeMs: number;
  focusByWindow: Record<string, number>;
  distractionByWindow: Record<string, number>;
  activeByWindow: Record<string, number>;
};

export type PetAppearanceId = "lovartPuppy" | "lineDog";

export type PetFacing = "left" | "right";

export type PetState =
  | "idle"
  | "sitting"
  | "happy"
  | "breakPrompt"
  | "breakRunning"
  | "breakDone"
  | "hydrationPrompt"
  | "drinking"
  | "hydrationDone"
  | "focusGuard"
  | "focusAlert"
  | "focusDone"
  | "sad"
  | "sleeping";

export type BubbleAction = {
  id: string;
  label: string;
  kind?: "primary" | "secondary" | "danger";
};

export type SpeechBubble = {
  id: string;
  message: string;
  actions?: BubbleAction[];
  autoDismissMs?: number;
};

export type BlockingMode = "break" | "breakRun" | "hydration" | "focusWarning" | "goalPrompt" | null;

export type FocusPhase = "focus" | "break" | null;

export type GoalStatus = "completed" | "inProgress";

export type FocusGoal = {
  id: string;
  title: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type FocusGoalSession = {
  id: string;
  bigGoal: FocusGoal;
  smallGoals: FocusGoal[];
  currentSmallGoalIndex: number;
  startedAt: number;
  completedAt?: number;
};

export type FocusGoalInput = {
  bigGoalTitle: string;
  smallGoalTitles: string[];
};

export type Settings = {
  language: Language;
  petAppearanceId: PetAppearanceId;
  onboardingDismissed: boolean;
  breakReminderEnabled: boolean;
  breakIntervalMinutes: number;
  hydrationReminderEnabled: boolean;
  hydrationIntervalMinutes: number;
  focusDurationMinutes: number;
  focusBreakMinutes: number;
  focusPomodoroCount: number;
  distractionDetectionEnabled: boolean;
  distractionGraceSeconds: number;
  distractionBlockedApps: string[];
  distractionBlockedKeywords: string[];
  tasks: Task[];
  autoTaskSwitchEnabled: boolean;
};

export type TodayStats = {
  date: string;
  breaksTaken: number;
  watersLogged: number;
  focusMinutes: number;
  focusMs: number;
  distractionMs: number;
  focusWarnings: number;
  focusByHour: Record<string, number>;
  distractionByHour: Record<string, number>;
  focusByWindow: Record<string, number>;
  distractionByWindow: Record<string, number>;
  goalsCompleted: number;
  smallGoalsCompleted: number;
  taskStats: Record<string, TaskStat>;
};

export type StatsHistory = Record<string, TodayStats>;

export type TimerStatus = {
  breakDueAt: number | null;
  hydrationDueAt: number | null;
  focusEndsAt: number | null;
  focusRemainingMs: number | null;
  distractionStartedAt: number | null;
};

export type DistractionStatus = {
  state: "idle" | "watching" | "permission-needed" | "unsupported" | "error";
  activeApp: string;
  activeWindowTitle: string;
  matchedRule: string | null;
  lastCheckedAt: number | null;
  lastWarningAt: number | null;
  error: string | null;
};

export type AppSnapshot = {
  settings: Settings;
  stats: TodayStats;
  statsHistory: StatsHistory;
  timers: TimerStatus;
  distraction: DistractionStatus;
  petState: PetState;
  petFacing: PetFacing;
  blockingMode: BlockingMode;
  focusActive: boolean;
  focusPhase: FocusPhase;
  focusCycleCurrent: number;
  goalSession: FocusGoalSession | null;
  goalDraft: FocusGoalInput | null;
  focusGoalInputOpen: boolean;
  dogVisible: boolean;
  activeTaskId: string | null;
  taskTimerStartedAt: number | null;
  leisureEndsAt: number | null;
};

export type DemoTrigger =
  | "break"
  | "hydration"
  | "focusWarning"
  | "happy";

export type RendererEventMap = {
  "pet:set-state": PetState;
  "pet:show-bubble": SpeechBubble;
  "pet:hide-bubble": void;
  "settings:updated": Settings;
  "stats:updated": TodayStats;
  "app:snapshot": AppSnapshot;
};

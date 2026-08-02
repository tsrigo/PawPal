import type { Settings, Task, TaskStat, TodayStats } from "./types";

export const BUILTIN_TASK_MISC_ID = "__misc__";
export const BUILTIN_TASK_LEISURE_ID = "__leisure__";
export const TODAY_POMODORO_SLOT_COUNT = 8;

export const BUILTIN_TASKS: Task[] = [
  { id: BUILTIN_TASK_MISC_ID, name: "杂活", type: "misc", isBuiltin: true },
  { id: BUILTIN_TASK_LEISURE_ID, name: "娱乐", type: "leisure", isBuiltin: true }
];

export function createEmptyTaskStat(): TaskStat {
  return {
    focusMs: 0,
    distractionMs: 0,
    activeMs: 0,
    focusByWindow: {},
    distractionByWindow: {},
    activeByWindow: {}
  };
}

export const DEFAULT_SETTINGS: Settings = {
  language: "zh-CN",
  petAppearanceId: "lineDog",
  onboardingDismissed: false,
  breakReminderEnabled: true,
  breakIntervalMinutes: 45,
  hydrationReminderEnabled: true,
  hydrationIntervalMinutes: 90,
  focusReminderEnabled: true,
  focusReminderIntervalMinutes: 15,
  focusDurationMinutes: 25,
  focusBreakMinutes: 5,
  focusPomodoroCount: 4,
  distractionDetectionEnabled: false,
  distractionGraceSeconds: 8,
  tasks: [],
  autoTaskSwitchEnabled: false,
  distractionBlockedApps: [
    "Steam",
    "Discord",
    "Telegram",
    "WeChat",
    "Weixin",
    "QQ"
  ],
  distractionBlockedKeywords: [
    "youtube",
    "youtu.be",
    "twitter",
    "x.com",
    "instagram",
    "reddit",
    "tiktok",
    "netflix",
    "twitch",
    "facebook",
    "bilibili",
    "weibo",
    "douyin",
    "xiaohongshu",
    "zhihu",
    "douban",
    "taobao",
    "jd.com",
    "小红书",
    "微博",
    "抖音",
    "知乎",
    "豆瓣",
    "淘宝",
    "京东",
    "哔哩哔哩",
    "虎扑",
    "贴吧"
  ]
};

export function todayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createEmptyStats(date = todayKey()): TodayStats {
  return {
    date,
    breaksTaken: 0,
    watersLogged: 0,
    focusMinutes: 0,
    focusMs: 0,
    distractionMs: 0,
    focusWarnings: 0,
    focusByHour: {},
    distractionByHour: {},
    focusByWindow: {},
    distractionByWindow: {},
    goalsCompleted: 0,
    smallGoalsCompleted: 0,
    pomodoros: [],
    taskStats: {}
  };
}

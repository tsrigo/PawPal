import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSnapshot,
  DemoTrigger,
  FocusGoalInput,
  PetState,
  Schedule,
  Settings,
  SpeechBubble,
  TaskType,
  TodayStats
} from "../shared/types";

type Unsubscribe = () => void;

function onChannel<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke("app:get-snapshot"),
  petClicked: (): void => ipcRenderer.send("pet:clicked"),
  petMiddleClicked: (): void => ipcRenderer.send("pet:middle-clicked"),
  petContextMenu: (): void => ipcRenderer.send("pet:context-menu"),
  petDragStart: (offset: { offsetX: number; offsetY: number }): void =>
    ipcRenderer.send("pet:drag-start", offset),
  petDragStop: (): void => ipcRenderer.send("pet:drag-stop"),
  bubbleHeightChanged: (height: number): void => ipcRenderer.send("pet:bubble-height", height),
  bubbleAction: (actionId: string): void => ipcRenderer.send("bubble:action", actionId),
  updateSettings: (settings: Partial<Settings>): void =>
    ipcRenderer.send("settings:update", settings),
  triggerDemo: (trigger: DemoTrigger): void => ipcRenderer.send("demo:trigger", trigger),
  isPackaged: !process.defaultApp,
  assetUrl: (relativePath: string): string => {
    return `pawpal-asset://asset/${encodeURIComponent(relativePath)}`;
  },
  startFocus: (): void => ipcRenderer.send("focus:start"),
  startFocusWithGoals: (goals: FocusGoalInput): void => ipcRenderer.send("focus:start-with-goals", goals),
  stopFocus: (): void => ipcRenderer.send("focus:stop"),
  submitInlineGoal: (title: string): void => ipcRenderer.send("focus:submit-inline-goal", title),
  skipInlineGoal: (): void => ipcRenderer.send("focus:skip-inline-goal"),
  clearGoalDraft: (): void => ipcRenderer.send("goal:clear-draft"),
  blockCurrentApp: (): void => ipcRenderer.send("distraction:block-current-app"),
  resetToday: (): void => ipcRenderer.send("stats:reset-today"),
  exportWorklog: (): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke("stats:export-worklog"),
  activateTask: (taskId: string | null): void => ipcRenderer.send("task:activate", taskId),
  addTask: (name: string, type: TaskType): void => ipcRenderer.send("task:add", name, type),
  removeTask: (taskId: string): void => ipcRenderer.send("task:remove", taskId),
  setTaskRules: (taskId: string, rules: string[]): void =>
    ipcRenderer.send("task:set-rules", taskId, rules),
  addSchedule: (data: {
    title: string;
    time: string;
    taskId: string | null;
    daysOfWeek: number[];
  }): void => ipcRenderer.send("schedule:add", data),
  updateSchedule: (id: string, partial: Partial<Omit<Schedule, "id">>): void =>
    ipcRenderer.send("schedule:update", id, partial),
  removeSchedule: (id: string): void => ipcRenderer.send("schedule:remove", id),
  onPetState: (callback: (state: PetState) => void): Unsubscribe =>
    onChannel("pet:set-state", callback),
  onShowBubble: (callback: (bubble: SpeechBubble) => void): Unsubscribe =>
    onChannel("pet:show-bubble", callback),
  onHideBubble: (callback: () => void): Unsubscribe => onChannel("pet:hide-bubble", callback),
  onSettingsUpdated: (callback: (settings: Settings) => void): Unsubscribe =>
    onChannel("settings:updated", callback),
  onStatsUpdated: (callback: (stats: TodayStats) => void): Unsubscribe =>
    onChannel("stats:updated", callback),
  onSnapshot: (callback: (snapshot: AppSnapshot) => void): Unsubscribe =>
    onChannel("app:snapshot", callback)
};

contextBridge.exposeInMainWorld("pawpal", api);

export type PawPalApi = typeof api;

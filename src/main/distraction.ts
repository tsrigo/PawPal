import { execFile } from "node:child_process";
import type { Settings } from "../shared/types";

export type ActiveWindowInfo = {
  appName: string;
  windowTitle: string;
};

const IGNORED_DISTRACTION_APPS = ["PawPal", "Electron"];

function normalizeRule(value: string): string {
  return value.trim().toLowerCase();
}

function activeWindowScript(): string {
  return `
tell application "System Events"
  set frontAppProcess to first application process whose frontmost is true
  set frontApp to name of frontAppProcess
  set frontWindow to ""
  try
    set frontWindow to name of front window of frontAppProcess
  end try
end tell
return frontApp & linefeed & frontWindow
`;
}

function readMacActiveWindow(): Promise<ActiveWindowInfo> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", activeWindowScript()], { timeout: 2500 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const [appName = "", ...titleParts] = stdout.trimEnd().split("\n");
      resolve({
        appName: appName.trim(),
        windowTitle: titleParts.join("\n").trim()
      });
    });
  });
}

function windowsActiveWindowScript(): string {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ActiveWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$handle = [ActiveWindow]::GetForegroundWindow()
$titleBuilder = New-Object System.Text.StringBuilder 1024
[void][ActiveWindow]::GetWindowText($handle, $titleBuilder, $titleBuilder.Capacity)
$processId = 0
[void][ActiveWindow]::GetWindowThreadProcessId($handle, [ref]$processId)
$processName = ""
if ($processId -gt 0) {
  try {
    $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
  } catch {
    $processName = ""
  }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[PSCustomObject]@{
  appName = $processName
  windowTitle = $titleBuilder.ToString()
} | ConvertTo-Json -Compress
`;
}

function readWindowsActiveWindow(): Promise<ActiveWindowInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsActiveWindowScript()],
      { timeout: 2500, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim() || "{}") as Partial<ActiveWindowInfo>;
          resolve({
            appName: typeof parsed.appName === "string" ? parsed.appName.trim() : "",
            windowTitle: typeof parsed.windowTitle === "string" ? parsed.windowTitle.trim() : ""
          });
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

export function supportsActiveWindowDetection(platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function readActiveWindow(): Promise<ActiveWindowInfo> {
  if (process.platform === "darwin") return readMacActiveWindow();
  if (process.platform === "win32") return readWindowsActiveWindow();
  return Promise.reject(new Error(`Active-window detection is not supported on ${process.platform}.`));
}

export function classifyDistraction(active: ActiveWindowInfo, settings: Settings): string | null {
  const appName = active.appName.trim();
  const title = active.windowTitle.trim();
  const appNameLower = appName.toLowerCase();
  const titleLower = title.toLowerCase();

  if (IGNORED_DISTRACTION_APPS.some((ignored) => ignored.toLowerCase() === appNameLower)) {
    return null;
  }

  const blockedApp = settings.distractionBlockedApps
    .map(normalizeRule)
    .filter(Boolean)
    .find((rule) => appNameLower.includes(rule));
  if (blockedApp) return `app:${blockedApp}`;

  const blockedKeyword = settings.distractionBlockedKeywords
    .map(normalizeRule)
    .filter(Boolean)
    .find((rule) => titleLower.includes(rule) || appNameLower.includes(rule));
  if (blockedKeyword) return `keyword:${blockedKeyword}`;

  return null;
}

export function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("not allowed assistive access") ||
    message.includes("System Events got an error") ||
    message.includes("not authorized") ||
    message.includes("Operation not permitted")
  );
}

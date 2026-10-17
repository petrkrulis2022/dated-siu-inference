/**
 * Alerts for the scheduled snapshot: a failed pull, a day that is not complete, a missed day, a stuck lock, a request ceiling reached. An alert is a short sentence naming the window and
 * the kind, with no Blockworks figure in it, so it is safe to show anywhere. Every alert is appended to a file first (the record that cannot fail quietly); a desktop toast on Windows
 * is a best-effort extra, for when someone is at the machine; both are written by a sink, and the orchestrator does not care which.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { privatePath } from "../paths.js";
import type { AlertKind } from "./status.js";

export interface Alert {
  at: string;
  kind: AlertKind;
  window: string;
  message: string;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

/** Appends one JSON line per alert. */
export class FileAlertSink implements AlertSink {
  readonly #path: string;
  constructor(path?: string) {
    this.#path = path ?? privatePath("cr", "alerts.jsonl");
  }
  async send(alert: Alert): Promise<void> {
    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, `${JSON.stringify(alert)}\n`, { mode: 0o600 });
  }
}

const isWsl = (): boolean => {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
};

/** A Windows toast through PowerShell, only on WSL, never failing the run: a missing PowerShell or a refused toast is ignored. */
export class ToastAlertSink implements AlertSink {
  readonly #run: (script: string) => Promise<void>;
  readonly #enabled: boolean;
  constructor(opts: { run?: (script: string) => Promise<void>; enabled?: boolean } = {}) {
    this.#enabled = opts.enabled ?? isWsl();
    this.#run =
      opts.run ??
      ((script) =>
        new Promise<void>((resolve) => {
          const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            stdio: "ignore",
          });
          const t = setTimeout(() => {
            p.kill();
            resolve();
          }, 15_000);
          p.on("error", () => {
            clearTimeout(t);
            resolve();
          });
          p.on("exit", () => {
            clearTimeout(t);
            resolve();
          });
        }));
  }
  async send(alert: Alert): Promise<void> {
    if (!this.#enabled) return;
    const text = `${alert.window}: ${alert.message}`.replaceAll("'", "''").slice(0, 200);
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$n = $xml.GetElementsByTagName('text')",
      "$n.Item(0).AppendChild($xml.CreateTextNode('Touchstone CR snapshot')) | Out-Null",
      `$n.Item(1).AppendChild($xml.CreateTextNode('${text}')) | Out-Null`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Touchstone Assay').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
    ].join("; ");
    try {
      await this.#run(script);
    } catch {
      /* best effort */
    }
  }
}

export class CompositeAlertSink implements AlertSink {
  constructor(readonly sinks: readonly AlertSink[]) {}
  async send(alert: Alert): Promise<void> {
    for (const s of this.sinks) {
      try {
        await s.send(alert);
      } catch {
        /* one sink failing must not stop the others */
      }
    }
  }
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}

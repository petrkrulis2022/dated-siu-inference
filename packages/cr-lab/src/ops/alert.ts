/**
 * Alerts for the scheduled snapshot: a failed pull, a day that is not complete, a missed day, a stuck lock, a request ceiling reached. An alert is a short sentence naming the window and
 * the kind, with no Blockworks figure in it, so it is safe to show anywhere. Every alert is appended to a file first (the record that cannot fail quietly); a desktop toast on Windows
 * is a best-effort extra, for when someone is at the machine; both are written by a sink, and the orchestrator does not care which.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Secret } from "../keys.js";
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

/** PowerShell's own registered app id: Windows shows a toast only for a registered app, and silently drops one sent under an invented name. */
const TOAST_APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;

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
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
    ].join("; ");
    try {
      await this.#run(script);
    } catch {
      /* best effort */
    }
  }
}

/** Where an alert email goes and how it is sent: Cloudflare Email Service's REST API (`POST /accounts/{id}/email/sending/send`), from an address on an onboarded domain to a verified destination address. */
export interface EmailAlertConfig {
  accountId: string;
  apiToken: Secret;
  from: string;
  to: string;
}

export class EmailAlertFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailAlertFailed";
  }
}

/**
 * Sends each alert as a short plain-text email. The failure message carries the HTTP status and Cloudflare's numeric error codes only: never the response body, never the token. The
 * body of the email is the alert's own sentence, which holds no Blockworks figure (a pulled step's name, a window, a count).
 */
export class EmailAlertSink implements AlertSink {
  readonly #cfg: EmailAlertConfig;
  readonly #fetch: typeof fetch;
  constructor(cfg: EmailAlertConfig, fetchImpl: typeof fetch = fetch) {
    this.#cfg = cfg;
    this.#fetch = fetchImpl;
  }
  async send(alert: Alert): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.#cfg.accountId)}/email/sending/send`;
    const res = await this.#fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#cfg.apiToken.reveal()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.#cfg.from,
        to: this.#cfg.to,
        subject: `[Touchstone CR] ${alert.kind}, ${alert.window}`,
        text: `${alert.message}\n\nRaised ${alert.at} by the Blockworks trial's snapshot scheduler. This message holds no Blockworks data.`,
      }),
      redirect: "error",
    });
    let codes = "";
    let ok = res.ok;
    try {
      const j = (await res.json()) as { success?: boolean; errors?: { code?: number }[] };
      ok = ok && j.success === true;
      codes = (j.errors ?? [])
        .map((e) => e.code)
        .filter((c): c is number => typeof c === "number")
        .join(",");
    } catch {
      ok = false;
    }
    if (!ok)
      throw new EmailAlertFailed(
        `alert email refused: HTTP ${res.status}${codes ? `, codes ${codes}` : ""}`,
      );
  }
}

/** The names of the four settings, in `.env`. */
export const EMAIL_ENV = {
  accountId: "CR_ALERT_CF_ACCOUNT_ID",
  apiToken: "CR_ALERT_CF_API_TOKEN",
  from: "CR_ALERT_FROM",
  to: "CR_ALERT_TO",
} as const;

/** The email sink if all four settings are present, otherwise undefined (alerts then go to the file and the toast only). Names the missing variables, never a value. */
export function emailSinkFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch,
): { sink?: EmailAlertSink; missing: string[] } {
  const get = (k: string): string | undefined => {
    const v = env[k]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const missing = Object.values(EMAIL_ENV).filter((k) => get(k) === undefined);
  if (missing.length > 0) return { missing };
  return {
    missing,
    sink: new EmailAlertSink(
      {
        accountId: get(EMAIL_ENV.accountId) as string,
        apiToken: new Secret(EMAIL_ENV.apiToken, get(EMAIL_ENV.apiToken) as string),
        from: get(EMAIL_ENV.from) as string,
        to: get(EMAIL_ENV.to) as string,
      },
      fetchImpl,
    ),
  };
}

/** What may be logged about a failed sink: the refusal's own safe message for email, otherwise only the error's class. */
const safeReason = (err: unknown): string =>
  err instanceof EmailAlertFailed ? err.message : err instanceof Error ? err.name : "error";

export class CompositeAlertSink implements AlertSink {
  constructor(
    readonly sinks: readonly AlertSink[],
    /** told which sink failed and why (never the alert's content), so a failing channel shows in the log instead of failing quietly */
    readonly onError?: (sink: string, reason: string) => void,
  ) {}
  async send(alert: Alert): Promise<void> {
    for (const s of this.sinks) {
      try {
        await s.send(alert);
      } catch (err) {
        // one sink failing must not stop the others
        this.onError?.(s.constructor.name, safeReason(err));
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

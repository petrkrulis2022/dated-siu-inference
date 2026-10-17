/**
 * Sends one clearly marked TEST alert through each alert channel on its own and says which worked, so the channels can be checked before a real alert depends on them. Sends a real email if the
 * `CR_ALERT_*` settings are in `.env`, and shows a Windows toast on WSL. Nothing is wrong when it runs; the message says so. Prints channel names and results, never a setting's value.
 *   pnpm --filter @touchstone/cr-lab run test-alert
 */
import {
  EMAIL_ENV,
  FileAlertSink,
  ToastAlertSink,
  emailSinkFromEnv,
  type AlertSink,
} from "../ops/alert.js";

const alert = {
  at: new Date().toISOString(),
  kind: "pull-failed" as const,
  window: "TEST",
  message: "This is a test of the snapshot alerts. Nothing is wrong.",
};

const channels: [string, AlertSink | undefined, string?][] = [];
const email = emailSinkFromEnv();
channels.push([
  "email",
  email.sink,
  email.sink === undefined ? `not sent: ${email.missing.join(", ")} not set in .env` : undefined,
]);
channels.push(["toast", new ToastAlertSink()]);
channels.push(["file", new FileAlertSink(undefined)]);

for (const [name, sink, skipped] of channels) {
  if (sink === undefined) {
    console.log(`${name}: ${skipped}`);
    continue;
  }
  try {
    await sink.send(alert);
    console.log(`${name}: sent`);
  } catch (err) {
    console.log(`${name}: FAILED (${err instanceof Error ? err.message : "error"})`);
    process.exitCode = 1;
  }
}
console.log(`(the email channel needs ${Object.values(EMAIL_ENV).join(", ")})`);

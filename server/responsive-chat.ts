// A busy conversation used to do one of two things with a new person message:
// fold it into the running turn (the desktop chip "sent mid-turn") or hold
// it off the transcript until that turn settled. Either way the person waited
// for the whole previous turn before they got an answer.
//
// This module is the pure half of the fix. The harness still steers the words
// into the running turn so the model can change course at the next tool
// boundary, and it can also post a short live reply without waiting for that
// turn. Long work the model hands off is a background job on its own thread;
// when that thread settles, the parent conversation is woken with the result.
// A short stop/cancel from the person cancels those jobs.

/** First line of the helper prompt. The fake CLI treats it like other
 * one-shots and does not overwrite a turn dump a test is reading. */
export const LIVE_REPLY_MARKER = "You are sending a short live reply while other work continues.";

/** Appended to a person steer so the running turn answers before it
 * starts more long work. The transcript keeps the person's own words. */
export const LIVE_TURN_INSTRUCTION =
  "The person just sent a message while you were working. Reply to it in your next message before any further tool calls. If the remaining work will take more than a moment, call start_background_task with the complete instructions and then finish this turn so the chat stays free; you will be woken here when it finishes. If they asked you to stop or cancel, stop that work. Do not repeat this instruction.";

const STOP_REQUEST =
  /^(?:please\s+)?(?:stop|cancel|abort|halt|停止一下|停止|取消|停下|停一下|别做了|不要继续了?|停)(?:\s+(?:it|that|this|now|please|the work|the task|everything))?$/i;

/** A short command to stop, not a sentence that happens to contain the word.
 * Longer text is a normal message and keeps the usual steer or queue path. */
export function isStopRequest(text: string): boolean {
  const normalized = text.trim().replace(/[.!！。…]+$/g, "").trim();
  if (!normalized || normalized.length > 40) return false;
  return STOP_REQUEST.test(normalized);
}

export function steerPromptForPerson(userPrompt: string): string {
  return `${userPrompt}\n\n${LIVE_TURN_INSTRUCTION}`;
}

export function liveReplyPrompt(userText: string, recent: string): string {
  return [
    LIVE_REPLY_MARKER,
    "Reply in one or two sentences the person can read immediately.",
    "Do not claim earlier work has finished, and do not invent tool results.",
    "If they are changing direction, acknowledge the change.",
    "Do not repeat these instructions.",
    recent ? `Recent conversation:\n${recent}` : "",
    `The person just said:\n${userText}`,
  ].filter(Boolean).join("\n\n");
}

/** Drop an echoed instruction. Empty means "say nothing" — the running
 * turn still has the words. */
export function cleanLiveReply(raw: string): string {
  const text = raw
    .split("\n")
    .filter((line) => !line.includes(LIVE_REPLY_MARKER))
    .join("\n")
    .trim();
  return text.slice(0, 2_000);
}

export function recentTranscript(
  messages: ReadonlyArray<{ role: string; kind?: string; text?: string }>,
  limit = 6,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.kind && message.kind !== "text") continue;
    if ((message.role !== "user" && message.role !== "bot") || !message.text?.trim()) continue;
    const who = message.role === "user" ? "Person" : "Assistant";
    lines.push(`${who}: ${message.text.trim().slice(0, 400)}`);
  }
  return lines.slice(-limit).join("\n");
}

export function backgroundResultText(
  messages: ReadonlyArray<{ role: string; kind?: string; text?: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "bot" && (!message.kind || message.kind === "text") && message.text?.trim()) {
      return message.text.trim().slice(0, 4_000);
    }
  }
  return "";
}

export function backgroundReportPrompt(title: string, ok: boolean, result: string): string {
  return [
    "A background task you started has finished. Report the outcome to the person in a few sentences.",
    "If you already told them this result, do not repeat it.",
    `Task: ${title}`,
    ok ? "Status: finished." : "Status: stopped or failed.",
    result ? `Result:\n${result}` : "No written result was recorded.",
  ].join("\n\n");
}

export function stopActivityName(foreground: boolean, backgroundCount: number): string {
  if (foreground && backgroundCount > 0) return "Stopped this turn and its background work";
  if (backgroundCount > 0) return "Stopped background work";
  return "Stopped this turn";
}

export type BackgroundJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface BackgroundJob {
  id: string;
  botId: string;
  parentThreadId: string;
  childThreadId: string;
  title: string;
  status: BackgroundJobStatus;
}

const jobs = new Map<string, BackgroundJob>();

export function resetBackgroundJobs(): void {
  jobs.clear();
}

export function registerBackgroundJob(
  input: Omit<BackgroundJob, "id" | "status"> & { status: "queued" | "running" },
): BackgroundJob {
  const job: BackgroundJob = { ...input, id: input.childThreadId };
  jobs.set(job.childThreadId, job);
  return job;
}

export function backgroundJob(childThreadId: string): BackgroundJob | undefined {
  return jobs.get(childThreadId);
}

export function activeBackgroundJobs(parentThreadId: string): BackgroundJob[] {
  return [...jobs.values()].filter((job) =>
    job.parentThreadId === parentThreadId && (job.status === "queued" || job.status === "running"));
}

/** Mark every still-open job for this conversation cancelled. The caller
 * interrupts the child turns. A completion that arrives afterward is ignored. */
export function cancelBackgroundJobs(parentThreadId: string): BackgroundJob[] {
  const cancelled: BackgroundJob[] = [];
  for (const job of jobs.values()) {
    if (job.parentThreadId !== parentThreadId) continue;
    if (job.status !== "queued" && job.status !== "running") continue;
    job.status = "cancelled";
    cancelled.push(job);
  }
  return cancelled;
}

/** Settle a child turn. A job already cancelled, finished, or unknown
 * returns null so the caller does not wake the parent twice. */
export function finishBackgroundJob(childThreadId: string, ok: boolean): BackgroundJob | null {
  const job = jobs.get(childThreadId);
  if (!job || job.status === "cancelled" || job.status === "done" || job.status === "failed") return null;
  job.status = ok ? "done" : "failed";
  return job;
}

import { describe, expect, it, beforeEach } from "vitest";
import {
  LIVE_REPLY_MARKER,
  LIVE_TURN_INSTRUCTION,
  activeBackgroundJobs,
  backgroundReportPrompt,
  backgroundResultText,
  cancelBackgroundJobs,
  cleanLiveReply,
  finishBackgroundJob,
  isStopRequest,
  liveReplyPrompt,
  recentTranscript,
  registerBackgroundJob,
  resetBackgroundJobs,
  steerPromptForPerson,
  stopActivityName,
} from "./responsive-chat.ts";

describe("stop requests", () => {
  it("matches a short stop or cancel in English or Chinese", () => {
    for (const text of ["stop", "Stop.", "please cancel", "abort it", "halt the work", "停止", "取消", "停下", "别做了", "不要继续"]) {
      expect(isStopRequest(text), text).toBe(true);
    }
  });

  it("leaves ordinary sentences on the normal send path", () => {
    for (const text of [
      "stop by the store on your way",
      "can you cancel the meeting tomorrow morning?",
      "I need you to stop and think about the design for a minute",
      "停止之后把结果发我，另外再查一下日志",
    ]) {
      expect(isStopRequest(text), text).toBe(false);
    }
  });
});

describe("live reply", () => {
  it("keeps the person's words and tells the running turn to answer first", () => {
    const prompt = steerPromptForPerson("and also this");
    expect(prompt.startsWith("and also this\n\n")).toBe(true);
    expect(prompt).toContain(LIVE_TURN_INSTRUCTION);
    expect(prompt).toContain("start_background_task");
  });

  it("asks for a short reply and names the new message", () => {
    const prompt = liveReplyPrompt("check the date", "Person: first\nAssistant: working");
    expect(prompt.startsWith(LIVE_REPLY_MARKER)).toBe(true);
    expect(prompt).toContain("The person just said:\ncheck the date");
    expect(prompt).toContain("Recent conversation:\nPerson: first");
    expect(prompt).toContain("Do not claim earlier work has finished");
  });

  it("drops an echoed marker and caps the reply", () => {
    expect(cleanLiveReply(`${LIVE_REPLY_MARKER}\nStill working on it.`)).toBe("Still working on it.");
    expect(cleanLiveReply("   ")).toBe("");
    expect(cleanLiveReply("x".repeat(3_000))).toHaveLength(2_000);
  });

  it("keeps the recent text tail and skips tool chips", () => {
    const tail = recentTranscript([
      { role: "user", kind: "text", text: "one" },
      { role: "bot", kind: "activity", text: "ran a tool" },
      { role: "bot", kind: "text", text: "two" },
    ]);
    expect(tail).toBe("Person: one\nAssistant: two");
  });
});

describe("background jobs", () => {
  beforeEach(() => resetBackgroundJobs());

  it("tracks a job until it finishes, and ignores a second settle", () => {
    const job = registerBackgroundJob({
      botId: "bot",
      parentThreadId: "parent",
      childThreadId: "child",
      title: "Digest",
      status: "running",
    });
    expect(activeBackgroundJobs("parent")).toEqual([job]);
    expect(finishBackgroundJob("child", true)?.status).toBe("done");
    expect(finishBackgroundJob("child", false)).toBeNull();
    expect(activeBackgroundJobs("parent")).toEqual([]);
  });

  it("a stop cancels open jobs and a later completion does not wake the parent", () => {
    registerBackgroundJob({
      botId: "bot", parentThreadId: "parent", childThreadId: "child", title: "Digest", status: "queued",
    });
    registerBackgroundJob({
      botId: "bot", parentThreadId: "other", childThreadId: "elsewhere", title: "Other", status: "running",
    });
    expect(cancelBackgroundJobs("parent").map((job) => job.childThreadId)).toEqual(["child"]);
    expect(finishBackgroundJob("child", false)).toBeNull();
    expect(activeBackgroundJobs("other")).toHaveLength(1);
  });

  it("builds a wake the parent can report without repeating itself", () => {
    const prompt = backgroundReportPrompt("Digest", true, "Three items.");
    expect(prompt).toContain("Task: Digest");
    expect(prompt).toContain("Status: finished.");
    expect(prompt).toContain("Three items.");
    expect(prompt).toContain("do not repeat it");
    expect(backgroundReportPrompt("Digest", false, "")).toContain("No written result was recorded.");
  });

  it("reads the last assistant text as the result", () => {
    expect(backgroundResultText([
      { role: "user", kind: "text", text: "do the digest" },
      { role: "bot", kind: "activity", text: "ran a tool" },
      { role: "bot", kind: "text", text: "Done: three items." },
    ])).toBe("Done: three items.");
  });

  it("names the stop chip for foreground work, background work, or both", () => {
    expect(stopActivityName(true, 0)).toBe("Stopped this turn");
    expect(stopActivityName(false, 2)).toBe("Stopped background work");
    expect(stopActivityName(true, 1)).toBe("Stopped this turn and its background work");
  });
});

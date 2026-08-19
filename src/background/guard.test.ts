import { describe, expect, it } from "vitest";
import { looksDegenerate, MAX_REPLY_CHARS, RunawayGuard } from "./guard";

describe("looksDegenerate", () => {
  /*
   * The real incident: a free model answered a summary request with `<pad>`
   * repeated thousands of times and never stopped.
   */
  it("catches the padding-token wall", () => {
    expect(looksDegenerate("<pad>".repeat(400))).toBe(true);
  });

  it("catches a single repeated character", () => {
    expect(looksDegenerate("a".repeat(1000))).toBe(true);
  });

  it("catches a repeated phrase", () => {
    expect(looksDegenerate("I cannot help with that. ".repeat(100))).toBe(true);
  });

  /*
   * The failure mode that matters more than missing a runaway: firing on
   * legitimate text. A summary is full of repeated *structure* — numbered
   * steps, bullet lists, headings — none of which is repeated text.
   */
  it("leaves a normal summary alone", () => {
    const summary = [
      "**What It Is**",
      "- A system that organises your code folder.",
      "- It runs tests and updates work continuously.",
      "",
      "**Why It Works**",
      "- Prevents vague changes and catches bugs before shipping.",
      "- Handles routine tasks while you sleep.",
      "",
      "1. Build the workspace with three markdown control files.",
      "2. Use plan mode before touching any code.",
      "3. Assign small tickets with exact finish lines.",
      "4. Enable visual testing through the desktop preview.",
      "5. Review found issues in three categories.",
    ].join("\n");
    expect(looksDegenerate(summary.repeat(3))).toBe(false);
  });

  it("leaves a numbered list of similar lines alone", () => {
    const list = Array.from(
      { length: 60 },
      (_, i) => `${i + 1}. Chapter about something specific ${i}`,
    ).join("\n");
    expect(looksDegenerate(list)).toBe(false);
  });

  it("ignores whitespace runs, which are formatting rather than degeneration", () => {
    expect(looksDegenerate(" ".repeat(1000))).toBe(false);
    expect(looksDegenerate("\n".repeat(1000))).toBe(false);
  });

  it("says nothing about text too short to judge", () => {
    expect(looksDegenerate("<pad><pad>")).toBe(false);
    expect(looksDegenerate("")).toBe(false);
  });
});

describe("RunawayGuard", () => {
  it("strips model plumbing from what gets shown", () => {
    const guard = new RunawayGuard();
    expect(guard.push("Hello <pad>world</s>").text).toBe("Hello world");
    expect(guard.push("<|eot_id|> and more").text).toBe(" and more");
  });

  it("stops once the repetition is unmistakable", () => {
    const guard = new RunawayGuard();
    let stopped = false;
    for (let i = 0; i < 400 && !stopped; i += 1) {
      stopped = guard.push("<pad>").stop;
    }
    expect(stopped).toBe(true);
  });

  it("never stops on a long, legitimate answer", () => {
    const guard = new RunawayGuard();
    for (let i = 0; i < 200; i += 1) {
      const verdict = guard.push(`Point ${i}: a distinct sentence about it.\n`);
      expect(verdict.stop).toBe(false);
    }
  });

  // The backstop for a model that rambles coherently rather than repeating.
  it("stops at the length cap", () => {
    const guard = new RunawayGuard();
    let stopped = false;
    for (let i = 0; i < 400 && !stopped; i += 1) {
      // Distinct each time, so only the length cap can fire.
      stopped = guard.push(
        `${i} ${Math.random().toString(36)} `.repeat(20),
      ).stop;
    }
    expect(stopped).toBe(true);
  });

  it("reports an answer that was nothing but plumbing", () => {
    const guard = new RunawayGuard();
    guard.push("<pad><pad><pad>");
    expect(guard.isEmpty).toBe(true);

    guard.push("real text");
    expect(guard.isEmpty).toBe(false);
  });

  it("gives a reason a person can act on", () => {
    const guard = new RunawayGuard();
    let reason = "";
    for (let i = 0; i < 400 && !reason; i += 1) {
      const verdict = guard.push("<pad>");
      if (verdict.stop) reason = verdict.reason;
    }
    expect(reason).toContain("settings");
  });

  it("caps at the documented length", () => {
    expect(MAX_REPLY_CHARS).toBeGreaterThan(10_000);
  });
});

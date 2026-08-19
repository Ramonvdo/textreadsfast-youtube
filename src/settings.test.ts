import { describe, expect, it } from "vitest";
import { downloadPath } from "./settings";

describe("downloadPath", () => {
  /*
   * `chrome.downloads` rejects the whole download if the filename leaves the
   * downloads directory, so an absolute path pasted into the folder box has to
   * be reduced to something usable rather than failing at the call site with an
   * opaque error.
   */
  it("keeps a plain subfolder", () => {
    expect(downloadPath("Obsidian/Inbox", "a.md")).toBe("Obsidian/Inbox/a.md");
  });

  it("accepts Windows separators", () => {
    expect(downloadPath(String.raw`Obsidian\Inbox`, "a.md")).toBe(
      "Obsidian/Inbox/a.md",
    );
  });

  it("strips a drive letter and a leading slash", () => {
    expect(downloadPath(String.raw`C:\Users\me\Vault`, "a.md")).toBe(
      "Users/me/Vault/a.md",
    );
    expect(downloadPath("/var/tmp", "a.md")).toBe("var/tmp/a.md");
  });

  // The one that would otherwise let a path escape the downloads directory.
  it("refuses to walk upwards", () => {
    expect(downloadPath("../../etc", "a.md")).toBe("etc/a.md");
    expect(downloadPath("..", "a.md")).toBe("a.md");
  });

  it("falls back to the bare filename", () => {
    expect(downloadPath("", "a.md")).toBe("a.md");
    expect(downloadPath("   ", "a.md")).toBe("a.md");
    expect(downloadPath("///", "a.md")).toBe("a.md");
  });
});

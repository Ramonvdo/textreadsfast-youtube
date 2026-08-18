import { describe, expect, it } from "vitest";
import { rankModels } from "./models";
import type { ModelOption } from "./provider";

const model = (id: string, contextLength: number): ModelOption => ({
  id,
  name: id,
  contextLength,
});

describe("rankModels", () => {
  /*
   * The rule this whole module exists to enforce.
   *
   * The first version hardcoded `meta-llama/llama-3.3-70b-instruct:free`. It
   * stopped being free and every install failed on its first request. Ranking a
   * live list is the fix; these tests pin the ranking's actual reasoning.
   */
  it("drops models too small to hold a transcript", () => {
    const ranked = rankModels([
      model("tiny/model:free", 4_096),
      model("big/llama:free", 128_000),
    ]);
    expect(ranked.map((m) => m.id)).toEqual(["big/llama:free"]);
  });

  // A short-context model still summarises a short video, which beats refusing
  // to pick anything at all.
  it("ranks everything rather than nothing when all are small", () => {
    const ranked = rankModels([
      model("a/one:free", 4_096),
      model("b/two:free", 8_192),
    ]);
    expect(ranked).toHaveLength(2);
  });

  it("prefers a known family over an unknown one of similar size", () => {
    const ranked = rankModels([
      model("obscure/whatever:free", 200_000),
      model("meta/llama-3.3:free", 128_000),
    ]);
    expect(ranked[0].id).toBe("meta/llama-3.3:free");
  });

  it("breaks ties within a family by context length", () => {
    const ranked = rankModels([
      model("meta/llama-small:free", 32_000),
      model("meta/llama-large:free", 128_000),
    ]);
    expect(ranked[0].id).toBe("meta/llama-large:free");
  });

  it("survives an empty list without throwing", () => {
    expect(rankModels([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [model("b/two:free", 32_000), model("a/llama:free", 64_000)];
    const before = input.map((m) => m.id);
    rankModels(input);
    expect(input.map((m) => m.id)).toEqual(before);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { tavilyGithubSearch } from "../app/api/teacher/tavily-github.ts";

test("Tavily only returns GitHub repositories as file discovery leads", async () => {
  const previous = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ results: [
      { url: "https://github.com/example/math/blob/main/papers/2025.pdf" },
      { url: "https://github.com/example/math/issues/1" },
      { url: "https://example.com/math.pdf" },
      { url: "https://github.com.evil.example/example/math" },
      { url: "https://raw.githubusercontent.com/example/other/main/file.pdf" },
    ] });
  };
  try {
    const result = await tavilyGithubSearch("test-key", "考研数学 真题", "past_exam");
    assert.deepEqual(request.include_domains, ["github.com"]);
    assert.equal(request.include_domains_mode, "restrict");
    assert.deepEqual(result.sources.map((source) => source.url), ["https://github.com/example/math"]);
  } finally { globalThis.fetch = previous; }
});

test("Tavily quota failures are reported instead of appearing as empty search results", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: { error: "quota reached" } }, { status: 429 });
  try {
    await assert.rejects(tavilyGithubSearch("test-key", "高考数学 大纲", "syllabus"), /额度或请求频率/);
  } finally { globalThis.fetch = previous; }
});

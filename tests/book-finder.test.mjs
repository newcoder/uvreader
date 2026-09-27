import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOK_FINDER_MAX,
  BOOK_FINDER_SYSTEM_PROMPT,
  buildBookFinderMessages,
  isBookFinderRequest,
  parseBookFinderReply,
} from "../packages/reader/src/book-finder.js";

test("fuzzy requests take the finder, concrete titles stay direct", () => {
  assert.equal(isBookFinderRequest("推荐几本讲宋代市民生活的书"), true);
  assert.equal(isBookFinderRequest("我想读《活着》，有什么版本推荐"), true);
  assert.equal(isBookFinderRequest("帮我找科幻入门"), true);
  assert.equal(isBookFinderRequest("整理成书籍列表：时间管理"), true);
  assert.equal(isBookFinderRequest("this is a longer request that should go through the finder"), true);
  assert.equal(isBookFinderRequest("活着"), false);
  assert.equal(isBookFinderRequest("余华 活着"), false);
  assert.equal(isBookFinderRequest(""), false);
  assert.equal(isBookFinderRequest("a"), false);
});

test("the finder prompt keeps the skill shape and asks for strict JSON", () => {
  assert.match(BOOK_FINDER_SYSTEM_PROMPT, /搜书助手（Book Finder）/);
  assert.match(BOOK_FINDER_SYSTEM_PROMPT, /触发场景/);
  assert.match(BOOK_FINDER_SYSTEM_PROMPT, /"books":\[\{"title":"书名","author":"作者","publisher":"出版社","reason":"一句话推荐理由"\}\]/);
  assert.match(BOOK_FINDER_SYSTEM_PROMPT, /默认 8 本/);
  assert.equal(BOOK_FINDER_MAX, 8);
});

test("messages carry the demand, the limit and the language", () => {
  const messages = buildBookFinderMessages("推荐几本讲宋代市民生活的书", { language: "简体中文" });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, BOOK_FINDER_SYSTEM_PROMPT);
  assert.match(messages[1].content, /读者需求：推荐几本讲宋代市民生活的书/);
  assert.match(messages[1].content, /最多返回 8 本/);
  assert.match(messages[1].content, /界面语言：简体中文/);
  assert.deepEqual(buildBookFinderMessages(""), []);
  assert.deepEqual(buildBookFinderMessages("   "), []);
  assert.match(buildBookFinderMessages("书", { max: 99 })[1].content, /最多返回 12 本/);
});

test("replies parse out of fences, dedupe and clamp", () => {
  const fenced = `\`\`\`json\n{"books":[${Array.from({ length: 10 }, (_, index) => (
    `{"title":"书${index}","author":"作者","publisher":"出版社","reason":"理由${index}"}`
  )).join(",")}]}\n\`\`\``;
  const books = parseBookFinderReply(fenced);
  assert.equal(books.length, 8);
  assert.deepEqual(books[0], { title: "书0", author: "作者", publisher: "出版社", reason: "理由0" });

  const dupes = parseBookFinderReply('{"books":[{"title":"活着","author":"余华"},{"title":"活着","author":"余华"},{"title":"活着","author":"另一个"}]}');
  assert.equal(dupes.length, 2);

  assert.deepEqual(parseBookFinderReply("抱歉，这里没有 JSON。"), []);
  assert.deepEqual(parseBookFinderReply("not json"), []);
  assert.deepEqual(parseBookFinderReply('{"books":[{"author":"无题"}]}'), []);

  const noisy = parseBookFinderReply('前言 {"books":[{"title":"  围城  ","reason":"多  空格"}]} 后记');
  assert.equal(noisy[0].title, "围城");
  assert.equal(noisy[0].reason, "多 空格");
  assert.equal(noisy[0].publisher, "");
});

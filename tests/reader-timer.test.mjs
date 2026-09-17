import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../packages/host-shim/src/index.js";
import { createReaderTimer } from "../packages/reader/src/reader-timer.js";

function setup() {
  const { window } = new JSDOM("<main><article></article></main>");
  installDomExtensions(window);
  const notices = [];
  const intervals = new Map();
  let nextId = 1;
  const timers = {
    setInterval(fn) { const id = nextId++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  const timer = createReaderTimer({
    translate: (key, ...args) => (args.length ? `${key}:${args.join(",")}` : key),
    notice: (message) => notices.push(message),
    window: timers,
  });
  const plugin = {
    settings: { timerEnabled: true, dailyGoalMin: 15 },
    today: 0,
    goal: 900,
    flushes: 0,
    bumpReadingTime(seconds) { this.today += seconds; },
    flushReadingTime() { this.flushes += 1; },
    getTodaySeconds() { return this.today; },
    getGoalSeconds() { return this.goal; },
    resetTodaySeconds() { this.today = 0; },
  };
  const doc = window.document;
  const reader = {
    plugin,
    contentEl: doc.querySelector("main"),
    areaEl: doc.querySelector("article"),
    timerBtnEl: doc.createElement("button"),
    timerIconEl: doc.createElement("div"),
    timerLabelEl: doc.createElement("div"),
    timerResetEl: doc.createElement("div"),
    goalWrapEl: doc.createElement("div"),
    goalFillEl: doc.createElement("div"),
    goalTxtEl: doc.createElement("div"),
  };
  doc.querySelector("main").append(reader.timerBtnEl, reader.timerIconEl, reader.timerLabelEl, reader.goalWrapEl);
  reader.goalWrapEl.append(reader.goalFillEl, reader.goalTxtEl);
  return { window, doc, timer, plugin, reader, notices, intervals };
}

test("start and pause own a single interval and flush on pause", () => {
  const { timer, plugin, reader, intervals } = setup();
  timer.start(reader);
  assert.equal(intervals.size, 1);
  assert.equal(reader._running, true);
  assert.equal(reader._timerStarted, true);
  timer.start(reader);
  assert.equal(intervals.size, 1, "a second start reuses the running interval");
  timer.pause(reader);
  assert.equal(intervals.size, 0);
  assert.equal(reader._running, false);
  assert.equal(plugin.flushes, 1);
  timer.start({ ...reader, plugin: { ...plugin, settings: { timerEnabled: false } } });
  assert.equal(intervals.size, 0, "a disabled timer never starts");
});

test("tick accrues seconds, flushes in batches and reports the goal once", () => {
  const { timer, plugin, reader, notices, intervals } = setup();
  timer.start(reader);
  const tick = [...intervals.values()][0];
  for (let i = 0; i < 14; i++) tick();
  assert.equal(plugin.today, 14);
  assert.equal(plugin.flushes, 0, "flushes wait for the full batch");
  tick();
  assert.equal(plugin.flushes, 1, "the fifteenth tick flushes");
  plugin.today = plugin.goal;
  tick();
  tick();
  assert.deepEqual(notices, ["today-s-reading-goal-reached"], "the goal notice fires once");
  plugin.settings.timerEnabled = false;
  tick();
  assert.equal(reader._running, false, "disabling the timer mid-session pauses it");
});

test("updateButton renders the remaining time and hides when inactive", () => {
  const { timer, plugin, reader } = setup();
  timer.updateButton(reader);
  assert.equal(reader.timerBtnEl.classList.contains("qiaomu-reader-hidden"), true, "hidden before any session");
  timer.start(reader);
  plugin.today = 125;
  timer.updateButton(reader);
  assert.equal(reader.timerBtnEl.classList.contains("qiaomu-reader-hidden"), false);
  assert.equal(reader.timerLabelEl.textContent, "12:55");
  assert.equal(reader.timerIconEl.querySelector("svg")?.getAttribute("viewBox"), "0 0 24 24");
  plugin.today = plugin.goal;
  timer.updateButton(reader);
  assert.equal(reader.timerBtnEl.classList.contains("qiaomu-reader-timer-done"), true);
});

test("buildButton wires toggle, reset and the goal bar", () => {
  const { timer, plugin, reader, doc, notices } = setup();
  const tray = doc.createElement("div");
  timer.buildButton(tray, reader);
  assert.ok(tray.querySelector(".qiaomu-reader-timerbtn"));
  assert.equal(tray.querySelector(".qiaomu-reader-timer-reset").getAttribute("aria-label"), "reset-timer");
  tray.querySelector(".qiaomu-reader-timerbtn").click();
  assert.equal(reader._running, true);
  plugin.today = 600;
  tray.querySelector(".qiaomu-reader-timer-reset").click();
  assert.equal(plugin.today, 0);
  assert.equal(reader._running, false);
  assert.deepEqual(notices, ["timer-reset"]);
  timer.updateGoalBar(reader);
  assert.equal(reader.goalFillEl.style.width, "0%");
  assert.match(reader.goalTxtEl.textContent, /^0-of-1-min-2:0,15,0$/);
  plugin.today = plugin.goal;
  timer.updateGoalBar(reader);
  assert.equal(reader.goalFillEl.style.width, "100%");
  assert.equal(reader.goalWrapEl.classList.contains("qiaomu-reader-goal-done"), true);
});

test("toggle explains a disabled timer instead of starting it", () => {
  const { timer, plugin, reader, notices } = setup();
  plugin.settings.timerEnabled = false;
  timer.toggle(reader);
  assert.deepEqual(notices, ["timer-is-off-enable-it-in-reading-settings"]);
  assert.equal(reader._running, undefined);
});

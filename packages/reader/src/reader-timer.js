// Reading-time tracking: one interval per open reader accrues seconds into the
// plugin day/lifetime logs, flushing every TIMER_FLUSH_TICKS ticks and once when
// the daily goal is first reached. The host injects notices and the timer clock.
import { svgIcon } from "./reader-icons.js";

export function createReaderTimer({ translate, notice, window }) {
  const TIMER_TICK_MS = 1000;
  const TIMER_FLUSH_TICKS = 15;

  function tick(reader) {
    const plugin = reader.plugin;
    if (!plugin.settings.timerEnabled) { pause(reader); return; }
    plugin.bumpReadingTime(1);
    reader._sessionSec = (reader._sessionSec ?? 0) + 1;
    reader._flushAcc = (reader._flushAcc ?? 0) + 1;
    if (reader._flushAcc >= TIMER_FLUSH_TICKS) { reader._flushAcc = 0; plugin.flushReadingTime(); }
    updateButton(reader);
    updateGoalBar(reader);
    if (!reader._goalNotified && plugin.getTodaySeconds() >= plugin.getGoalSeconds()) {
      reader._goalNotified = true;
      plugin.flushReadingTime();
      const goalHitNotice = translate("today-s-reading-goal-reached");
      notice(goalHitNotice);
    }
  }

  function start(reader) {
    if (reader._timer || !reader.plugin.settings.timerEnabled) return;
    reader._running = true; reader._timerStarted = true; reader._flushAcc = 0;
    reader._timer = window.setInterval(() => tick(reader), TIMER_TICK_MS);
    updateButton(reader);
  }

  function pause(reader) {
    if (reader._timer) {
      window.clearInterval(reader._timer);
      reader._timer = null;
    }
    reader._running = false;
    reader.plugin?.flushReadingTime();
    updateButton(reader);
  }

  function toggle(reader) {
    if (!reader.plugin.settings.timerEnabled) {
      notice(translate(
        "timer-is-off-enable-it-in-reading-settings"));
      return;
    }
    if (reader._running) pause(reader);
    else start(reader);
  }

  function stop(reader) {
    pause(reader);
  }

  function reset(reader) {
    if (!reader.plugin.settings.timerEnabled) return;
    pause(reader);
    reader.plugin.resetTodaySeconds();
    reader.plugin.flushReadingTime();
    reader._goalNotified = false;
    updateButton(reader);
    updateGoalBar(reader);
    const resetNotice = translate("timer-reset");
    notice(resetNotice);
  }

  function updateButton(reader) {
    const btn = reader.timerBtnEl;
    if (!btn) return;
    const plugin = reader.plugin;
    const sessionActive = reader._running || reader._timerStarted;
    if (!plugin.settings.timerEnabled || !sessionActive) { btn.addClass("qiaomu-reader-hidden"); return; }
    btn.removeClass("qiaomu-reader-hidden");
    const remain = Math.max(0, plugin.getGoalSeconds() - plugin.getTodaySeconds());
    const goalDone = remain <= 0;
    const mm = Math.floor(remain / 60);
    const ss = remain % 60;
    btn.classList.toggle("qiaomu-reader-timer-run", !!reader._running && !goalDone);
    btn.classList.toggle("qiaomu-reader-timer-done", goalDone);
    if (reader.timerIconEl) svgIcon(reader.timerIconEl, goalDone ? "check" : (reader._running ? "pause" : "play"));
    if (reader.timerLabelEl) reader.timerLabelEl.setText(`${mm}:${String(ss).padStart(2, "0")}`);
  }

  function updateGoalBar(reader) {
    const wrap = reader.goalWrapEl;
    if (!wrap) return;
    const plugin = reader.plugin;
    if (!plugin.settings.timerEnabled) { wrap.addClass("qiaomu-reader-hidden"); return; }
    wrap.removeClass("qiaomu-reader-hidden");
    const done = plugin.getTodaySeconds();
    const goal = plugin.getGoalSeconds();
    const pct = Math.min(100, Math.round((done / goal) * 100));
    const readMinutes = Math.floor(done / 60);
    reader.goalFillEl.style.width = pct + "%";
    const goalReached = done >= goal;
    wrap.classList.toggle("qiaomu-reader-goal-done", goalReached);
    reader.goalTxtEl.setText(goalReached
      ? translate("goal-reached-0-min-today", (readMinutes))
      : translate("0-of-1-min-2", (readMinutes), (plugin.settings.dailyGoalMin || 15), (pct)));
  }

  function buildButton(tray, view) {
    view.timerBtnEl = tray.createEl("button", { cls: "qiaomu-reader-timerbtn", attr: { type: "button" } });
    view.timerIconEl = view.timerBtnEl.createDiv("qiaomu-reader-timer-ic");
    view.timerLabelEl = view.timerBtnEl.createDiv("qiaomu-reader-timer-label");
    view.timerResetEl = view.timerBtnEl.createDiv("qiaomu-reader-timer-reset");
    svgIcon(view.timerResetEl, "rotate-ccw");
    view.timerResetEl.setAttribute("aria-label", translate("reset-timer"));
    view.timerResetEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      reset(view);
    });
    view.timerBtnEl.setAttribute("aria-label", translate("timer-time-left-to-the-goal-start-pause"));
    view.timerBtnEl.addEventListener("click", () => toggle(view));
    updateButton(view);
  }

  return { tick, start, pause, toggle, stop, reset, updateButton, updateGoalBar, buildButton };
}

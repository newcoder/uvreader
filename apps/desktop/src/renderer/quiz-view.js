import { ItemView, Notice, setIcon } from "obsidian";
import { createQuizStore, quizManifestHash, quizPaperKey, quizQuestionKey } from "../../../../packages/reader/src/quiz-store.js";
import { quizLayoutStyle } from "../../../../packages/reader/src/quiz-manifest.js";
import { gradeQuizAttempt } from "../../../../packages/reader/src/quiz-grade.js";
import { buildQuizAiContext } from "../../../../packages/reader/src/quiz-context.js";
import { visibleRegion } from "../../../../packages/reader/src/reader-shot.js";

const AI_CHAT_VIEW_TYPE = "qiaomu-book-reader-ai-chat";

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function bridgeScript() {
  return `<script data-qbr-quiz-host>(function(){
    function send(type, payload){
      parent.postMessage(Object.assign({ source: 'qbr-quiz', type: type }, payload || {}), '*');
    }
    function manifest(){
      try { return JSON.parse(document.getElementById('quiz-manifest').textContent || ''); }
      catch (error) { return null; }
    }
    function questionId(target){
      var node = target && target.closest ? target.closest('[data-quiz-id]') : null;
      return node ? node.getAttribute('data-quiz-id') : '';
    }
    function questionCard(id){
      var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-quiz-id]')).filter(function(node){
        return node.getAttribute('data-quiz-id') === id;
      });
      var structural = nodes.filter(function(node){
        if (/^(INPUT|TEXTAREA|BUTTON|LABEL|OPTION)$/i.test(node.tagName)) return false;
        return node.classList.contains('q-card') || node.classList.contains('q')
          || node.querySelector('[data-quiz-stem],.stem');
      });
      return structural[0] || nodes.filter(function(node){
        return !/^(INPUT|TEXTAREA|BUTTON|LABEL|OPTION)$/i.test(node.tagName);
      })[0] || nodes[0] || null;
    }
    function answerFor(id){
      var card = questionCard(id);
      if (!card) return '';
      var chosen = Array.prototype.slice.call(card.querySelectorAll('.opt.selected,.option.selected,.opt.sel,.option.sel,.tf-btn.selected')).map(function(node){
        return node.getAttribute('data-value')
          || (node.querySelector && node.querySelector('input[data-value]')?.getAttribute('data-value'))
          || '';
      }).filter(Boolean);
      if (!chosen.length) {
        chosen = Array.prototype.slice.call(card.querySelectorAll('.opt input:checked,.option input:checked')).map(function(input){
          var holder = input.closest('.opt,.option') || input.parentElement;
          return (holder && holder.getAttribute('data-value')) || input.getAttribute('data-value') || input.value || '';
        });
      }
      chosen = chosen.filter(Boolean);
      if (chosen.length) return chosen.join('');
      var blanks = Array.prototype.slice.call(card.querySelectorAll('.blank-input'));
      if (blanks.length) return blanks.map(function(input){ return input.value.trim(); }).join(' | ');
      var input = card.querySelector('textarea.answer-area,.short-input,.code-input');
      return input ? input.value : '';
    }
    function answers(){
      var result = {};
      var ids = [];
      document.querySelectorAll('[data-quiz-id]').forEach(function(node){
        var id = node.getAttribute('data-quiz-id');
        if (id && ids.indexOf(id) === -1) ids.push(id);
      });
      ids.forEach(function(id){ result[id] = answerFor(id); });
      return result;
    }
    function submitText(node){
      return String(node && node.textContent || '').trim();
    }
    var restoring = false;
    function submitButton(){
      var buttons = document.querySelectorAll('button,[role="button"]');
      for (var i = 0; i < buttons.length; i += 1) {
        if (/交卷|提交/.test(submitText(buttons[i]))) return buttons[i];
      }
      return null;
    }
    function numberFrom(node){
      if (!node) return null;
      var value = String(node.textContent || "").replace(/,/g, "").match(/-?\\d+(?:\\.\\d+)?/);
      return value ? Number(value[0]) : null;
    }
    function secondsFrom(node){
      if (!node) return null;
      var value = String(node.textContent || "").trim().match(/(\\d+)\\s*[:：]\\s*(\\d+)(?:\\s*[:：]\\s*(\\d+))?/);
      if (!value) return null;
      return value[3] == null
        ? Number(value[1]) * 60 + Number(value[2])
        : Number(value[1]) * 3600 + Number(value[2]) * 60 + Number(value[3]);
    }
    function pageResult(){
      var scoreNode = document.querySelector('#scoreText,#total-score,#totalScore,#gotScore,#score-value,#score,[data-quiz-score]');
      if (!scoreNode) return { score: null, scoreTotal: null, elapsedSec: null };
      return {
        score: numberFrom(scoreNode),
        scoreTotal: numberFrom(document.querySelector('#scoreTotal,#totalScoreText,#max-score,#total-score-total')),
        elapsedSec: secondsFrom(document.querySelector('#timerText,#timer,.timer b,.timer'))
      };
    }
    document.addEventListener('click', function(event){
      var target = event.target;
      var id = questionId(target);
      if (id) send('question', { id: id });
      var option = target && target.closest ? target.closest('.opt,.option') : null;
      if (option) setTimeout(function(){ send('answer', { id: questionId(option), value: answerFor(questionId(option)) }); }, 0);
      var button = target && target.closest ? target.closest('button,[role="button"]') : null;
      if (!button || restoring) return;
      var text = submitText(button);
      if (/交卷|提交/.test(text)) setTimeout(function(){
        var result = pageResult();
        send('submit', {
          answers: answers(),
          check: window.__QBR_QUIZ_MANIFEST_CHECK__ || null,
          score: result.score,
          scoreTotal: result.scoreTotal,
          elapsedSec: result.elapsedSec
        });
      }, 120);
      if (/重新答题|重新作答|重置|重做/.test(text)) setTimeout(function(){ send('reset', { check: window.__QBR_QUIZ_MANIFEST_CHECK__ || null }); }, 120);
    }, true);
    document.addEventListener('input', function(event){
      var id = questionId(event.target);
      if (id) send('answer', { id: id, value: answerFor(id) });
    }, true);
    var selectionTimer = null;
    function selectedText(){
      var selection = window.getSelection ? window.getSelection() : null;
      return selection ? String(selection).replace(/\\s+/g, ' ').trim().slice(0, 4000) : '';
    }
    function reportSelection(){
      var selection = window.getSelection ? window.getSelection() : null;
      var node = selection && selection.anchorNode ? selection.anchorNode : null;
      var parent = node && node.nodeType === 1 ? node : node && node.parentElement;
      send('selection', {
        text: selectedText(),
        id: parent && parent.closest ? (parent.closest('[data-quiz-id]')?.getAttribute('data-quiz-id') || '') : ''
      });
    }
    document.addEventListener('mouseup', function(){ clearTimeout(selectionTimer); selectionTimer = setTimeout(reportSelection, 20); }, true);
    document.addEventListener('selectionchange', function(){ clearTimeout(selectionTimer); selectionTimer = setTimeout(reportSelection, 80); }, true);
    window.addEventListener('message', function(event){
      if (event.source !== parent) return;
      var data = event.data;
      if (!data || data.source !== 'qbr-quiz-host' || data.type !== 'restore') return;
      Object.keys(data.answers || {}).forEach(function(id){
        var value = data.answers[id];
        var card = questionCard(id);
        if (!card) return;
        var raw = String(value == null ? '' : value);
        if (!raw && card.querySelector('.opt,.option,.tf-btn')) return;
        var trueFalse = Array.prototype.slice.call(card.querySelectorAll('.tf-btn'));
        if (trueFalse.length) {
          trueFalse.forEach(function(button){
            var option = String(button.getAttribute('data-value') || '');
            var label = submitText(button);
            if (raw === option || raw === label || raw.indexOf(option) >= 0 || raw.indexOf(label) >= 0) button.click();
          });
          return;
        }
        var options = Array.prototype.slice.call(card.querySelectorAll('.opt,.option'));
        if (options.length) {
          options.forEach(function(option){
            var optionValue = option.getAttribute('data-value')
              || (option.querySelector && option.querySelector('input[data-value]')?.getAttribute('data-value'))
              || '';
            if (optionValue && raw.indexOf(optionValue) >= 0) option.click();
          });
          return;
        }
        var blanks = Array.prototype.slice.call(card.querySelectorAll('.blank-input'));
        if (blanks.length) {
          var parts = raw.split(/\\s*\\|\\s*/);
          blanks.forEach(function(input, index){
            input.value = parts.length > 1 ? (parts[index] || '') : (index === 0 ? raw : '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          return;
        }
        var input = card.querySelector('textarea.answer-area,.short-input,.code-input');
        if (input) {
          input.value = raw;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      if (data.submitted) {
        restoring = true;
        setTimeout(function(){
          var button = submitButton();
          if (!button) {
            restoring = false;
            return;
          }
          button.click();
          setTimeout(function(){
            var result = pageResult();
            send('result', {
              score: result.score,
              scoreTotal: result.scoreTotal,
              elapsedSec: result.elapsedSec
            });
            restoring = false;
          }, 120);
        }, 80);
      }
    });
    send('ready', {
      manifest: manifest(),
      check: window.__QBR_QUIZ_MANIFEST_CHECK__ || null,
      title: document.title || ''
    });
  })();</script>`;
}

export function withHostBridge(html, { offline = false } = {}) {
  const bridge = bridgeScript();
  // Older AI pages may carry an older, stricter guard. Replace it on the
  // transient host copy so one bad script cannot block an otherwise valid page.
  let source = String(html || "").replace(
    /<script\b[^>]*\bdata-quiz-manifest-guard[^>]*>[\s\S]*?<\/script\s*>/gi,
    "",
  );
  if (offline) {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: file:; font-src data: file:; media-src data: blob: file:; connect-src 'none';">`;
    source = /<head\b[^>]*>/i.test(source)
      ? source.replace(/<head\b[^>]*>/i, (tag) => `${tag}${csp}`)
      : `${csp}${source}`;
  }
  // The manifest guard is a build-time content check. In the reader it is
  // noise (and older pages can flag harmless math formatting); the host bridge
  // and stored grading still handle the page. Keep the layout fix, not the
  // red data banner.
  const injection = `${quizLayoutStyle()}${bridge}`;
  return /<\/body>/i.test(source) ? source.replace(/<\/body>/i, `${injection}</body>`) : `${source}${injection}`;
}

export function createQuizView(leaf, { app, plugin } = {}) {
  class QuizView extends ItemView {
    constructor(hostLeaf) {
      super(hostLeaf);
      this.path = "";
      this.manifest = null;
      this.activeId = "";
      this.answers = new Map();
      this._iframe = null;
      this._preparedPath = "";
      this._store = null;
      this._saveTimer = null;
      this._submitted = false;
      this._startedAt = 0;
      this._selectionText = "";
      this._injectedSelection = "";
      this._closing = false;
      this.areaEl = null;
      this.paperKey = "";
      this.paper = null;
      this.questionKeys = {};
      this._onMessage = this._onMessage.bind(this);
    }

    getViewType() {
      return "qbr-quiz";
    }

    getDisplayText() {
      return this.path.split("/").pop()?.replace(/\.html?$/i, "") || "答题页";
    }

    getIcon() {
      return "file-text";
    }

    setState(state) {
      this.path = String(state?.path || this.path || "");
      if (this.contentEl?.isConnected) void this.render();
    }

    async onOpen() {
      this.contentEl.addClass("qbr-quiz-view");
      this._store = createQuizStore({
        adapter: app.vault.adapter,
        root: plugin?._readingRoot?.() || "reading",
      });
      window.addEventListener("message", this._onMessage);
      await this.render();
    }

    async _flushDraft() {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      if (!this._store || !this.paperKey || this._submitted) return;
      await this._store.saveDraft(this.paperKey, {
        startedAt: this._startedAt,
        answers: Object.fromEntries(this.answers),
        manifestHash: this.manifest ? quizManifestHash(this.manifest) : "",
        updatedAt: Date.now(),
      }).catch(() => {});
    }

    async onClose() {
      window.removeEventListener("message", this._onMessage);
      await this._flushDraft();
      await this._store?.drain?.().catch(() => {});
      await this._discardPrepared();
      this._iframe = null;
      this.manifest = null;
      this.contentEl.empty();
    }

    async _discardPrepared() {
      const file = this._preparedPath;
      this._preparedPath = "";
      if (!file) return;
      try { await window.qbrDesktop?.quiz?.discard?.(file); } catch { /* temp cleanup is best effort */ }
    }

    _relativePath() {
      const value = normalizePath(this.path);
      const root = normalizePath(window.qbrDesktop?.paths?.vaultRoot || "");
      return root && value.toLowerCase().startsWith(`${root.toLowerCase()}/`)
        ? value.slice(root.length + 1)
        : value;
    }

    async _readHtml() {
      const relative = this._relativePath();
      const file = app.vault.getAbstractFileByPath(relative);
      if (file) return app.vault.read(file);
      try {
        return await app.vault.adapter.read(relative);
      } catch {
        throw new Error(`找不到答题页：${this.path}`);
      }
    }

    _onMessage(event) {
      if (event.source !== this._iframe?.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== "qbr-quiz") return;
      if (data.type === "ready") {
        this.manifest = data.manifest || null;
        this.activeId = this.manifest?.questions?.[0]?.id || "";
        this.questionKeys = Object.fromEntries((this.manifest?.questions || []).map((question) => [question.id, quizQuestionKey(question)]));
        this.paperKey = quizPaperKey({
          sourcePath: this.manifest?.source?.path || "",
          htmlPath: this.path,
          manifest: this.manifest,
        });
        this._startedAt = Date.now();
        this._submitted = false;
        this._selectionText = "";
        this._injectedSelection = "";
        this._setStatus(data.check?.ok === false
          ? `内容提示：${(data.check.errors || []).slice(0, 2).join("；")}`
          : this.manifest?.questions?.length
            ? `${this.manifest.questions.length} 道题`
            : "答题页");
        this._syncAiButton();
        this._closeAi();
        void this._loadPaper();
      } else if (data.type === "question") {
        this.activeId = String(data.id || "");
        this._syncAiButton();
      } else if (data.type === "answer") {
        this.answers.set(String(data.id || ""), String(data.value || ""));
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
          this._saveTimer = null;
          void this._flushDraft();
        }, 450);
      } else if (data.type === "selection") {
        const text = String(data.text || "").trim();
        this._selectionText = text;
        if (text && this._submitted) this._syncSelectionToAi(text, String(data.id || ""));
      } else if (data.type === "submit") {
        if (data.check?.ok === false) {
          new Notice(`答题页内容有提示：${(data.check.errors || []).slice(0, 2).join("；")}`);
        }
        void this._submitAttempt(data.answers || {}, {
          pageScore: data.score,
          pageScoreTotal: data.scoreTotal,
          elapsedSec: data.elapsedSec,
        });
      } else if (data.type === "result") {
        if (this._submitted) void this._updateAttemptResult(data);
      } else if (data.type === "reset") {
        this.answers.clear();
        this._startedAt = Date.now();
        this._submitted = false;
        this._selectionText = "";
        this._injectedSelection = "";
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = null;
        this._closeAi();
        this._syncAiButton();
        void this._store?.clearDraft?.(this.paperKey).catch(() => {});
        this._setStatus("已重新开始");
      }
    }

    async _loadPaper() {
      if (!this._store || !this.paperKey || !this.manifest) return;
      try {
        const paper = await this._store.ensurePaper(this.paperKey, {
          title: this.manifest.title || this.getDisplayText(),
          source: this.manifest.source || null,
          htmlPath: this.path,
          manifestHash: quizManifestHash(this.manifest),
        });
        this.paper = paper;
        const manifestHash = quizManifestHash(this.manifest);
        const draft = paper.draft?.manifestHash === manifestHash ? paper.draft : null;
        const last = paper.attempts?.[paper.attempts.length - 1];
        const draftAnswers = Object.fromEntries(Object.entries(draft?.answers || {}));
        if (Object.keys(draftAnswers).length) {
          this.answers = new Map(Object.entries(draftAnswers));
          this._startedAt = Number(draft.startedAt) || Date.now();
          this._submitted = false;
          this._postToFrame({
            source: "qbr-quiz-host",
            type: "restore",
            answers: draftAnswers,
          });
          this._setStatus("已恢复上次未完成的作答");
        } else if (last?.summary) {
          const answers = {};
          if (!last.manifestHash || last.manifestHash === manifestHash) {
            for (const [id, key] of Object.entries(this.questionKeys)) {
              const saved = last.answers?.[key];
              if (saved && typeof saved === "object" && "value" in saved) answers[id] = String(saved.value ?? "");
              else if (typeof saved === "string") answers[id] = saved;
            }
          }
          const restored = Object.values(answers).some((value) => String(value || "").trim());
          this.answers = new Map(Object.entries(answers));
          this._startedAt = Number(last.startedAt) || Date.now();
          this._submitted = true;
          this._syncAiButton();
          // Even an older attempt without stored answer details should reopen in
          // the graded state, so the page can show the standard answers and
          // analysis instead of a blank paper.
          this._postToFrame({
            source: "qbr-quiz-host",
            type: "restore",
            answers,
            submitted: true,
          });
          this._setStatus(restored
            ? `已恢复上次交卷 · ${last.pageScore != null ? `${last.pageScore}${last.pageScoreTotal > 0 ? ` / ${last.pageScoreTotal}` : ""} 分` : `${last.summary.score}%`} · 答对 ${last.summary.correct} · 错题 ${last.summary.wrong}`
            : `上次 ${last.pageScore != null ? `${last.pageScore}${last.pageScoreTotal > 0 ? ` / ${last.pageScoreTotal}` : ""} 分` : `${last.summary.score}%`} · 作答明细未保存`);
          const chatPath = this._bookFile()?.path || "";
          const hasChat = plugin?.settings?.aiEnabled !== false && Boolean(chatPath)
            && (plugin?.settings?.aiChatHistory || []).some((chat) => {
            const bookPath = String(chat?.bookPath || "").replace(/\\/g, "/").toLowerCase();
            return bookPath === chatPath.replace(/\\/g, "/").toLowerCase();
          });
          if (hasChat) {
            window.setTimeout(() => {
              if (this._submitted && !this._closing && this.contentEl?.isConnected) {
                void this._askAi({ automatic: true });
              }
            }, 160);
          }
        }
      } catch (error) {
        this._setStatus(`记录读取失败：${String(error?.message || error)}`);
      }
    }

    _postToFrame(message) {
      try { this._iframe?.contentWindow?.postMessage(message, "*"); } catch { /* frame may be closing */ }
    }

    aiPageRegion() {
      if (!this._iframe?.isConnected || !this.areaEl?.isConnected) return null;
      return visibleRegion(this._iframe, this.areaEl);
    }

    async _submitAttempt(rawAnswers = {}, result = {}) {
      if (!this._store || !this.paperKey || !this.manifest) return;
      const answers = { ...Object.fromEntries(this.answers), ...rawAnswers };
      this.answers = new Map(Object.entries(answers));
      const graded = gradeQuizAttempt({
        manifest: this.manifest,
        answers,
        questionKeys: this.questionKeys,
      });
      const number = (value) => {
        if (value == null || value === "") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const pageScore = number(result.pageScore);
      const rawPageTotal = number(result.pageScoreTotal);
      const pageScoreTotal = rawPageTotal != null && rawPageTotal > 0 ? rawPageTotal : null;
      const submittedAt = Date.now();
      const hostDuration = Math.max(0, Math.round((submittedAt - (this._startedAt || submittedAt)) / 1000));
      const pageDuration = number(result.elapsedSec);
      this._submitted = true;
      try {
        await this._store.submitAttempt(this.paperKey, {
          attemptId: `attempt-${submittedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          startedAt: this._startedAt || submittedAt,
          submittedAt,
          durationSec: pageDuration == null ? hostDuration : Math.max(0, Math.round(pageDuration)),
          manifestHash: quizManifestHash(this.manifest),
          pageScore,
          pageScoreTotal,
          answers: graded.answers,
          summary: graded.summary,
        });
        this.paper = (await this._store.loadPaper(this.paperKey)).paper || this.paper;
        const scoreLabel = pageScore == null
          ? `${graded.summary.score}%`
          : `${pageScore}${pageScoreTotal ? ` / ${pageScoreTotal}` : ""} 分`;
        this._setStatus(`已交卷 · ${scoreLabel} · 答对 ${graded.summary.correct} · 错题 ${graded.summary.wrong}`);
        this._syncAiButton();
        void this._askAi({ automatic: true });
      } catch (error) {
        this._submitted = false;
        this._syncAiButton();
        this._setStatus(`记录保存失败：${String(error?.message || error)}`);
      }
    }

    async _updateAttemptResult(result = {}) {
      if (!this._store || !this.paperKey || !this.paper?.attempts?.length) return;
      if (result.score == null || result.score === "") return;
      const pageScore = Number(result.score);
      if (!Number.isFinite(pageScore)) return;
      const rawTotal = result.scoreTotal == null || result.scoreTotal === "" ? null : Number(result.scoreTotal);
      const pageScoreTotal = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : null;
      const last = this.paper.attempts[this.paper.attempts.length - 1];
      if (last.pageScore === pageScore && (pageScoreTotal == null || last.pageScoreTotal === pageScoreTotal)) return;
      try {
        const updated = await this._store.updateAttemptResult(this.paperKey, {
          attemptId: last.attemptId,
          pageScore,
          pageScoreTotal,
        });
        if (!updated) return;
        this.paper = (await this._store.loadPaper(this.paperKey)).paper || this.paper;
        const summary = last.summary || {};
        const label = `${pageScore}${pageScoreTotal ? ` / ${pageScoreTotal}` : ""} 分`;
        this._setStatus(`已恢复上次交卷 · ${label} · 答对 ${summary.correct || 0} · 错题 ${summary.wrong || 0}`);
      } catch {
        // The page still shows the restored result even if the index write fails.
      }
    }

    _setStatus(text) {
      if (this.statusEl) this.statusEl.setText(String(text || ""));
    }

    _closeAi() {
      try { plugin?.closeReadingCompanion?.(); } catch { /* the sidebar may be closing already */ }
    }

    _syncAiButton() {
      if (!this.aiBtn) return;
      const question = this.manifest?.questions?.find((item) => item.id === this.activeId);
      const enabled = Boolean(question) && this._submitted;
      this.aiBtn.disabled = !enabled;
      this.aiBtn.setAttribute("aria-disabled", String(!enabled));
      this.aiBtn.setAttribute("aria-label", enabled ? "问 AI" : "交卷后可问 AI");
    }

    _bookFile() {
      const relative = this._relativePath();
      return app?.vault?.getAbstractFileByPath?.(relative) || null;
    }

    _aiContext(questionId = this.activeId) {
      const question = this.manifest?.questions?.find((item) => item.id === questionId)
        || this.manifest?.questions?.find((item) => item.id === this.activeId);
      if (!question) return null;
      return {
        kind: "selection",
        label: `答题页 · ${question.number || question.id}`,
        text: buildQuizAiContext(this.manifest, {
          currentId: question.id,
          submitted: this._submitted,
          answers: Object.fromEntries(this.answers),
        }),
        readerView: this,
        bookFile: this._bookFile(),
      };
    }

    // Keep only the latest selection in the composer. Replace the block from
    // the previous selection instead of appending every new one; a question
    // the reader typed before it stays in place.
    _injectSelection(chat, text) {
      const input = chat?.inputEl;
      if (!input || !text) return;
      const current = String(input.value || "");
      const previous = this._injectedSelection;
      let next = current;
      if (!current.trim()) {
        next = text;
      } else if (previous && current.includes(previous)) {
        if (previous === text) return;
        const at = current.lastIndexOf(previous);
        next = `${current.slice(0, at)}${text}${current.slice(at + previous.length)}`;
      } else if (!current.includes(text)) {
        next = `${current.trimEnd()}\n\n${text}`;
      } else {
        return;
      }
      this._injectedSelection = text;
      if (next === current) return;
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus?.();
    }

    _syncSelectionToAi(text = this._selectionText, questionId = this.activeId) {
      if (!this._submitted || !text) return;
      const leaf = app?.workspace?.getLeavesOfType?.(AI_CHAT_VIEW_TYPE)?.[0];
      const chat = leaf?.view;
      if (!chat || typeof chat.setContext !== "function") return;
      const context = this._aiContext(questionId);
      if (!context) return;
      chat.setContext(context, { selection: true, silent: true, focusInput: false });
      this._injectSelection(chat, text);
    }

    async _askAi(options = {}) {
      if (!this._submitted || typeof plugin?.openAiChat !== "function") return;
      const context = this._aiContext();
      if (!context) return;
      try {
        await plugin.openAiChat(context, { automatic: options.automatic === true });
      } catch (error) {
        new Notice(`AI 打开失败：${String(error?.message || error)}`);
        return;
      }
      if (!this._selectionText) return;
      const chat = app?.workspace?.getLeavesOfType?.(AI_CHAT_VIEW_TYPE)?.[0]?.view;
      this._injectSelection(chat, this._selectionText);
    }

    async render() {
      await this._discardPrepared();
      this.answers.clear();
      this.manifest = null;
      this.activeId = "";
      this.paperKey = "";
      this.paper = null;
      this.questionKeys = {};
      this._submitted = false;
      this._selectionText = "";
      this._injectedSelection = "";
      this._closing = false;
      this._iframe = null;
      const host = this.contentEl;
      this.areaEl = host;
      host.empty();
      const head = host.createDiv("qbr-quiz-head");
      const title = head.createDiv("qbr-quiz-title");
      title.createEl("strong", { text: this.getDisplayText() });
      this.statusEl = title.createSpan({ cls: "qbr-quiz-status" });
      const actions = head.createDiv("qbr-quiz-actions");
      this.aiBtn = actions.createEl("button", {
        cls: "qbr-quiz-action",
        text: "问 AI",
        attr: { type: "button", "aria-label": "交卷后可问 AI" },
      });
      this.aiBtn.disabled = true;
      this.aiBtn.addEventListener("click", () => void this._askAi());
      const reload = actions.createEl("button", { cls: "qbr-quiz-action", attr: { type: "button", "aria-label": "重新加载" } });
      setIcon(reload, "rotate-ccw");
      reload.addEventListener("click", () => void this.render());
      const close = actions.createEl("button", {
        cls: "qbr-quiz-action",
        attr: { type: "button", "aria-label": "关闭并返回答题页" },
      });
      setIcon(close, "x");
      close.addEventListener("click", async () => {
        if (this._closing) return;
        this._closing = true;
        try {
          await this._flushDraft();
          await this._store?.drain?.().catch(() => {});
          this._closeAi();
          await window.qbrOpenQuizList?.();
        } finally {
          this.leaf.detach();
        }
      });

      const body = host.createDiv("qbr-quiz-body");
      try {
        const html = await this._readHtml();
        const prepared = await window.qbrDesktop?.quiz?.prepare?.(withHostBridge(html));
        if (!prepared?.ok || !prepared.url) throw new Error(String(prepared?.error || "无法准备答题页"));
        this._preparedPath = prepared.path || "";
        const frame = body.createEl("iframe", {
          cls: "qbr-quiz-frame",
          attr: {
            sandbox: "allow-scripts",
            title: this.getDisplayText(),
            referrerpolicy: "no-referrer",
          },
        });
        this._iframe = frame;
        this._setStatus("正在加载…");
        frame.src = prepared.url;
      } catch (error) {
        this._setStatus("");
        body.createDiv("qbr-quiz-error").setText(String(error?.message || error));
      }
    }
  }
  return new QuizView(leaf);
}

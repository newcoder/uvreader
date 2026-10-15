// 滚动模式的「堆叠渲染」补丁:让相邻章节留在同一个滚动容器里,滚动跨章时不再
// 「换文档、跳回顶部」,而是像同一篇文章一样接下去(foliate 默认一次只挂一节)。
//
// 只影响 flow="scrolled"(滚动模式);分页模式一行逻辑都不动。重装 node_modules 会
// 还原,本脚本随 postinstall 重新打上。每处改动都有唯一标记,便于幂等与排查。
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "node_modules", "foliate-js", "paginator.js");
const text = fs.readFileSync(file, "utf8");

const patches = [];
const add = (name, from, to, marker) => patches.push({ name, from, to, marker });

// 1. 字段:堆叠表(index → view)。
add("field",
  ["    #view", "    #vertical = false"].join("\n"),
  [
    "    #view",
    "    // UV Reader: scrolled mode keeps the previous section mounted (see #stack).",
    "    #stack = new Map()",
    "    #vertical = false",
  ].join("\n"),
  "#stack = new Map()");

// 2. #createView:滚动模式「接着往下挂」而不是替换。
add("createView",
  [
    "    #createView() {",
    "        if (this.#view) {",
    "            this.#view.destroy()",
    "            this.#container.removeChild(this.#view.element)",
    "        }",
    "        this.#view = new View({",
    "            container: this,",
    "            onExpand: () => this.#scrollToAnchor(this.#anchor),",
    "        })",
    "        this.#container.append(this.#view.element)",
    "        return this.#view",
    "    }",
  ].join("\n"),
  [
    "    #createView(keepPrevious = false) {",
    "        // UV Reader: keepPrevious is the scrolled-mode \"continue below\" case -",
    "        // the previous section stays mounted and the new one is appended after it.",
    "        if (!keepPrevious) {",
    "            for (const entry of this.#stack.values()) {",
    "                try { entry.view.destroy() } catch { /* already gone */ }",
    "                try { this.#container.removeChild(entry.view.element) } catch { /* already gone */ }",
    "            }",
    "            this.#stack.clear()",
    "            if (this.#view) {",
    "                try { this.#view.destroy() } catch { /* already gone */ }",
    "                try { this.#container.removeChild(this.#view.element) } catch { /* already gone */ }",
    "            }",
    "        }",
    "        this.#view = new View({",
    "            container: this,",
    "            onExpand: () => this.#scrollToAnchor(this.#anchor),",
    "        })",
    "        this.#container.append(this.#view.element)",
    "        return this.#view",
    "    }",
  ].join("\n"),
  "#createView(keepPrevious = false)");

// 3. #display:往前翻的那一节接在当前节下面,并记进堆叠表。
add("display-head",
  [
    "    async #display(promise) {",
    "        const { index, src, anchor, onLoad, select } = await promise",
    "        this.#index = index",
    "        const hasFocus = this.#view?.document?.hasFocus()",
    "        if (src) {",
    "            const view = this.#createView()",
  ].join("\n"),
  [
    "    async #display(promise) {",
    "        const { index, src, anchor, onLoad, select } = await promise",
    "        const previousIndex = this.#index",
    "        this.#index = index",
    "        const hasFocus = this.#view?.document?.hasFocus()",
    "        if (src) {",
    "            // UV Reader: scrolling forward keeps the current section mounted and",
    "            // appends the new one after it, so the reader continues across the",
    "            // seam instead of landing at the top of a freshly swapped document.",
    "            // Anything else (going back, jumping) replaces it as before.",
    "            const stackForward = this.scrolled && !!this.#view && index === previousIndex + 1",
    "            const view = this.#createView(stackForward)",
  ].join("\n"),
  "const stackForward = this.scrolled && !!this.#view && index === previousIndex + 1");

add("display-stack",
  [
    "            this.#view = view",
    "        }",
    "        await this.scrollToAnchor((typeof anchor === 'function'",
  ].join("\n"),
  [
    "            this.#view = view",
    "            if (this.scrolled) {",
    "                this.#stack.set(index, { view })",
    "                this.#pruneStack(stackForward ? 2 : 1)",
    "            }",
    "        }",
    "        await this.scrollToAnchor((typeof anchor === 'function'",
  ].join("\n"),
  "#pruneStack(stackForward ? 2 : 1)");

// 4. 还挂在屏幕上的那一节不许 unload。
add("unload",
  ["            const onLoad = detail => {", "                this.sections[oldIndex]?.unload?.()"].join("\n"),
  [
    "            const onLoad = detail => {",
    "                // UV Reader: a section that is still mounted (scrolled stack)",
    "                // must not be unloaded - its iframe is on screen.",
    "                if (!this.#stack.has(oldIndex)) this.sections[oldIndex]?.unload?.()",
  ].join("\n"),
  "if (!this.#stack.has(oldIndex))");

// 5. viewSize:滚动模式下可滚动范围是整个堆叠。
add("viewSize",
  ["    get viewSize() {", "        return this.#view.element.getBoundingClientRect()[this.sideProp]", "    }"].join("\n"),
  [
    "    get viewSize() {",
    "        // UV Reader: in scrolled mode the container holds every mounted section,",
    "        // so the scrollable extent is the whole stack, not just this section.",
    "        if (this.scrolled && this.#stack.size > 1) return this.#container.scrollHeight",
    "        return this.#view.element.getBoundingClientRect()[this.sideProp]",
    "    }",
  ].join("\n"),
  "if (this.scrolled && this.#stack.size > 1) return this.#container.scrollHeight");

// 6. 坐标映射:接受指定的节(选区/高亮可能来自堆叠里的另一节),并加上它的偏移。
add("mapper",
  [
    "    #getRectMapper() {",
    "        if (this.scrolled) {",
    "            const size = this.viewSize",
    "            const margin = this.#margin",
    "            return this.#vertical",
    "                ? ({ left, right }) =>",
    "                    ({ left: size - right - margin, right: size - left - margin })",
    "                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })",
    "        }",
  ].join("\n"),
  [
    "    #getRectMapper(view = this.#view) {",
    "        if (this.scrolled) {",
    "            // UV Reader: a stacked section's rects are relative to its own box;",
    "            // add where that box sits in the scrolled content.",
    "            const size = this.#viewOwnSize(view)",
    "            const margin = this.#margin",
    "            const offset = this.#stackOffset(view)",
    "            return this.#vertical",
    "                ? ({ left, right }) =>",
    "                    ({ left: offset + size - right - margin, right: offset + size - left - margin })",
    "                : ({ top, bottom }) => ({ left: offset + top + margin, right: offset + bottom + margin })",
    "        }",
  ].join("\n"),
  "#getRectMapper(view = this.#view)");

add("rect",
  [
    "    async #scrollToRect(rect, reason) {",
    "        if (this.scrolled) {",
    "            const offset = this.#getRectMapper()(rect).left - this.#margin",
    "            return this.#scrollTo(offset, reason)",
    "        }",
  ].join("\n"),
  [
    "    async #scrollToRect(rect, reason) {",
    "        if (this.scrolled) {",
    "            // UV Reader: the rect may come from any mounted section (a selection",
    "            // or a highlight in the neighbour) - map it through its owner view.",
    "            const owner = rect?.startContainer?.ownerDocument || rect?.ownerDocument || null",
    "            const offset = this.#getRectMapper(this.#viewForDoc(owner))(rect).left - this.#margin",
    "            return this.#scrollTo(offset, reason)",
    "        }",
  ].join("\n"),
  "#getRectMapper(this.#viewForDoc(owner))");

// 7. 分数锚点:当前节内 + 该节在堆叠里的偏移。
add("anchor",
  [
    "        if (this.scrolled) {",
    "            await this.#scrollTo(anchor * this.viewSize, reason)",
    "            return",
    "        }",
  ].join("\n"),
  [
    "        if (this.scrolled) {",
    "            // UV Reader: fractions are relative to the section, so add its offset",
    "            // inside the scrolled stack.",
    "            await this.#scrollTo(this.#stackOffset(this.#view) + anchor * this.#viewOwnSize(), reason)",
    "            return",
    "        }",
  ].join("\n"),
  "this.#stackOffset(this.#view) + anchor * this.#viewOwnSize(), reason");

// 8. 可见范围/relocate:按视口所在的那一节算。
add("range",
  [
    "    #getVisibleRange() {",
    "        if (this.scrolled) return getVisibleRange(this.#view.document,",
  ].join("\n"),
  [
    "    #getVisibleRange() {",
    "        // UV Reader: with sections stacked, the range belongs to the section the",
    "        // viewport is inside, not to the last one that happened to be loaded.",
    "        if (this.scrolled) return getVisibleRange(this.#visibleView().document,",
  ].join("\n"),
  "getVisibleRange(this.#visibleView().document,");

add("afterScroll",
  [
    "        const index = this.#index",
    "        const detail = { reason, range, index }",
    "        if (this.scrolled) detail.fraction = this.start / this.viewSize",
  ].join("\n"),
  [
    "        const index = this.scrolled ? this.#visibleIndex() : this.#index",
    "        const detail = { reason, range, index }",
    "        if (this.scrolled) {",
    "            const active = this.#stack.get(index)?.view || this.#view",
    "            detail.fraction = Math.min(1, Math.max(0,",
    "                (this.start - this.#stackOffset(active)) / Math.max(1, this.#viewOwnSize(active))))",
    "        }",
  ].join("\n"),
  "const index = this.scrolled ? this.#visibleIndex() : this.#index");

// 9. getContents:每个还挂着的节都要报出去(高亮/选区/搜索都在)。
add("contents",
  [
    "    getContents() {",
    "        if (this.#view) return [{",
    "            index: this.#index,",
    "            overlayer: this.#view.overlayer,",
    "            doc: this.#view.document,",
    "        }]",
    "        return []",
    "    }",
  ].join("\n"),
  [
    "    getContents() {",
    "        // UV Reader: every mounted section is on screen (highlights, selection,",
    "        // search) - report them all, with the one being read first.",
    "        if (this.#stack.size) {",
    "            const current = this.#visibleIndex()",
    "            return [...this.#stack.entries()]",
    "                .sort((a, b) => (a[0] === current ? -1 : b[0] === current ? 1 : a[0] - b[0]))",
    "                .map(([index, entry]) => ({",
    "                    index,",
    "                    overlayer: entry.view.overlayer,",
    "                    doc: entry.view.document,",
    "                }))",
    "                .filter(item => item.doc)",
    "        }",
    "        if (this.#view) return [{",
    "            index: this.#index,",
    "            overlayer: this.#view.overlayer,",
    "            doc: this.#view.document,",
    "        }]",
    "        return []",
    "    }",
  ].join("\n"),
  "if (this.#stack.size) {\n            const current = this.#visibleIndex()");

// 10. render:窗口/字号变化时,堆叠里每一节都要重排。
add("render",
  [
    "    render() {",
    "        if (!this.#view) return",
    "        this.#view.render(this.#beforeRender({",
    "            vertical: this.#vertical,",
    "            rtl: this.#rtl,",
    "        }))",
    "        this.#scrollToAnchor(this.#anchor)",
    "    }",
  ].join("\n"),
  [
    "    render() {",
    "        if (!this.#view) return",
    "        const layout = this.#beforeRender({",
    "            vertical: this.#vertical,",
    "            rtl: this.#rtl,",
    "        })",
    "        // UV Reader: re-measure every mounted section, or the stack keeps stale",
    "        // heights after a resize and the reader drifts.",
    "        if (this.scrolled && this.#stack.size) {",
    "            for (const entry of this.#stack.values()) entry.view.render(layout)",
    "        } else {",
    "            this.#view.render(layout)",
    "        }",
    "        this.#scrollToAnchor(this.#anchor)",
    "    }",
  ].join("\n"),
  "for (const entry of this.#stack.values()) entry.view.render(layout)");

// 11. 私有辅助:偏移、自身高度、可见节、按文档找节、回收。
add("helpers",
  ["    get scrolled() {", "        return this.getAttribute('flow') === 'scrolled'", "    }"].join("\n"),
  [
    "    // ── UV Reader: stacked scrolled mode helpers ────────────────────────────",
    "    #viewOwnSize(view = this.#view) {",
    "        return view?.element?.getBoundingClientRect?.()[this.sideProp] || 0",
    "    }",
    "    #stackOffset(view) {",
    "        if (!this.scrolled || !view?.element || this.#stack.size <= 1) return 0",
    "        const containerRect = this.#container.getBoundingClientRect()",
    "        const elementRect = view.element.getBoundingClientRect()",
    "        const start = this.#vertical ? 'left' : 'top'",
    "        return (elementRect[start] - containerRect[start]) + this.#container[this.scrollProp]",
    "    }",
    "    #visibleIndex() {",
    "        if (!this.scrolled || this.#stack.size <= 1) return this.#index",
    "        const middle = this.start + this.size / 2",
    "        let best = this.#index",
    "        for (const [index, entry] of this.#stack) {",
    "            const top = this.#stackOffset(entry.view)",
    "            if (top <= middle && middle < top + this.#viewOwnSize(entry.view)) best = index",
    "        }",
    "        return best",
    "    }",
    "    #visibleView() {",
    "        return this.#stack.get(this.#visibleIndex())?.view || this.#view",
    "    }",
    "    #viewForDoc(doc) {",
    "        if (!doc) return this.#view",
    "        for (const entry of this.#stack.values()) {",
    "            if (entry.view.document === doc) return entry.view",
    "        }",
    "        return this.#view",
    "    }",
    "    #pruneStack(max) {",
    "        // Keep the section being read plus at most one neighbour: the reader can",
    "        // still scroll back into it, and the iframes stay cheap. Dropping the",
    "        // oldest never removes what is on screen - reading forward keeps the",
    "        // previous section, and a jump replaces everything anyway.",
    "        while (this.#stack.size > max) {",
    "            const oldest = this.#stack.keys().next().value",
    "            const entry = this.#stack.get(oldest)",
    "            this.#stack.delete(oldest)",
    "            try { entry.view.destroy() } catch { /* already gone */ }",
    "            try { this.#container.removeChild(entry.view.element) } catch { /* already gone */ }",
    "        }",
    "    }",
    "    get scrolled() {",
    "        return this.getAttribute('flow') === 'scrolled'",
    "    }",
  ].join("\n"),
  "#stackOffset(view) {");

// 12. destroy:堆叠一起收拾。
add("destroy",
  ["    destroy() {", "        this.#observer.unobserve(this)", "        this.#view.destroy()", "        this.#view = null"].join("\n"),
  [
    "    destroy() {",
    "        this.#observer.unobserve(this)",
    "        for (const entry of this.#stack.values()) {",
    "            try { entry.view.destroy() } catch { /* already gone */ }",
    "        }",
    "        this.#stack.clear()",
    "        this.#view.destroy()",
    "        this.#view = null",
  ].join("\n"),
  "for (const entry of this.#stack.values()) {\n            try { entry.view.destroy() } catch { /* already gone */ }");

// 13. #goTo/#display 支持「保持视口」:续读时把下一节接在下面,但不把视口推到它的开头
// (否则读者会觉得跳了一屏)。
add("goTo-keepPosition",
  ["    async #goTo({ index, anchor, select }) {",
    "        if (index === this.#index) await this.#display({ index, anchor, select })",
  ].join("\n"),
  ["    async #goTo({ index, anchor, select, keepPosition }) {",
    "        if (index === this.#index) await this.#display({ index, anchor, select, keepPosition })",
  ].join("\n"),
  "#goTo({ index, anchor, select, keepPosition })");

add("goTo-load-keepPosition",
  ["                .then(src => ({ index, src, anchor, onLoad, select }))"].join("\n"),
  ["                .then(src => ({ index, src, anchor, onLoad, select, keepPosition }))"].join("\n"),
  ".then(src => ({ index, src, anchor, onLoad, select, keepPosition }))");

add("display-keepPosition",
  ["        const { index, src, anchor, onLoad, select } = await promise"].join("\n"),
  ["        const { index, src, anchor, onLoad, select, keepPosition } = await promise"].join("\n"),
  "const { index, src, anchor, onLoad, select, keepPosition } = await promise");

add("display-skip-scroll",
  ["        await this.scrollToAnchor((typeof anchor === 'function'"].join("\n"),
  ["        // UV Reader: continueNext() keeps the viewport where it is - the new",
    "        // section was appended below the seam and must not push it down a screen.",
    "        if (!keepPosition) await this.scrollToAnchor((typeof anchor === 'function'"].join("\n"),
  "if (!keepPosition) await this.scrollToAnchor((typeof anchor === 'function'");

add("continue-next",
  ["    nextSection() {",
    "        return this.goTo({ index: this.#adjacentIndex(1) })",
    "    }",
  ].join("\n"),
  ["    nextSection() {",
    "        return this.goTo({ index: this.#adjacentIndex(1) })",
    "    }",
    "    // UV Reader: 滚动模式滚到边缘时用 —— 把下一节接在当前节下面,**不动视口**,",
    "    // 读者继续往下滚才是接着读(而不是跳到下一节开头,那会差一屏)。",
    "    async continueNext() {",
    "        if (this.#locked) return",
    "        this.#locked = true",
    "        const index = this.#adjacentIndex(1)",
    "        if (index != null) await this.#goTo({ index, keepPosition: true })",
    "        this.#locked = false",
    "    }",
  ].join("\n"),
  "async continueNext() {");

// 14. 回收时补偿滚动位置:从视口**上方**摘掉内容后,滚动位置要减去它的高度,
// 否则读者看到的位置会被顶走(实测:续读时视口被推到下一节开头)。
add("prune-compensate",
  ["    #pruneStack(max) {",
    "        // Keep the section being read plus at most one neighbour: the reader can",
    "        // still scroll back into it, and the iframes stay cheap. Dropping the",
    "        // oldest never removes what is on screen - reading forward keeps the",
    "        // previous section, and a jump replaces everything anyway.",
    "        while (this.#stack.size > max) {",
    "            const oldest = this.#stack.keys().next().value",
    "            const entry = this.#stack.get(oldest)",
    "            this.#stack.delete(oldest)",
    "            try { entry.view.destroy() } catch { /* already gone */ }",
    "            try { this.#container.removeChild(entry.view.element) } catch { /* already gone */ }",
    "        }",
    "    }",
  ].join("\n"),
  ["    #pruneStack(max) {",
    "        // Keep the section being read plus at most one neighbour: the reader can",
    "        // still scroll back into it, and the iframes stay cheap.",
    "        while (this.#stack.size > max) {",
    "            const oldest = this.#stack.keys().next().value",
    "            const entry = this.#stack.get(oldest)",
    "            if (!entry) break",
    "            // Removing content above the viewport must not move what the reader",
    "            // sees: take the removed height off the scroll position.",
    "            const removed = this.#viewOwnSize(entry.view)",
    "            this.#stack.delete(oldest)",
    "            try { entry.view.destroy() } catch { /* already gone */ }",
    "            try { this.#container.removeChild(entry.view.element) } catch { /* already gone */ }",
    "            if (removed > 0) this.containerPosition = Math.max(0, this.containerPosition - removed)",
    "        }",
    "    }",
  ].join("\n"),
  "const removed = this.#viewOwnSize(entry.view)");

// 15. onExpand:长在**视口下方**的节(堆叠里的下一章)不许把读者拉回它的锚点 ——
// 那会让「续读」变成"跳到下一节开头"(实测差一屏)。
add("expand-keep",
  ["        this.#view = new View({",
    "            container: this,",
    "            onExpand: () => this.#scrollToAnchor(this.#anchor),",
    "        })",
  ].join("\n"),
  ["        this.#view = new View({",
    "            container: this,",
    "            // UV Reader: a section that grows *below* the viewport (the stacked",
    "            // next chapter) must not pull the reader back to its own anchor.",
    "            onExpand: () => {",
    "                if (this.scrolled && this.#stack.size > 1 && this.start < this.#stackOffset(this.#view) - 2) return",
    "                this.#scrollToAnchor(this.#anchor)",
    "            },",
    "        })",
  ].join("\n"),
  "if (this.scrolled && this.#stack.size > 1 && this.start < this.#stackOffset(this.#view) - 2) return");

// 16. 滚动条稳定:已滚过的节折算成容器 paddingTop(总高度恒定 → 滑块不闪),
// 窗口扩到「当前 + 最近 5 节」。
add("heights-field",
  ["    // UV Reader: scrolled mode keeps the previous section mounted (see #stack).",
    "    #stack = new Map()",
  ].join("\n"),
  ["    // UV Reader: scrolled mode keeps the previous section mounted (see #stack).",
    "    #stack = new Map()",
    "    // Measured height per section index, so the space of pruned sections can be",
    "    // reserved as padding and the scrollbar stays put.",
    "    #heights = new Map()",
  ].join("\n"),
  "#heights = new Map()");

add("spacer-helper",
  ["    #pruneStack(max) {"].join("\n"),
  ["    // Measured heights + reserved space: keep the container's scrollable height",
    "    // steady as the window of mounted sections moves, so neither the reader nor",
    "    // the scrollbar thumb jumps.",
    "    #syncSpacer() {",
    "        if (!this.scrolled) return",
    "        for (const [index, entry] of this.#stack) this.#heights.set(index, this.#viewOwnSize(entry.view))",
    "        if (!this.#stack.size) {",
    "            this.#container.style.paddingTop = ''",
    "            return",
    "        }",
    "        const { value: first } = this.#stack.keys()",
    "        let total = 0",
    "        for (const height of this.#heights.values()) total += height",
    "        const average = this.#heights.size ? total / this.#heights.size : 0",
    "        let above = 0",
    "        for (let index = 0; index < first; index += 1) above += this.#heights.get(index) ?? average",
    "        this.#container.style.paddingTop = above > 0 ? `${Math.round(above)}px` : ''",
    "    }",
    "    #pruneStack(max) {",
  ].join("\n"),
  "#syncSpacer() {");

add("spacer-window",
  ["    #pruneStack(max) {",
    "        // Keep the section being read plus at most one neighbour: the reader can",
    "        // still scroll back into it, and the iframes stay cheap.",
    "        while (this.#stack.size > max) {",
    "            const oldest = this.#stack.keys().next().value",
    "            const entry = this.#stack.get(oldest)",
    "            if (!entry) break",
    "            // Removing content above the viewport must not move what the reader",
    "            // sees: take the removed height off the scroll position.",
    "            const removed = this.#viewOwnSize(entry.view)",
    "            this.#stack.delete(oldest)",
    "            try { entry.view.destroy() } catch { /* already gone */ }",
    "            try { this.#container.removeChild(entry.view.element) } catch { /* already gone */ }",
    "            if (removed > 0) this.containerPosition = Math.max(0, this.containerPosition - removed)",
    "        }",
    "    }",
  ].join("\n"),
  ["    #pruneStack(max) {",
    "        // Keep what the reader can reach: the current section plus a few already",
    "        // read ones. Their space stays reserved by #syncSpacer(), so pruning",
    "        // neither moves the reader nor resizes the scrollbar.",
    "        while (this.#stack.size > max) {",
    "            const oldest = this.#stack.keys().next().value",
    "            const entry = this.#stack.get(oldest)",
    "            if (!entry) break",
    "            this.#stack.delete(oldest)",
    "            try { entry.view.destroy() } catch { /* already gone */ }",
    "            try { this.#container.removeChild(entry.view.element) } catch { /* already gone */ }",
    "        }",
    "        this.#syncSpacer()",
    "    }",
  ].join("\n"),
  "this.#syncSpacer()\n    }");

add("spacer-window-size",
  ["                this.#stack.set(index, { view })",
    "                this.#pruneStack(stackForward ? 2 : 1)",
  ].join("\n"),
  ["                this.#stack.set(index, { view })",
    "                // 5 previously-read sections stay mounted (smooth scroll back);",
    "                // their removed space is reserved by #syncSpacer().",
    "                this.#pruneStack(stackForward ? 6 : 1)",
  ].join("\n"),
  "#pruneStack(stackForward ? 6 : 1)");

add("spacer-after-scroll",
  ["        const index = this.scrolled ? this.#visibleIndex() : this.#index",
    "        const detail = { reason, range, index }",
  ].join("\n"),
  ["        const index = this.scrolled ? this.#visibleIndex() : this.#index",
    "        if (this.scrolled) this.#syncSpacer()",
    "        const detail = { reason, range, index }",
  ].join("\n"),
  "if (this.scrolled) this.#syncSpacer()");

let next = text;
let applied = 0;
let already = 0;
const failed = [];
for (const patch of patches) {
  if (next.includes(patch.marker)) {
    already += 1;
    continue;
  }
  if (!next.includes(patch.from)) {
    failed.push(patch.name);
    continue;
  }
  next = next.split(patch.from).join(patch.to);
  applied += 1;
}
if (failed.length) {
  console.error(`foliate-js stacked-scroll patch: upstream code changed, no match for ${failed.join(", ")}`);
  process.exit(1);
}
if (applied) fs.writeFileSync(file, next);
console.log(`foliate-js stacked scroll: ${applied} applied, ${already} already in place`);

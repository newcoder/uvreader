export class Component {
  constructor() {
    this._cleanups = [];
    this._eventRefs = [];
    this._domEvents = [];
    this._intervals = [];
    this._children = [];
    this._loaded = false;
  }

  onload() {}

  onunload() {}

  load() {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
    for (const child of this._children) child.load?.();
  }

  unload() {
    if (!this._loaded) return;
    this._loaded = false;
    this.onunload();
    for (const child of this._children) child.unload?.();
    for (const ref of this._eventRefs.splice(0)) {
      try {
        ref?.off?.();
      } catch (error) {
        console.warn("host-shim: event cleanup failed", error);
      }
    }
    for (const { el, type, callback, options } of this._domEvents.splice(0)) {
      el?.removeEventListener?.(type, callback, options);
    }
    for (const id of this._intervals.splice(0)) clearInterval(id);
    for (const cleanup of this._cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        console.warn("host-shim: cleanup failed", error);
      }
    }
  }

  register(callback) {
    this._cleanups.push(callback);
  }

  registerEvent(ref) {
    this._eventRefs.push(ref);
  }

  registerDomEvent(el, type, callback, options) {
    el.addEventListener(type, callback, options);
    this._domEvents.push({ el, type, callback, options });
  }

  registerInterval(id) {
    this._intervals.push(id);
    return id;
  }

  addChild(child) {
    this._children.push(child);
    if (this._loaded) child.load?.();
    return child;
  }

  removeChild(child) {
    this._children = this._children.filter((item) => item !== child);
    child.unload?.();
  }
}

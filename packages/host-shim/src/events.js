export class Events {
  constructor() {
    this._listeners = new Map();
  }

  on(name, callback) {
    const list = this._listeners.get(name) || [];
    list.push(callback);
    this._listeners.set(name, list);
    return { name, callback, off: () => this.off(name, callback) };
  }

  off(name, callback) {
    if (!callback) {
      this._listeners.delete(name);
      return;
    }
    const list = this._listeners.get(name) || [];
    this._listeners.set(name, list.filter((cb) => cb !== callback));
  }

  offref(ref) {
    if (ref && ref.name) this.off(ref.name, ref.callback);
  }

  trigger(name, ...args) {
    for (const callback of [...(this._listeners.get(name) || [])]) {
      try {
        callback(...args);
      } catch (error) {
        console.error(`host-shim: listener for "${name}" failed`, error);
      }
    }
  }
}

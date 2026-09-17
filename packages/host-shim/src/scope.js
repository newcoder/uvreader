export class Scope {
  constructor(parent) {
    this.parent = parent || null;
    this.bindings = [];
  }

  register(modifiers, key, callback) {
    const binding = { modifiers: Array.isArray(modifiers) ? modifiers : [modifiers], key, callback };
    this.bindings.push(binding);
    return binding;
  }

  unregister(binding) {
    this.bindings = this.bindings.filter((item) => item !== binding);
  }

  handleKey(event) {
    const key = event?.key;
    if (!key) return false;
    for (const binding of [...this.bindings].reverse()) {
      if (String(binding.key).toLowerCase() !== String(key).toLowerCase()) continue;
      try {
        binding.callback(event);
      } catch (error) {
        console.error("host-shim: scope handler failed", error);
      }
      return true;
    }
    return this.parent ? this.parent.handleKey(event) : false;
  }
}

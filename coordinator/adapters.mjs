export function defineAdapter({ module, version, assess }) {
  if (typeof module !== "string" || module.length === 0 || module.length > 128) {
    throw new TypeError("adapter module must be a non-empty string");
  }
  if (typeof version !== "string" || version.length === 0 || version.length > 64) {
    throw new TypeError("adapter version must be a non-empty string");
  }
  if (typeof assess !== "function") {
    throw new TypeError("adapter assess must be a function");
  }
  return Object.freeze({ module, version, assess });
}

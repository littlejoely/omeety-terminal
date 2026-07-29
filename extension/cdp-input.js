const PUNCTUATION_KEYS = {
  " ": ["Space", 32, false],
  "-": ["Minus", 189, false],
  "_": ["Minus", 189, true],
  "=": ["Equal", 187, false],
  "+": ["Equal", 187, true],
  "[": ["BracketLeft", 219, false],
  "{": ["BracketLeft", 219, true],
  "]": ["BracketRight", 221, false],
  "}": ["BracketRight", 221, true],
  "\\": ["Backslash", 220, false],
  "|": ["Backslash", 220, true],
  ";": ["Semicolon", 186, false],
  ":": ["Semicolon", 186, true],
  "'": ["Quote", 222, false],
  '"': ["Quote", 222, true],
  ",": ["Comma", 188, false],
  "<": ["Comma", 188, true],
  ".": ["Period", 190, false],
  ">": ["Period", 190, true],
  "/": ["Slash", 191, false],
  "?": ["Slash", 191, true],
  "`": ["Backquote", 192, false],
  "~": ["Backquote", 192, true],
  "!": ["Digit1", 49, true],
  "@": ["Digit2", 50, true],
  "#": ["Digit3", 51, true],
  "$": ["Digit4", 52, true],
  "%": ["Digit5", 53, true],
  "^": ["Digit6", 54, true],
  "&": ["Digit7", 55, true],
  "*": ["Digit8", 56, true],
  "(": ["Digit9", 57, true],
  ")": ["Digit0", 48, true],
}

export function getPrintableKeyDescriptor(char) {
  const key = String(char ?? "")
  if ([...key].length !== 1 || key.codePointAt(0) > 0x7f) return null
  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase()
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers: key === upper ? 8 : 0 }
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0), modifiers: 0 }
  }
  const entry = PUNCTUATION_KEYS[key]
  if (!entry) return { key, code: "Unidentified", windowsVirtualKeyCode: key.charCodeAt(0), modifiers: 0 }
  return { key, code: entry[0], windowsVirtualKeyCode: entry[1], modifiers: entry[2] ? 8 : 0 }
}

export function normalizeCdpInputMode(mode) {
  if (mode === "keyEvents") return "keyEvents"
  if (mode === "composition") return "composition"
  return "insertText"
}

export function getPrimaryModifier(platform = "") {
  return /mac/i.test(String(platform))
    ? { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 4 }
    : { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 }
}

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

export function getModifierMask(modifiers = []) {
  return [...new Set(Array.isArray(modifiers) ? modifiers : [])]
    .reduce((mask, name) => mask | (MODIFIER_BITS[name] || 0), 0)
}

// Pure helpers shared by the MV3 service worker and Node regression tests.
// Keep this module free of chrome.* calls so navigation/CSP behavior can be tested
// without launching a browser profile.

export function isTransientContentErrorMessage(message) {
  const text = String(message || "").toLowerCase()
  return (
    text.includes("could not establish connection") ||
    text.includes("receiving end does not exist") ||
    text.includes("message port closed") ||
    text.includes("message channel closed") ||
    text.includes("back/forward cache") ||
    text.includes("frame was removed") ||
    text.includes("target closed")
  )
}

// Runtime.evaluate receives source text directly from CDP, so this wrapper does
// not depend on eval/new Function and works on pages whose CSP forbids unsafe-eval.
export function buildPageEvaluationExpression(code) {
  return `(async () => {
    try {
      const __omeetyValue = await (async () => {
${String(code || "")}
      })()
      let __omeetyText
      try {
        __omeetyText = typeof __omeetyValue === "string"
          ? __omeetyValue
          : JSON.stringify(__omeetyValue)
      } catch (_) {
        __omeetyText = String(__omeetyValue)
      }
      return {
        ok: true,
        value: (__omeetyText === undefined ? String(__omeetyValue) : __omeetyText).slice(0, 200000)
      }
    } catch (__omeetyError) {
      return { ok: false, error: String((__omeetyError && __omeetyError.stack) || __omeetyError) }
    }
  })()
//# sourceURL=omeety-execute-js.js`
}

/**
 * Selection reporter.
 *
 * Injected into every page at `document_idle`. Its only job is to notice the
 * user's current text selection and tell the service worker about it, so the
 * side panel can show it and the harness can attach it on request. Whether a
 * selection *becomes* context is decided elsewhere — this script never sends
 * page content anywhere except its own extension.
 *
 * Runs at `document_idle` rather than on every document because a selection
 * cannot exist before there is content to select, and the debounce keeps
 * dragging a selection handle from producing a message per mouse move.
 *
 * @module extension/content-selection
 */

(() => {
  /**
   * Install once per document.
   *
   * The panel re-injects this file to recover from an extension reload, and a
   * reload leaves the old copy in every open tab with a dead extension context
   * — it still listens, but its messages go nowhere. Both copies share one
   * isolated world, so this flag is what stops a recovered tab from reporting
   * every selection twice.
   */
  if (globalThis.__dshSelectionReporter === true) return
  globalThis.__dshSelectionReporter = true

  /** Longest selection forwarded, matching the host's own bound. */
  const MAX_CHARS = 10_000
  /** How long to wait after the last change before reporting. */
  const DEBOUNCE_MS = 300

  /** @type {string} */
  let lastReported = ''
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer

  /**
   * Read the current selection, bounded.
   * @returns {string} The selected text, or an empty string.
   */
  function currentSelection() {
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed) return ''
    const text = selection.toString().trim()
    if (text.length === 0) return ''
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (selection truncated)` : text
  }

  /**
   * Report the current selection if it changed.
   *
   * Clearing a selection is reported too. The panel draws a chip for exactly
   * what would travel with the next send, and a chip that cannot disappear when
   * the highlight is gone is worse than no chip: the user's question was
   * whether the selection would be attached, and a stale chip answers it
   * wrongly.
   */
  function report() {
    const text = currentSelection()
    if (text === lastReported) return
    lastReported = text
    try {
      chrome.runtime.sendMessage({
        type: 'dsh-selection',
        text,
        url: location.href,
        title: document.title,
      })
    } catch {
      // The extension was reloaded while this page stayed open, so this copy's
      // context is gone. The panel notices the same failure and re-injects.
    }
  }

  /** Debounced report. */
  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(report, DEBOUNCE_MS)
  }

  document.addEventListener('selectionchange', schedule, { passive: true })
  // A selection made and then followed by a click elsewhere leaves the text
  // selected in some browsers; reporting once on pointer-up catches the common
  // "select, then act" gesture without waiting for the debounce.
  document.addEventListener('pointerup', schedule, { passive: true })
  window.addEventListener('scroll', schedule, { passive: true })

  // The side panel asks for the current selection when it opens, so it is not
  // blank until the user happens to select something again.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'dsh-selection-request') return false
    const text = currentSelection()
    sendResponse({ text, url: location.href, title: document.title })
    return true
  })
})()

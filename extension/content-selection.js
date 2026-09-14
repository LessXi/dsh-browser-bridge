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
   * One reporter per document, and the newest one wins.
   *
   * The panel re-injects this file to recover from an extension reload, which
   * leaves the previous copy in the page with a dead extension context: it still
   * listens, and its messages go nowhere. Both copies share one isolated world,
   * so this slot is how the new copy takes over.
   *
   * The first version of this guard returned early when the slot was filled,
   * which made the recovery it was meant to protect impossible: the dead copy
   * held the slot, so re-injecting the file installed nothing at all. Taking
   * over instead costs one call to the old copy's `dispose`, which touches only
   * DOM APIs and therefore works even from a context Chrome has invalidated.
   */
  const SLOT = '__dshSelectionReporter'
  const previous = globalThis[SLOT]
  if (previous !== null && typeof previous?.dispose === 'function') {
    try {
      previous.dispose()
    } catch {
      // Anything reaching for `chrome.*` can throw once the context is gone.
      // The copy is being discarded either way, so there is nothing to save.
    }
  }

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
    const before = lastReported
    lastReported = text
    try {
      const pending = chrome.runtime.sendMessage({
        type: 'dsh-selection',
        text,
        url: location.href,
        title: document.title,
      })
      // A dead context *rejects* rather than throwing, and the first version
      // never looked at the answer: the text stayed marked as reported and was
      // never tried again, so one extension reload silenced the page for the
      // rest of its life. Roll the cache back and let the next gesture retry.
      if (pending !== null && typeof pending?.catch === 'function') {
        pending.catch(() => {
          if (lastReported === text) lastReported = before
        })
      }
    } catch {
      if (lastReported === text) lastReported = before
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
  function onRequest(message, _sender, sendResponse) {
    if (message?.type !== 'dsh-selection-request') return false
    const text = currentSelection()
    sendResponse({ text, url: location.href, title: document.title })
    return true
  }

  chrome.runtime.onMessage.addListener(onRequest)

  /**
   * Detach this copy, so the next one can install cleanly.
   *
   * Called by a re-injected copy before it takes the slot. `removeListener` is
   * the only call here that can throw once the context is gone, and a copy that
   * cannot unregister its message listener has still lost its DOM listeners,
   * which are the ones that fire on every gesture.
   */
  function dispose() {
    document.removeEventListener('selectionchange', schedule)
    document.removeEventListener('pointerup', schedule)
    window.removeEventListener('scroll', schedule)
    if (timer !== undefined) clearTimeout(timer)
    try {
      chrome.runtime.onMessage.removeListener(onRequest)
    } catch {
      // The context is already invalidated; its listeners went with it.
    }
    if (globalThis[SLOT]?.dispose === dispose) delete globalThis[SLOT]
  }

  globalThis[SLOT] = { dispose, installedAt: Date.now() }
})()

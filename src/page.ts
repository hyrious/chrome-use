import { fail } from './errors.ts'

/**
 * Position of a node in the outermost viewport. A frame reports its rectangles
 * relative to its own document, so every ancestor frame is added on the way up.
 */
const OFFSET = `function offsetOf(node) {
  let x = 0
  let y = 0
  let doc = node.ownerDocument
  while (doc && doc.defaultView && doc.defaultView.frameElement) {
    const frame = doc.defaultView.frameElement
    const rect = frame.getBoundingClientRect()
    x += rect.x + frame.clientLeft
    y += rect.y + frame.clientTop
    doc = frame.ownerDocument
  }
  return { x: x, y: y }
}`

const POINT = `function pointOf(element) {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const offset = offsetOf(element)
  const left = Math.max(rect.left + offset.x, 0)
  const top = Math.max(rect.top + offset.y, 0)
  const right = Math.min(rect.right + offset.x, innerWidth)
  const bottom = Math.min(rect.bottom + offset.y, innerHeight)
  if (right <= left || bottom <= top) return null
  return { x: (left + right) / 2, y: (top + bottom) / 2 }
}`

const CLICKABLE = `function clickable(element) {
  if (!element.checkVisibility({ checkVisibilityCSS: true })) return false
  if (element.checkVisibility({ checkOpacity: true })) return true
  return element.ownerDocument.defaultView.getComputedStyle(element).pointerEvents != 'none'
}`

const SOURCE = String.raw`(limit) => {
  if (!document.body) return null
  const cache = window.__chromeUse || (window.__chromeUse = { ids: new WeakMap(), nodes: new Map(), next: 1, token: Math.random().toString(36).slice(2, 7) })
  const identity = (element) => {
    if (!cache.ids.has(element)) cache.ids.set(element, cache.next++)
    const id = cache.ids.get(element)
    cache.nodes.set(id, element)
    return id
  }
  for (const [id, element] of cache.nodes) if (!element.isConnected) cache.nodes.delete(id)

  const ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton']
  // Cheaper than matching a selector against every node on a large page.
  const isCandidate = (element) => {
    const tag = element.tagName
    if (tag == 'BUTTON' || tag == 'INPUT' || tag == 'TEXTAREA' || tag == 'SELECT' || tag == 'SUMMARY') return true
    if (tag == 'A') return element.hasAttribute('href')
    const role = element.getAttribute('role')
    if (role) return ROLES.includes(role)
    return element.getAttribute('contenteditable') == 'true'
  }
  const safe = (element) => element.type !== 'hidden'
  const visible = (element) => !element.closest('[aria-hidden="true"],[inert]') &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  const actionable = (element) => !element.closest('[aria-hidden="true"],[inert]') && clickable(element)
  let hiddenFrames = 0
  const frameDocument = (frame) => {
    try {
      return frame.contentDocument
    } catch (error) {
      return null
    }
  }

  ${OFFSET}
  ${POINT}
  ${CLICKABLE}

  const nameOf = (element, seen) => {
    if (!element || seen.has(element)) return ''
    seen.add(element)
    const referenced = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => nameOf(element.ownerDocument.getElementById(id), seen)).filter(Boolean).join(' ')
    return referenced || element.getAttribute('aria-label') ||
      [...(element.labels || [])].map((label) => nameOf(label, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(element.type) ? element.value : '') ||
      element.getAttribute('alt') ||
      (element.tagName === 'INPUT' ? '' : [...element.childNodes].map((node) => node.nodeType === 3
        ? node.textContent
        : node.nodeType === 1 && node.getAttribute('aria-hidden') !== 'true' ? nameOf(node, seen) : '').join(' ').trim()) ||
      element.getAttribute('title') || element.getAttribute('placeholder') || ''
  }

  const contextOf = (element, label) => {
    const block = element.closest('article,li,tr,section,dd,div')
    if (!block) return ''
    const text = (block.innerText || '').replace(/\s+/g, ' ').trim()
    return text.length > label.length && text.length > 20 ? text.slice(0, 80) : ''
  }

  const roleOf = (element) => {
    const explicit = element.getAttribute('role')
    if (ROLES.includes(explicit)) return explicit
    if (element.tagName === 'BUTTON' || element.tagName === 'SUMMARY') return 'button'
    if (element.tagName === 'A') return 'link'
    if (element.tagName === 'SELECT') return 'combobox'
    if (element.tagName === 'TEXTAREA' || element.isContentEditable) return 'textbox'
    if (element.tagName === 'INPUT') {
      if (element.type === 'file') return 'file'
      if (['checkbox', 'radio'].includes(element.type)) return element.type
      if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button'
      if (element.type === 'search') return 'searchbox'
      if (element.type === 'number') return 'spinbutton'
      if (['text', 'email', 'url', 'tel', 'password'].includes(element.type)) return 'textbox'
    }
    return null
  }

  // Open shadow roots and same document frames are walked in place, so the
  // element table follows document order instead of stopping at the top root.
  // One pass collects the candidates and the visible text, so a page is walked
  // once no matter how large it is, and the text keeps document order across
  // shadow roots and frames.
  const candidates = []
  const words = []
  const ranges = new Map()
  const MAX_CANDIDATES = 800
  let length = 0

  const readWords = (node) => {
    if (length >= 6000) return
    const parent = node.parentElement
    if (!parent) return
    const doc = parent.ownerDocument
    const view = doc.defaultView
    // The block is the cheap pre filter: text below the fold never needs a range.
    const box = parent.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= view.innerHeight || box.right <= 0 || box.left >= view.innerWidth) return
    const text = node.textContent.trim()
    if (!text || parent.closest('script,style,noscript,template') || !visible(parent)) return
    // Skip links are clipped to a pixel, but their text range still measures big.
    const style = view.getComputedStyle(parent)
    if (style.clip != 'auto' || style.clipPath != 'none') return
    let range = ranges.get(doc)
    if (!range) {
      range = doc.createRange()
      ranges.set(doc, range)
    }
    range.selectNodeContents(node)
    const rect = range.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= view.innerWidth || rect.top >= view.innerHeight) return
    const offset = offsetOf(parent)
    const x = rect.x + offset.x
    const y = rect.y + offset.y
    if (y + rect.height > 0 && y < innerHeight && x + rect.width > 0 && x < innerWidth) {
      words.push(text)
      length += text.length
    }
  }

  const walk = (root) => {
    const doc = root.ownerDocument || document
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if (node.nodeType == 1) {
        const element = node
        if (candidates.length < MAX_CANDIDATES && isCandidate(element)) candidates.push(element)
        if (element.shadowRoot) walk(element.shadowRoot)
        if (element.tagName === 'IFRAME') {
          const child = frameDocument(element)
          if (child && child.body) walk(child.body)
          else hiddenFrames++
        }
      } else {
        readWords(node)
      }
    }
  }
  walk(document.body)

  const elements = []
  const actions = []
  const index = new Map()
  let truncated = 0
  for (const element of candidates) {
    if (!safe(element) || !actionable(element) || element.matches(':disabled') || element.closest('[aria-disabled="true"]')) continue
    const role = roleOf(element)
    if (!role) continue
    // A card can be taller than the viewport, so aim at the middle of the part
    // that is actually on screen instead of dropping it as out of view.
    const point = pointOf(element)
    if (!point) continue
    if (role === 'gridcell' && element.querySelector('button,[role="button"]')) continue
    const ref = 'e' + identity(element) + '-' + cache.token
    const label = (nameOf(element, new Set()) || element.getAttribute('name') || element.id || role)
      .replace(/\s+/g, ' ').trim()
    const context = contextOf(element, label)
    const state = {}
    for (const key of ['checked', 'selected', 'expanded']) {
      const aria = element.getAttribute('aria-' + key)
      if (aria !== null) state[key] = aria
    }
    if (element.type === 'checkbox' || element.type === 'radio') state.checked = String(element.checked)
    const value = element.type === 'password' ? (element.value ? '••••' : '')
      : 'value' in element ? String(element.value)
      : element.isContentEditable || role === 'combobox' ? element.innerText.trim() : ''

    const push = (kind, actionLabel, extra) => {
      if (actions.length >= limit) {
        truncated++
        return
      }
      const operation = kind === 'click' ? 'CLICK' : kind === 'fill' ? 'TYPE_TEXT' : kind === 'upload' ? 'UPLOAD' : 'SELECT'
      let entry = index.get(ref)
      if (!entry) {
        entry = Object.assign({ ref: ref, role: role, label: label, context: context || undefined, operations: [], value: value }, state)
        index.set(ref, entry)
        elements.push(entry)
      }
      if (!entry.operations.includes(operation)) entry.operations.push(operation)
      actions.push(Object.assign({ ref: ref, kind: kind, label: actionLabel }, extra))
    }

    if (element.type === 'file') {
      push('upload', label, { value: '' })
    } else if (element.tagName === 'SELECT') {
      const current = [...element.selectedOptions].map((option) => option.label).join(', ')
      for (const option of element.options) {
        if (option.selected || option.disabled || option.closest('optgroup[disabled]')) continue
        push('select', label + ' → ' + option.label, { value: option.value, current_value: current })
      }
    } else {
      const editable = !element.readOnly && element.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(role) ||
          (role === 'combobox' && ['INPUT', 'TEXTAREA'].includes(element.tagName)))
      push(editable ? 'fill' : 'click', label, { value: value })
      if (editable) push('click', 'Open ' + label, { value: value })
    }
  }


  return {
    url: location.href,
    title: document.title,
    w: innerWidth,
    h: innerHeight,
    text: words.join('\n').slice(0, 6000),
    scroll: { y: scrollY, height: document.documentElement.scrollHeight },
    history: history.length,
    hiddenFrames: hiddenFrames,
    elements: elements,
    actions: actions,
    truncated: truncated,
  }
}`

interface ElementRef {
  token: string
  id: number
}

/** A ref from a snapshot, or a CSS selector for a node the snapshot never listed. */
export type Target = { ref: string } | { selector: string }

const REF = /^e\d+-[a-z0-9]+$/

/**
 * A ref is `e<node id>-<document token>`; anything else is read as a CSS selector.
 * Selectors exist for what the element table leaves out, such as a file input a
 * styled button opens, or a div that only carries a click handler.
 */
export function parseTarget(target: string): Target {
  const wanted = target.trim()
  if (!wanted) fail('NOT_INTERACTABLE', 'An element ref or a CSS selector is required')
  if (REF.test(wanted)) return { ref: wanted }
  // A typo in a ref should say so instead of turning into a failed selector lookup.
  if (/^e\d/.test(wanted)) fail('STALE', `Malformed element ref ${wanted}; take a new snapshot`)
  return { selector: wanted }
}

/** The expression that reads the live nodes the action helpers resolve later. */
export function snapshotExpression(limit: number): string {
  return `(${SOURCE})(${limit})`
}

/** Refs are `e<node id>-<document token>`, so a ref from an older document never resolves. */
function splitRef(ref: string): ElementRef {
  const match = /^e(\d+)-([a-z0-9]+)$/.exec(ref)
  if (!match) fail('STALE', `Malformed element ref ${ref}; take a new snapshot`)
  return { token: match[2], id: Number(match[1]) }
}

/** Declares `element`, or returns `{ reason }` when the target no longer points at a live node. */
function locate(target: Target): string {
  if ('selector' in target) {
    return `let element = null
    try { element = document.querySelector(${JSON.stringify(target.selector)}) } catch (error) { return { reason: 'bad-selector' } }
    if (!element || !element.isConnected) return { reason: 'gone' }`
  }
  const { token, id } = splitRef(target.ref)
  return `const cache = window.__chromeUse
    if (!cache || cache.token !== ${JSON.stringify(token)}) return { reason: 'gone' }
    const element = cache.nodes.get(${id})
    if (!element || !element.isConnected) return { reason: 'gone' }`
}

/** Evaluates to the live node behind a target, which is what the DOM domain wants. */
export function nodeExpression(target: Target): string {
  return `(() => {
    ${locate(target)}
    return element
  })()`
}

/** Resolves a target into a clickable point, scrolling it into view first. */
export function resolveExpression(target: Target): string {
  return `(async () => {
    ${locate(target)}
    if (element.matches(':disabled') || element.closest('[aria-disabled="true"],[inert]')) return { reason: 'disabled' }
    ${OFFSET}
    ${POINT}
    ${CLICKABLE}
    if (!clickable(element)) return { reason: 'hidden' }
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { reason: 'hidden' }
    element.scrollIntoView({ block: 'center', inline: 'center' })
    let probe = element
    let doc = probe.ownerDocument
    while (probe.getRootNode().host) probe = probe.getRootNode().host
    while (doc.defaultView && doc.defaultView.frameElement) {
      probe = doc.defaultView.frameElement
      doc = probe.ownerDocument
    }
    // A banner or a dialog can land on top while the page is still settling, so
    // look again over a few frames before calling the point covered.
    let point = null
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((resolve) => requestAnimationFrame(resolve))
      point = pointOf(element)
      if (!point) return { reason: 'outside' }
      const hit = doc.elementFromPoint(point.x, point.y)
      if (hit && (probe === hit || probe.contains(hit))) return point
    }
    return { reason: 'covered' }
  })()`
}

/** Picks a native select option through the DOM, since mouse clicks cannot pick one deterministically. */
export function selectExpression(target: Target, value: string): string {
  const wanted = JSON.stringify(value)
  return `(() => {
    ${locate(target)}
    if (element.tagName !== 'SELECT') return { reason: 'not-select' }
    if (![...element.options].some((option) => option.value === ${wanted})) return { reason: 'no-option' }
    element.value = ${wanted}
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  })()`
}

/** Waits two animation frames, or until a combobox lists visible options, capped at 200ms. */
export function settleExpression(target: Target): string {
  const field =
    'selector' in target
      ? `document.querySelector(${JSON.stringify(target.selector)})`
      : `((window.__chromeUse || {}).nodes || new Map()).get(${splitRef(target.ref).id})`
  return `new Promise((resolve) => {
    const field = ${field}
    const autocomplete = !!field && field.getAttribute && field.getAttribute('role') === 'combobox'
    let frames = 0
    let stopped = false
    const finish = () => { stopped = true; resolve(true) }
    setTimeout(finish, autocomplete ? 200 : 50)
    const ready = () => {
      if (stopped) return
      const ids = (field && field.getAttribute ? (field.getAttribute('aria-controls') || field.getAttribute('aria-owns') || '') : '').split(/s+/).filter(Boolean)
      const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document]
      const options = roots.flatMap((root) => [...root.querySelectorAll('[role="option"]')])
      const found = !autocomplete || options.some((option) => {
        const rect = option.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
          option.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      })
      if (++frames >= 2 && found) finish()
      else requestAnimationFrame(ready)
    }
    requestAnimationFrame(ready)
  })`
}

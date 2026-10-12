// Lets the Hono server see and use the page's UI the way a person would: it can list
// what's clickable or typeable, then click it or type into it. There is no shortcut
// into any widget's internals, so everything goes through real DOM events and each
// widget's own rules (disabled buttons stay disabled, etc.).

type ActionKind = 'click' | 'fill'
type Action = { tag: 'click' } | { tag: 'fill'; val: string }
type Result<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: string }

export interface UiElement {
  ref: string
  role: string
  name: string
  section: string
  value?: string
  disabled: boolean
  actions: ActionKind[]
}

const INTERACTIVE = [
  'button',
  'a[href]',
  'input:not([type=hidden])',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable=true]',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Refs stay the same for an element across calls, and are forgotten when it's removed
const refsByElement = new WeakMap<Element, string>()
const elementsByRef = new Map<string, WeakRef<HTMLElement>>()
let nextRef = 1

function refFor(el: HTMLElement) {
  let ref = refsByElement.get(el)
  if (!ref) {
    ref = `e${nextRef++}`
    refsByElement.set(el, ref)
    elementsByRef.set(ref, new WeakRef(el))
  }
  return ref
}

function isTextField(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true
  if (!(el instanceof HTMLInputElement)) return false
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(el.type)
}

function roleOf(el: HTMLElement) {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLSelectElement) return 'combobox'
  if (el instanceof HTMLInputElement) {
    if (['button', 'submit', 'reset', 'image'].includes(el.type)) return 'button'
    if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'range') return el.type === 'range' ? 'slider' : el.type
  }
  if (isTextField(el) || el.isContentEditable) return 'textbox'
  return 'generic'
}

const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()

function nameOf(el: HTMLElement) {
  const labelledBy = el.getAttribute('aria-labelledby')
  return (
    clean(el.getAttribute('aria-label')) ||
    clean(labelledBy?.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(' ')) ||
    clean([...((el as HTMLInputElement).labels ?? [])].map((l) => l.textContent).join(' ')) ||
    (isTextField(el) ? '' : clean(el.textContent)) ||
    clean(el.getAttribute('placeholder')) ||
    clean(el.getAttribute('title'))
  )
}

function sectionOf(el: HTMLElement) {
  const heading = el.closest('section')?.querySelector('h1, h2, h3')
  if (!heading) return ''
  // Leave out the grey ".sub" explanation some headings have
  const copy = heading.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.sub').forEach((sub) => sub.remove())
  return clean(copy.textContent)
}

function isDisabled(el: HTMLElement) {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
}

function describe(el: HTMLElement): UiElement {
  const textField = isTextField(el) || el.isContentEditable
  return {
    ref: refFor(el),
    role: roleOf(el),
    name: nameOf(el),
    section: sectionOf(el),
    value: isTextField(el) ? el.value : el.isContentEditable ? (el.textContent ?? '') : undefined,
    disabled: isDisabled(el),
    actions: textField ? ['click', 'fill'] : ['click'],
  }
}

export function describeUi(): UiElement[] {
  return [...document.querySelectorAll<HTMLElement>(INTERACTIVE)]
    .filter((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
    .map(describe)
}

/** Briefly outline an element so you can watch the server use the page. */
function highlight(el: HTMLElement) {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  el.animate(
    [
      { outline: `3px solid ${accent}`, outlineOffset: '2px' },
      { outline: `3px solid transparent`, outlineOffset: '6px' },
    ],
    { duration: 900, easing: 'ease-out' },
  )
}

export function interact(ref: string, action: Action): Result<UiElement> {
  const el = elementsByRef.get(ref)?.deref()
  if (!el || !el.isConnected) return { tag: 'err', val: `No element "${ref}" on the page. Call describe-ui again.` }
  if (!el.checkVisibility()) return { tag: 'err', val: `"${nameOf(el)}" (${ref}) is not visible` }
  if (isDisabled(el)) return { tag: 'err', val: `"${nameOf(el)}" (${ref}) is disabled` }

  highlight(el)
  if (action.tag === 'click') {
    el.focus()
    el.click()
  } else {
    if (!isTextField(el) && !el.isContentEditable) {
      return { tag: 'err', val: `"${nameOf(el)}" (${ref}) is a ${roleOf(el)}, not a text field` }
    }
    el.focus()
    if (isTextField(el)) el.value = action.val
    else el.textContent = action.val
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: action.val }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return { tag: 'ok', val: describe(el) }
}

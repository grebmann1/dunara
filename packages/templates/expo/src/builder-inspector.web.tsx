// Development-only DOM observations. No React internals, source reads or credentials.
export {};
declare global { interface Window { __builderInspectorCleanup?: () => void } }
const styleNames = ['display', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'color', 'backgroundColor', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderColor', 'borderRadius', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign'] as const;
const sensitive = 'input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[data-builder-private],script,style,noscript,template';

function install() {
  window.__builderInspectorCleanup?.();
  let origin = '', nonce = '', enabled = false, menu = false;
  let selected: Element | null = null, hovered: Element | null = null;
  let pathname = location.pathname;
  let timer: ReturnType<typeof setInterval> | undefined;
  let overlay: HTMLDivElement | null = null;
  let lastObservation = '';
  let gesture: { x: number; y: number; moved: boolean } | null = null;
  const removers: (() => void)[] = [];
  const activeRemovers: (() => void)[] = [];
  function listen(target: EventTarget, type: string, callback: EventListener, active = false) {
    target.addEventListener(type, callback, { capture: true, passive: false });
    (active ? activeRemovers : removers).push(() => target.removeEventListener(type, callback, true));
  }
  function send(type: string, data: object = {}) {
    if (!origin || !nonce) return;
    const message = JSON.stringify({ protocol: 'builder-inspector', version: 1, nonce, type, ...data });
    if (new TextEncoder().encode(message).length <= 32768) window.parent.postMessage(message, origin);
  }
  function privateNode(element: Element) { return !!element.closest(sensitive); }
  function visible(element: Element) {
    if (element === overlay || privateNode(element) || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && css.visibility !== 'hidden' && css.display !== 'none' && css.opacity !== '0';
  }
  function descriptor(element: Element) {
    const data: { tag: string; role?: string; label?: string; testId?: string; alt?: string } = { tag: element.localName.slice(0, 64) };
    if (!privateNode(element)) for (const [key, attribute] of [['role', 'role'], ['label', 'aria-label'], ['testId', 'data-testid'], ['alt', 'alt']] as const) {
      const value = element.getAttribute(attribute);
      if (value) data[key] = value.slice(0, 200);
    }
    return data;
  }
  function observation(element: Element) {
    let truncated = false, sample = '', visited = 0;
    // Count rejected nodes too, and prune sensitive subtrees before reading any text.
    if (!privateNode(element)) {
      let node: Node | null = element.firstChild;
      while (node && visited++ < 1000 && sample.length <= 500) {
        const descend = !(node instanceof Element) || visible(node);
        if (node.nodeType === Node.TEXT_NODE && node.parentElement && visible(node.parentElement)) {
          const value = node.textContent ?? '';
          if (value.length > 501) truncated = true;
          sample += value.slice(0, 501).replace(/\s+/g, ' ') + ' ';
        }
        if (descend && node.firstChild) node = node.firstChild;
        else {
          while (node && node !== element && !node.nextSibling) node = node.parentNode;
          node = node && node !== element ? node.nextSibling : null;
        }
      }
      if (node) truncated = true;
    }
    if (sample.length > 500) truncated = true;
    const ancestors = [];
    for (let parent = element.parentElement; parent && ancestors.length < 4; parent = parent.parentElement) ancestors.push(descriptor(parent));
    let selector = '';
    for (let current: Element | null = element, depth = 0; current && depth < 8; current = current.parentElement, depth++) {
      let part = current.localName;
      if (current.id && current.id.length <= 100) part = '#' + CSS.escape(current.id);
      else if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(sibling => sibling.localName === current!.localName);
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      if ((part + ' > ' + selector).length > 500) { truncated = true; break; }
      selector = part + (selector ? ' > ' + selector : '');
      if (document.querySelectorAll(selector).length === 1) break;
    }
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    const styles = Object.fromEntries(styleNames.map(key => [key, css[key].slice(0, 150)]));
    const path = element.getAttribute('data-builder-source') ?? '';
    const component = element.getAttribute('data-builder-component') ?? '';
    const validPath = path.length <= 250 && !path.startsWith('/') && /^[a-zA-Z0-9_./ -]+\.(tsx?|jsx?)$/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
    const validComponent = component.length <= 100 && /^[A-Za-z][A-Za-z0-9_. -]*$/.test(component);
    const source = validPath || validComponent ? { status: 'app-declared, unverified', ...(validPath ? { path } : {}), ...(validComponent ? { component } : {}) } : { status: 'unavailable' };
    return { pathname: location.pathname.slice(0, 1000), timestamp: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight }, element: descriptor(element), visibleText: sample.trim().slice(0, 500), ancestors, locator: { selector, unique: !!selector && document.querySelectorAll(selector).length === 1, kind: 'DOM hint, not source identity' }, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles, source, truncated };
  }
  function paint() {
    const target = hovered ?? selected;
    if (!overlay) return;
    if (!target || !target.isConnected || !visible(target)) { overlay.style.display = 'none'; return; }
    const rect = target.getBoundingClientRect();
    Object.assign(overlay.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderColor: target === selected ? '#e4ac54' : '#70d8c7' });
  }
  function clear() { selected = hovered = null; lastObservation = ''; menu = false; send('clear'); paint(); }
  function select(element: Element | null, point?: { x: number; y: number }) {
    if (!element || !visible(element)) { clear(); return; }
    selected = element; hovered = null;
    const selection = observation(element);
    lastObservation = JSON.stringify({ ...selection, timestamp: '' });
    menu = !!point;
    send(point ? 'context-menu' : 'selection', { selection, ...(point ? { point } : {}) });
    paint();
  }
  function tick() {
    if (pathname !== location.pathname || (selected && (!selected.isConnected || !visible(selected)))) { pathname = location.pathname; clear(); }
    if (selected) {
      const selection = observation(selected), fingerprint = JSON.stringify({ ...selection, timestamp: '' });
      if (fingerprint !== lastObservation) { lastObservation = fingerprint; send('selection', { selection }); }
    }
    paint();
  }
  function traverse(direction: number) {
    const candidates: Element[] = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node: Node | null, count = 0;
    while ((node = walker.nextNode()) && count++ < 2000 && candidates.length < 200) if (node instanceof Element && visible(node)) candidates.push(node);
    if (candidates.length) select(candidates[(candidates.indexOf(selected!) + direction + candidates.length) % candidates.length] ?? null);
  }
  function stop(event: Event, prevent = true) { event.stopImmediatePropagation(); if (prevent) event.preventDefault(); }
  function setEnabled(value: boolean) {
    enabled = value;
    for (const remove of activeRemovers.splice(0)) remove();
    clearInterval(timer); timer = undefined;
    overlay?.remove(); overlay = null;
    selected = hovered = null; gesture = null; lastObservation = ''; menu = false;
    if (!enabled) return;
    pathname = location.pathname;
    overlay = document.createElement('div');
    overlay.setAttribute('data-builder-inspector-overlay', ''); overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #e4ac54;background:rgba(112,216,199,.08);display:none;';
    document.documentElement.append(overlay);
    listen(window, 'pointerdown', event => { const e = event as PointerEvent; gesture = { x: e.clientX, y: e.clientY, moved: false }; stop(e, e.pointerType !== 'touch'); }, true);
    listen(window, 'pointermove', event => { const e = event as PointerEvent; if (gesture && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 8) gesture.moved = true; hovered = e.target instanceof Element ? e.target : null; paint(); stop(e, false); }, true);
    listen(window, 'pointerup', event => { const e = event as PointerEvent; if (gesture && !gesture.moved && e.button === 0) select(e.target instanceof Element ? e.target : null); gesture = null; stop(e, e.pointerType !== 'touch'); }, true);
    listen(window, 'pointercancel', event => { gesture = null; stop(event, false); }, true);
    for (const type of ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'dragstart', 'submit', 'beforeinput']) listen(window, type, event => stop(event), true);
    for (const type of ['touchstart', 'touchmove', 'touchend']) listen(window, type, event => stop(event, false), true);
    listen(window, 'contextmenu', event => { stop(event); const e = event as MouseEvent; select(e.target instanceof Element ? e.target : null, { x: Math.max(0, e.clientX), y: Math.max(0, e.clientY) }); }, true);
    listen(window, 'keydown', event => {
      const e = event as KeyboardEvent;
      if (e.key === 'Escape') { stop(e); if (menu) { menu = false; send('escape'); } else { send('escape'); setEnabled(false); } }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { stop(e); traverse(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'F10' && e.shiftKey && selected) { stop(e); const rect = selected.getBoundingClientRect(); select(selected, { x: Math.max(0, rect.x), y: Math.max(0, rect.y) }); }
      else if (e.key !== 'Tab') stop(e);
    }, true);
    listen(window, 'keyup', event => { if ((event as KeyboardEvent).key !== 'Tab') stop(event); }, true);
    // Active-only bounded polling catches SPA navigation, refresh removals and CSS geometry changes.
    timer = setInterval(tick, 200);
  }
  listen(window, 'message', event => {
    const e = event as MessageEvent;
    if (e.source !== window.parent || typeof e.data !== 'string' || e.data.length > 1024) return;
    let data: { protocol?: unknown; version?: unknown; nonce?: unknown; type?: unknown };
    try { data = JSON.parse(e.data); } catch { return; }
    if (!data || Object.keys(data).sort().join(',') !== 'nonce,protocol,type,version' || data.protocol !== 'builder-inspector' || data.version !== 1 || typeof data.nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.nonce)) return;
    if (data.type === 'init') {
      let url: URL; try { url = new URL(e.origin); } catch { return; }
      let hostedOrigin: string | undefined;
      try { hostedOrigin = process.env.EXPO_PUBLIC_DUNARA_STUDIO_ORIGIN; } catch { /* Standalone bridge fixtures have no Expo environment. */ }
      const allowed = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol === 'https:' && e.origin === hostedOrigin;
      if (!allowed || (origin && origin !== e.origin)) return;
      if (nonce !== data.nonce) setEnabled(false);
      origin = e.origin; nonce = data.nonce; send('ready'); return;
    }
    if (e.origin !== origin || data.nonce !== nonce) return;
    if (data.type === 'disconnect') { setEnabled(false); origin = nonce = ''; }
    if (data.type === 'enable') setEnabled(true);
    if (data.type === 'disable') setEnabled(false);
    if (enabled && data.type === 'parent') select(selected?.parentElement ?? null);
    if (enabled && data.type === 'next') traverse(1);
    if (enabled && data.type === 'previous') traverse(-1);
    if (data.type === 'menu-close') menu = false;
  });
  function cleanup() { send('disconnect'); setEnabled(false); for (const remove of removers.splice(0)) remove(); delete window.__builderInspectorCleanup; }
  listen(window, 'pagehide', cleanup);
  window.__builderInspectorCleanup = cleanup;
}
if (typeof __DEV__ !== 'undefined' && __DEV__ && typeof window !== 'undefined' && typeof document !== 'undefined' && window.parent !== window) install();

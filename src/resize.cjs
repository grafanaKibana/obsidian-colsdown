const { prepareSourceEdit, commitWidths } = require("./source-edits.cjs");

const STEP = 5;
const PRECISION = 10000;
// Browsers round grid tracks to subpixels; an intended 30% may measure 29.9995%.
const MEASUREMENT_TOLERANCE = 0.01;

function boundaryLimits(ratios, index) {
  const before = ratios.slice(0, index).reduce((sum, value) => sum + value, 0);
  const end = before + ratios[index] + ratios[index + 1];
  return { before, end, min: Math.ceil((before + STEP - 1e-7) / STEP) * STEP,
    max: Math.floor((end - STEP + 1e-7) / STEP) * STEP };
}

function resizeRatios(ratios, index, position) {
  if (index < 0 || index >= ratios.length - 1 || ratios.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const limits = boundaryLimits(ratios, index);
  if (limits.min > limits.max) return null;
  const boundary = Math.max(limits.min, Math.min(limits.max, Math.round(position / STEP) * STEP));
  const next = ratios.slice();
  next[index] = boundary - limits.before;
  next[index + 1] = limits.end - boundary;
  const rounded = next.map((value) => Math.round(value * PRECISION));
  const residual = 100 * PRECISION - rounded.reduce((sum, value) => sum + value, 0);
  rounded[next[index] >= next[index + 1] ? index : index + 1] += residual;
  return rounded.every((value) => value > 0) ? rounded.map((value) => value / PRECISION) : null;
}

function attachResizers({ app, source, element, layout, context, separator, child,
  prepare = prepareSourceEdit, commit = commitWidths, onSourceChange = () => {} }) {
  const items = Array.from(layout.children).filter((item) => item.classList.contains("layout-item"));
  if (items.length < 2 || !layout.classList.contains("layout-columns")) return () => {};
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const handles = [];
  const listeners = [];
  const gripAnimations = new Map();
  let disposed = false;
  let busy = false;
  let gesture = null;
  let currentSource = source;
  const status = doc.createElement("div");
  status.className = "colsdown-resize-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  element.appendChild(status);

  const listen = (target, type, callback, options) => {
    target.addEventListener(type, callback, options);
    listeners.push(() => target.removeEventListener(type, callback, options));
  };
  const message = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle("is-error", error);
  };
  const reducedMotion = () => {
    const classes = doc.body?.classList;
    return classes?.contains("reduce-motion")
      || classes?.contains("reduced-motion")
      || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  };
  const cancelGripAnimations = () => {
    for (const animation of gripAnimations.values()) animation.cancel();
    gripAnimations.clear();
  };
  const animateGrip = (handle, delta, rtl) => {
    if (Math.abs(delta) <= MEASUREMENT_TOLERANCE) return;
    const previous = gripAnimations.get(handle);
    previous?.cancel();
    gripAnimations.delete(handle);
    if (reducedMotion()) return;
    const grip = handle.querySelector(".colsdown-resize-grip");
    if (!grip || typeof grip.animate !== "function") return;
    const direction = Math.sign(delta) * (rtl ? -1 : 1);
    const animation = grip.animate([
      { transform: `translateX(${direction * 2.5}px) scaleX(0.82)` },
      { transform: `translateX(${-direction * 1.25}px) scaleX(1.16)`, offset: 0.45 },
      { transform: `translateX(${direction * 0.5}px) scaleX(0.96)`, offset: 0.72 },
      { transform: "translateX(0) scaleX(1)" },
    ], { duration: 210, easing: "linear" });
    gripAnimations.set(handle, animation);
  };
  const measure = () => {
    const rects = items.map((item) => item.getBoundingClientRect());
    const usable = rects.reduce((sum, rect) => sum + rect.width, 0);
    if (!usable || rects.some((rect) => rect.width <= 0 || Math.abs(rect.top - rects[0].top) > 1)) return null;
    return { rects, usable, ratios: rects.map((rect) => rect.width / usable * 100),
      rtl: win.getComputedStyle(layout).direction === "rtl" };
  };
  const refresh = () => {
    if (disposed) return;
    const measured = measure();
    const root = element.getBoundingClientRect();
    handles.forEach((handle, index) => {
      const limits = measured && boundaryLimits(measured.ratios, index);
      handle.hidden = !measured || limits.min > limits.max;
      if (handle.hidden) return;
      const first = measured.rects[index];
      const second = measured.rects[index + 1];
      const x = measured.rtl ? (first.left + second.right) / 2 : (first.right + second.left) / 2;
      handle.style.left = `${x - root.left}px`;
      handle.style.top = `${first.top - root.top}px`;
      handle.style.height = `${Math.max(...measured.rects.map((rect) => rect.height))}px`;
      const boundary = measured.ratios.slice(0, index + 1).reduce((sum, value) => sum + value, 0);
      handle.setAttribute("aria-valuenow", String(Number(boundary.toFixed(4))));
      handle.setAttribute("aria-valuetext", `${Math.round(boundary * 100) / 100}%`);
      handle.setAttribute("aria-valuemin", String(limits.min));
      handle.setAttribute("aria-valuemax", String(limits.max));
      handle.setAttribute("aria-disabled", String(busy));
    });
  };
  const restore = (active) => {
    layout.style.gridTemplateColumns = active.originalTracks;
    layout.classList.toggle("layout-explicit", active.originalExplicit);
    layout.classList.remove("is-resizing");
  };
  const release = (active) => {
    if (active.pointerId !== undefined && active.handle.hasPointerCapture?.(active.pointerId)) {
      active.handle.releasePointerCapture(active.pointerId);
    }
  };
  const cancel = () => {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    cancelGripAnimations();
    restore(active);
    release(active);
    message("");
    refresh();
  };
  const start = (index, kind, handle) => {
    if (disposed || busy || gesture) return null;
    const measured = measure();
    if (!measured || boundaryLimits(measured.ratios, index).min > boundaryLimits(measured.ratios, index).max) return null;
    const active = { ...measured, index, kind, handle, keys: new Set(),
      rootWidth: element.getBoundingClientRect().width,
      originalTracks: layout.style.gridTemplateColumns,
      originalExplicit: layout.classList.contains("layout-explicit"),
      next: measured.ratios.slice(), changed: false };
    // Capture source at the start, but consume errors at gesture completion.
    active.prepared = Promise.resolve(prepare(app, context, element, currentSource, separator))
      .then((prepared) => ({ prepared }), (error) => ({ error }));
    gesture = active;
    message("");
    layout.classList.add("is-resizing");
    return active;
  };
  const preview = (active, position) => {
    const next = resizeRatios(active.ratios, active.index, position);
    if (!next) return;
    const previousBoundary = active.next.slice(0, active.index + 1).reduce((sum, value) => sum + value, 0);
    const nextBoundary = next.slice(0, active.index + 1).reduce((sum, value) => sum + value, 0);
    const atOrigin = next.every((value, index) => Math.abs(value - active.ratios[index]) <= MEASUREMENT_TOLERANCE);
    if (atOrigin) cancelGripAnimations();
    else animateGrip(active.handle, nextBoundary - previousBoundary, active.rtl);
    active.next = next;
    active.changed = !atOrigin;
    layout.style.gridTemplateColumns = next.map((value) => `minmax(0, ${value}fr)`).join(" ");
    layout.classList.add("layout-explicit");
    refresh();
  };
  const finish = async () => {
    const active = gesture;
    if (!active) return;
    gesture = null;
    release(active);
    layout.classList.remove("is-resizing");
    if (!active.changed) { restore(active); message(""); refresh(); return; }
    busy = true;
    message("Saving widths…");
    refresh();
    try {
      const result = await active.prepared;
      if (disposed) return;
      if (result.error) throw result.error;
      const saved = await commit(app, result.prepared, active.next, separator);
      currentSource = saved.source;
      if (!disposed) onSourceChange(currentSource);
      if (!disposed) message("Widths saved.");
    } catch (error) {
      if (!disposed) {
        restore(active);
        message(`Widths were not saved. ${error instanceof Error ? error.message : "Please reopen the note and try again."}`, true);
      }
    } finally {
      busy = false;
      refresh();
    }
  };

  for (let index = 0; index < items.length - 1; index += 1) {
    const handle = doc.createElement("div");
    handle.className = "colsdown-resize-handle";
    const grip = doc.createElement("span");
    grip.className = "colsdown-resize-grip";
    grip.setAttribute("aria-hidden", "true");
    handle.appendChild(grip);
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize columns ${index + 1} and ${index + 2}`);
    items[index].id ||= `colsdown-column-${crypto.randomUUID()}`;
    handle.setAttribute("aria-controls", items[index].id);
    handle.title = "Drag to resize in 5% steps. Changes save automatically. Arrow keys resize; Escape cancels.";
    handle.tabIndex = 0;
    handle.hidden = true;
    handles.push(handle);
    element.appendChild(handle);
    listen(handle, "pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const active = start(index, "pointer", handle);
      if (!active) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      active.pointerId = event.pointerId;
      active.startX = event.clientX;
      handle.setPointerCapture?.(event.pointerId);
    });
    listen(handle, "lostpointercapture", () => { if (gesture?.handle === handle) cancel(); });
    listen(handle, "keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const active = gesture || start(index, "keyboard", handle);
      if (!active || active.kind !== "keyboard" || active.handle !== handle) return;
      active.keys.add(event.key);
      const current = active.next.slice(0, index + 1).reduce((sum, value) => sum + value, 0);
      const direction = (event.key === "ArrowRight" ? 1 : -1) * (active.rtl ? -1 : 1);
      const nextBoundary = direction > 0 ? (Math.floor((current + MEASUREMENT_TOLERANCE) / STEP) + 1) * STEP
        : (Math.ceil((current - MEASUREMENT_TOLERANCE) / STEP) - 1) * STEP;
      preview(active, nextBoundary);
    });
    listen(handle, "keyup", (event) => {
      if (gesture?.kind !== "keyboard" || !gesture.keys.has(event.key)) return;
      event.preventDefault();
      gesture.keys.delete(event.key);
      if (!gesture.keys.size) void finish();
    });
    listen(handle, "blur", cancel);
  }
  listen(win, "pointermove", (event) => {
    const active = gesture;
    if (active?.kind !== "pointer" || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const displacement = event.clientX - active.startX;
    if (Math.abs(displacement) < 2) {
      cancelGripAnimations();
      active.next = active.ratios.slice();
      active.changed = false;
      restore(active);
      message("");
      refresh();
      return;
    }
    const boundary = active.ratios.slice(0, active.index + 1).reduce((sum, value) => sum + value, 0);
    layout.classList.add("is-resizing");
    preview(active, boundary + displacement / active.usable * 100 * (active.rtl ? -1 : 1));
  }, { passive: false });
  listen(win, "pointerup", (event) => {
    if (gesture?.kind === "pointer" && gesture.pointerId === event.pointerId) void finish();
  });
  listen(win, "pointercancel", (event) => { if (gesture?.pointerId === event.pointerId) cancel(); });
  listen(win, "keydown", (event) => { if (event.key === "Escape" && gesture) { event.preventDefault(); cancel(); } });
  listen(win, "blur", cancel);
  listen(win, "resize", () => { cancel(); refresh(); });
  const Observer = win.ResizeObserver;
  const observer = Observer ? new Observer(() => {
    if (gesture && Math.abs(element.getBoundingClientRect().width - gesture.rootWidth) > 1) cancel();
    refresh();
  }) : null;
  observer?.observe(element);
  function dispose() {
    if (disposed) return;
    cancel();
    cancelGripAnimations();
    disposed = true;
    observer?.disconnect();
    listeners.forEach((remove) => remove());
    handles.forEach((handle) => handle.remove());
    status.remove();
  }
  child.register(dispose);
  refresh();
  return dispose;
}

module.exports = { STEP, boundaryLimits, resizeRatios, attachResizers };

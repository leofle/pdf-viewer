// Signatures: create (draw / type / upload / paste), keep them in this browser,
// place them on pages (move, resize, copy, paste, delete) and write them into the PDF.
import { PDFDocument } from "../vendor/pdf-lib/pdf-lib.esm.min.js"; // pdf-lib 1.17.1, vendored

const STORE_KEY = "pdfv-signatures";
const MAX_SAVED = 12;
const PDF_TO_CSS = 96 / 72;
const CLIP_MARK = "[PDF Viewer signature]";
const DEFAULT_WIDTH_PT = 160; // width of a freshly placed signature, in PDF points
const FONTS = [
  { family: "Dancing Script", weight: 400 },
  { family: "Great Vibes", weight: 400 },
  { family: "Caveat", weight: 500 },
  { family: "Sacramento", weight: 400 },
];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// Crop a canvas to its visible (non-transparent) pixels, with a little padding.
function trimCanvas(src, pad = 6) {
  const { width, height } = src;
  const data = src.getContext("2d").getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// Turn near-white pixels transparent (for photos or scans of a signature on paper).
function clearWhite(canvas) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum >= 225) d[i + 3] = 0;
    else if (lum > 165) d[i + 3] = Math.round(d[i + 3] * (225 - lum) / 60);
  }
  ctx.putImageData(img, 0, 0);
}

async function rotateDataUrl(src, deg) {
  if (!deg) return src;
  const img = await loadImage(src);
  const swap = deg % 180 !== 0;
  const c = document.createElement("canvas");
  c.width = swap ? img.height : img.width;
  c.height = swap ? img.width : img.height;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return c.toDataURL("image/png");
}

// Display offset inside a page (rotated as shown) -> unrotated page offset.
function toUnrotated(dx, dy, DW, DH, rot) {
  switch (rot) {
    case 90: return [dy, DW - dx];
    case 180: return [DW - dx, DH - dy];
    case 270: return [DH - dy, dx];
    default: return [dx, dy];
  }
}
// Display movement -> unrotated movement.
function deltaUnrotated(dx, dy, rot) {
  switch (rot) {
    case 90: return [dy, -dx];
    case 180: return [-dx, -dy];
    case 270: return [-dy, dx];
    default: return [dx, dy];
  }
}

export function createSignatures({ pdfViewer, eventBus, els, state, toast, closeMore, onPlacementsChanged }) {
  const $ = (id) => document.getElementById(id);
  const ui = {
    panel: $("sigPanel"), panelClose: $("sigPanelClose"), list: $("sigList"), empty: $("sigEmpty"),
    newBtn: $("sigNew"), placedCount: $("sigPlacedCount"), clearAll: $("sigClearAll"),
    hint: $("placeHint"), hintImg: $("placeHintImg"), placeCancel: $("placeCancel"), ghost: $("ghost"),
    modal: $("sigModal"), modalClose: $("sigModalClose"), tabs: [...document.querySelectorAll("#sigModal .tab")],
    panels: [...document.querySelectorAll("#sigModal .tab-panel")], pad: $("sigPad"), padHint: $("padHint"),
    padUndo: $("padUndo"), padClear: $("padClear"), typeName: $("typeName"), fontChoices: $("fontChoices"),
    uploadInput: $("uploadInput"), uploadPreview: $("uploadPreview"), uploadText: $("uploadText"), uploadClean: $("uploadClean"),
    save: $("sigSave"), cancel: $("sigCancel"), create: $("sigCreate"),
  };

  /** saved: [{id, src, w, h}] ; placements: [{id, page, u, v, w, h, src}] in unrotated page fractions */
  let saved = loadSaved();
  let placements = [];
  let selectedId = null;
  let armed = null; // signature being placed: {src, w, h, savedId?}
  let clipboard = null;
  let dirty = false;

  // ------------------------------------------------------------ storage
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]").filter((s) => s && s.src); } catch { return []; }
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); }
    catch { toast("Couldn't save the signature in this browser (storage is full).", true); }
  }
  function addSaved(sig) {
    saved.unshift(sig);
    if (saved.length > MAX_SAVED) saved.length = MAX_SAVED;
    persist();
    renderList();
  }

  // ------------------------------------------------------------ panel
  function renderList() {
    ui.list.replaceChildren();
    for (const sig of saved) {
      const card = document.createElement("div");
      card.className = "sig-card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", "Place this signature");
      card.title = "Click, then click on a page to place it";
      if (armed?.savedId === sig.id) card.classList.add("armed");
      const img = document.createElement("img");
      img.src = sig.src; img.alt = "Saved signature";
      const del = document.createElement("button");
      del.className = "icon-btn sig-del";
      del.title = "Delete this saved signature";
      del.setAttribute("aria-label", "Delete saved signature");
      del.innerHTML = '<svg><use href="#i-trash"/></svg>';
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        saved = saved.filter((s) => s.id !== sig.id);
        persist(); renderList();
      });
      card.append(img, del);
      const pick = () => arm({ src: sig.src, w: sig.w, h: sig.h, savedId: sig.id });
      card.addEventListener("click", pick);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      ui.list.append(card);
    }
    ui.empty.hidden = saved.length > 0;
    ui.list.hidden = saved.length === 0;
  }

  function updateCounts() {
    const n = placements.length;
    ui.placedCount.textContent = n === 0 ? "Nothing placed yet" : `${n} placed in this document`;
    ui.clearAll.hidden = n === 0;
    onPlacementsChanged(new Set(placements.map((p) => p.page)));
  }

  function openPanel() {
    if (!state.pdf) return;
    closeMore();
    renderList(); updateCounts();
    ui.panel.hidden = false;
    els.signToggle.setAttribute("aria-expanded", "true");
  }
  function closePanel() {
    if (ui.panel.hidden) return;
    ui.panel.hidden = true;
    els.signToggle.setAttribute("aria-expanded", "false");
  }
  function togglePanel() { if (ui.panel.hidden) openPanel(); else closePanel(); }

  ui.panelClose.addEventListener("click", closePanel);
  ui.newBtn.addEventListener("click", () => openModal());
  ui.clearAll.addEventListener("click", () => {
    if (!window.confirm("Remove every signature you placed in this document?")) return;
    placements = []; selectedId = null; dirty = false;
    syncAll(); updateCounts();
  });
  document.addEventListener("pointerdown", (e) => {
    if (ui.panel.hidden || ui.panel.contains(e.target) || els.secondary.contains(e.target) || e.target.closest?.("#moreToggle")) return;
    if (!ui.modal.hidden) return;
    closePanel();
  });

  // ------------------------------------------------------------ placing
  function arm(sig) {
    armed = sig;
    closePanel();
    document.body.classList.add("placing");
    ui.hintImg.src = sig.src;
    ui.ghost.src = sig.src;
    ui.hint.hidden = false;
    select(null);
  }
  function disarm() {
    armed = null;
    document.body.classList.remove("placing");
    ui.hint.hidden = true;
    ui.ghost.hidden = true;
  }
  ui.placeCancel.addEventListener("click", disarm);

  function pageViewFor(pageDiv) {
    const n = Number(pageDiv.dataset.pageNumber);
    return { n, view: pdfViewer.getPageView(n - 1) };
  }
  // Unrotated page size in CSS px at the current zoom.
  function unrotatedSize(view) {
    const vp = view.viewport;
    return vp.rotation % 180 === 0 ? [vp.width, vp.height] : [vp.height, vp.width];
  }
  function ghostSize(sig) {
    const scale = pdfViewer.currentScale || 1;
    const w = DEFAULT_WIDTH_PT * PDF_TO_CSS * scale;
    return [w, (w * sig.h) / sig.w];
  }

  els.container.addEventListener("pointermove", (e) => {
    if (!armed || e.pointerType === "touch") return;
    const onPage = e.target.closest?.(".page");
    if (!onPage) { ui.ghost.hidden = true; return; }
    const [gw, gh] = ghostSize(armed);
    ui.ghost.style.width = `${gw}px`;
    ui.ghost.style.height = `${gh}px`;
    ui.ghost.style.transform = `translate(${e.clientX - gw / 2}px, ${e.clientY - gh / 2}px)`;
    ui.ghost.hidden = false;
  });
  els.container.addEventListener("pointerleave", () => { ui.ghost.hidden = true; });

  els.container.addEventListener("click", async (e) => {
    const pageDiv = e.target.closest?.(".page");
    if (!armed) {
      if (!e.target.closest?.(".sig-item")) select(null);
      return;
    }
    if (!pageDiv) return;
    e.preventDefault();
    const sig = armed;
    disarm();
    const { n, view } = pageViewFor(pageDiv);
    const rect = pageDiv.getBoundingClientRect();
    const rot = view.viewport.rotation;
    const [W, H] = unrotatedSize(view);
    const [x, y] = toUnrotated(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, rot);
    const [gw, gh] = ghostSize(sig);
    const [bw, bh] = rot % 180 === 0 ? [gw, gh] : [gh, gw];
    let w = bw / W, h = bh / H;
    if (w > 0.9) { h *= 0.9 / w; w = 0.9; }
    if (h > 0.9) { w *= 0.9 / h; h = 0.9; }
    const src = await rotateDataUrl(sig.src, (360 - rot) % 360);
    addPlacement({ id: uid(), page: n, u: clamp(x / W - w / 2, 0, 1 - w), v: clamp(y / H - h / 2, 0, 1 - h), w, h, src });
  });

  function addPlacement(p) {
    placements.push(p);
    dirty = true;
    selectedId = p.id;
    sync(p.page);
    updateCounts();
  }

  // ------------------------------------------------------------ overlay on pages
  function ensureLayer(view) {
    const div = view.div;
    let layer = div.querySelector(":scope > .sig-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "sig-layer";
      div.append(layer);
    }
    const [W, H] = unrotatedSize(view);
    layer.style.width = `${W}px`;
    layer.style.height = `${H}px`;
    const rot = view.viewport.rotation;
    layer.style.transform = rot === 90 ? "rotate(90deg) translateY(-100%)"
      : rot === 180 ? "rotate(180deg) translate(-100%, -100%)"
      : rot === 270 ? "rotate(270deg) translateX(-100%)" : "";
    return layer;
  }

  function sync(pageNumber) {
    const view = pdfViewer.getPageView(pageNumber - 1);
    if (!view?.div) return;
    const items = placements.filter((p) => p.page === pageNumber);
    const existing = view.div.querySelector(":scope > .sig-layer");
    if (!items.length) { existing?.remove(); return; }
    const layer = ensureLayer(view);
    // Keep the little item toolbar upright whatever way the page is turned.
    layer.style.setProperty("--counter-rot", `${(360 - view.viewport.rotation) % 360}deg`);
    const keep = new Set(items.map((p) => p.id));
    for (const el of [...layer.children]) if (!keep.has(el.dataset.id)) el.remove();
    for (const p of items) {
      let el = layer.querySelector(`[data-id="${p.id}"]`);
      if (!el) el = makeItem(p, layer);
      el.style.left = `${p.u * 100}%`;
      el.style.top = `${p.v * 100}%`;
      el.style.width = `${p.w * 100}%`;
      el.style.height = `${p.h * 100}%`;
      el.classList.toggle("selected", p.id === selectedId);
      if (el.firstChild.src !== p.src) el.firstChild.src = p.src;
    }
  }
  function syncAll() {
    const total = state.pdf?.numPages ?? 0;
    for (let i = 1; i <= total; i++) sync(i);
  }

  function makeItem(p, layer) {
    const el = document.createElement("div");
    el.className = "sig-item";
    el.dataset.id = p.id;
    el.tabIndex = 0;
    el.setAttribute("aria-label", "Signature — drag to move");
    const img = document.createElement("img");
    img.alt = "Signature";
    img.draggable = false;
    img.src = p.src;
    const handle = document.createElement("span");
    handle.className = "sig-handle";
    handle.title = "Drag to resize";
    const tools = document.createElement("div");
    tools.className = "sig-tools";
    tools.innerHTML = '<button class="icon-btn sig-dup" title="Duplicate (Ctrl+C, Ctrl+V)" aria-label="Duplicate signature"><svg><use href="#i-copy"/></svg></button>'
      + '<button class="icon-btn sig-remove" title="Remove (Delete)" aria-label="Remove signature"><svg><use href="#i-trash"/></svg></button>';
    el.append(img, handle, tools);
    layer.append(el);

    tools.addEventListener("pointerdown", (e) => e.stopPropagation());
    tools.querySelector(".sig-remove").addEventListener("click", (e) => { e.stopPropagation(); remove(p.id); });
    tools.querySelector(".sig-dup").addEventListener("click", (e) => { e.stopPropagation(); duplicate(p.id); });

    el.addEventListener("pointerdown", (e) => startDrag(e, p.id, "move"));
    handle.addEventListener("pointerdown", (e) => { e.stopPropagation(); startDrag(e, p.id, "resize"); });
    el.addEventListener("click", (e) => e.stopPropagation());
    return el;
  }

  function startDrag(e, id, mode) {
    if (e.button !== undefined && e.button !== 0) return;
    const p = placements.find((q) => q.id === id);
    if (!p) return;
    e.preventDefault();
    select(id);
    const view = pdfViewer.getPageView(p.page - 1);
    const rot = view.viewport.rotation;
    const [W, H] = unrotatedSize(view);
    const start = { x: e.clientX, y: e.clientY, u: p.u, v: p.v, w: p.w, h: p.h };
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const [du, dv] = deltaUnrotated(ev.clientX - start.x, ev.clientY - start.y, rot);
      if (mode === "move") {
        p.u = clamp(start.u + du / W, 0, 1 - p.w);
        p.v = clamp(start.v + dv / H, 0, 1 - p.h);
      } else {
        const ratio = start.h / start.w;
        const wpx = start.w * W, hpx = start.h * H;
        const grow = Math.max((wpx + du) / wpx, (hpx + dv) / hpx);
        let w = clamp(start.w * grow, 24 / W, 1 - start.u);
        let h = w * ratio;
        if (start.v + h > 1) { h = 1 - start.v; w = h / ratio; }
        p.w = w; p.h = h;
      }
      dirty = true;
      sync(p.page);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function select(id) {
    if (selectedId === id) return;
    const prev = placements.find((p) => p.id === selectedId);
    selectedId = id;
    if (prev) sync(prev.page);
    const cur = placements.find((p) => p.id === id);
    if (cur) sync(cur.page);
  }

  function remove(id) {
    const p = placements.find((q) => q.id === id);
    if (!p) return;
    placements = placements.filter((q) => q.id !== id);
    if (selectedId === id) selectedId = null;
    dirty = placements.length > 0;
    sync(p.page);
    updateCounts();
  }

  function duplicate(id) {
    const p = placements.find((q) => q.id === id);
    if (p) pastePlacement(p, p.page);
  }

  function pastePlacement(p, page) {
    const off = page === p.page ? 0.03 : 0;
    addPlacement({ ...p, id: uid(), page, u: clamp(p.u + off, 0, 1 - p.w), v: clamp(p.v + off, 0, 1 - p.h) });
  }

  // PDF.js clears a page's extra layers whenever it redraws it, so put ours back.
  eventBus.on("pagerendered", ({ pageNumber }) => sync(pageNumber));
  eventBus.on("scalechanging", () => requestAnimationFrame(syncAll));
  eventBus.on("rotationchanging", () => requestAnimationFrame(syncAll));
  eventBus.on("pagesinit", syncAll);

  // ------------------------------------------------------------ keyboard & clipboard
  function handleKey(e) {
    const p = placements.find((q) => q.id === selectedId);
    if (!p) return false;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(p.id); return true; }
    const step = e.shiftKey ? 0.02 : 0.004;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const rot = pdfViewer.getPageView(p.page - 1).viewport.rotation;
      const [du, dv] = deltaUnrotated(moves[e.key][0], moves[e.key][1], rot);
      p.u = clamp(p.u + du, 0, 1 - p.w);
      p.v = clamp(p.v + dv, 0, 1 - p.h);
      dirty = true;
      sync(p.page);
      return true;
    }
    return false;
  }

  function copySelected() {
    const p = placements.find((q) => q.id === selectedId);
    if (!p) return false;
    clipboard = { ...p };
    // Mark the system clipboard so a later paste knows the copied signature is the newest thing on it.
    navigator.clipboard?.writeText?.(CLIP_MARK).catch(() => {});
    toast("Signature copied — press Ctrl/Cmd + V to paste it on the current page");
    return true;
  }

  document.addEventListener("paste", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
    if (!ui.modal.hidden) {
      if (file) { e.preventDefault(); selectTab("upload"); loadUpload(file); }
      return;
    }
    if (!state.pdf) return;
    const text = e.clipboardData?.getData("text/plain") || "";
    if (file && text !== CLIP_MARK) { e.preventDefault(); fromImageFile(file); return; }
    if (clipboard && (!text || text === CLIP_MARK)) {
      e.preventDefault();
      pastePlacement(clipboard, pdfViewer.currentPageNumber);
      toast(`Signature pasted on page ${pdfViewer.currentPageNumber}`);
    }
  });

  async function fromImageFile(file) {
    if (!state.pdf) return;
    try {
      const sig = await imageToSignature(file, true);
      if (!sig) { toast("That picture looks empty.", true); return; }
      addSaved(sig);
      arm({ ...sig, savedId: sig.id });
      toast("Signature saved — click on a page to place it");
    } catch { toast("Couldn't read that picture.", true); }
  }

  async function imageToSignature(file, clean) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const k = Math.min(1, 1200 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      if (clean) clearWhite(c);
      const t = trimCanvas(c, 4);
      if (!t) return null;
      return { id: uid(), src: t.toDataURL("image/png"), w: t.width, h: t.height };
    } finally { URL.revokeObjectURL(url); }
  }

  // ------------------------------------------------------------ dialog
  let tab = "draw";
  function openModal() {
    closePanel();
    ui.modal.hidden = false;
    selectTab(tab);
    sizePad();
    updateCreate();
  }
  function closeModal() { ui.modal.hidden = true; }
  ui.modalClose.addEventListener("click", closeModal);
  ui.cancel.addEventListener("click", closeModal);
  ui.modal.addEventListener("pointerdown", (e) => { if (e.target === ui.modal) closeModal(); });
  ui.modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && tab === "draw") { e.preventDefault(); undoStroke(); }
  });

  function selectTab(name) {
    tab = name;
    for (const t of ui.tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const p of ui.panels) p.hidden = p.dataset.panel !== name;
    if (name === "draw") sizePad();
    if (name === "type") { renderFonts(); setTimeout(() => ui.typeName.focus(), 0); }
    updateCreate();
  }
  ui.tabs.forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));

  // swatches (draw and type each keep their own colour)
  let drawColor = "#1f2330", typeColor = "#1f2330";
  for (const group of document.querySelectorAll("#sigModal .swatches")) {
    group.addEventListener("click", (e) => {
      const b = e.target.closest(".swatch");
      if (!b) return;
      for (const s of group.children) s.setAttribute("aria-checked", String(s === b));
      if (group.id === "typeSwatches") { typeColor = b.dataset.color; renderFonts(); }
      else { drawColor = b.dataset.color; }
    });
  }

  // --- draw
  const strokes = [];
  let current = null;
  const padCtx = ui.pad.getContext("2d");
  function sizePad() {
    if (ui.modal.hidden) return;
    const r = ui.pad.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    ui.pad.width = Math.round(r.width * dpr);
    ui.pad.height = Math.round(r.height * dpr);
    redrawPad();
  }
  window.addEventListener("resize", sizePad);

  function drawStroke(ctx, s, k) {
    const pts = s.points;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * k, pts[0].y * k, pts[0].w * k / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const p0 = i > 1 ? { x: (pts[i - 2].x + a.x) / 2, y: (pts[i - 2].y + a.y) / 2 } : a;
      const p1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.beginPath();
      ctx.lineWidth = ((a.w + b.w) / 2) * k;
      ctx.moveTo(p0.x * k, p0.y * k);
      ctx.quadraticCurveTo(a.x * k, a.y * k, p1.x * k, p1.y * k);
      if (i === pts.length - 1) ctx.lineTo(b.x * k, b.y * k);
      ctx.stroke();
    }
  }
  function redrawPad() {
    const r = ui.pad.getBoundingClientRect();
    const k = r.width ? ui.pad.width / r.width : 1;
    padCtx.clearRect(0, 0, ui.pad.width, ui.pad.height);
    for (const s of strokes) drawStroke(padCtx, s, k);
    if (current) drawStroke(padCtx, current, k);
    ui.padHint.hidden = strokes.length > 0 || !!current;
  }
  function padPoint(e, prev) {
    const r = ui.pad.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let w = 2.6;
    if (e.pointerType === "pen" && e.pressure > 0) w = 1.2 + e.pressure * 3.2;
    else if (prev) {
      const dist = Math.hypot(x - prev.x, y - prev.y);
      w = clamp(3.2 - dist * 0.08, 1.4, 3.2);
      w = prev.w * 0.6 + w * 0.4;
    }
    return { x, y, w };
  }
  ui.pad.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    ui.pad.setPointerCapture(e.pointerId);
    current = { color: drawColor, points: [padPoint(e)] };
    redrawPad();
  });
  ui.pad.addEventListener("pointermove", (e) => {
    if (!current) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) {
      const last = current.points.at(-1);
      const pt = padPoint(ev, last);
      if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 1) current.points.push(pt);
    }
    redrawPad();
  });
  const endStroke = () => {
    if (!current) return;
    strokes.push(current);
    current = null;
    redrawPad();
    updateCreate();
  };
  ui.pad.addEventListener("pointerup", endStroke);
  ui.pad.addEventListener("pointercancel", endStroke);
  function undoStroke() { strokes.pop(); redrawPad(); updateCreate(); }
  ui.padUndo.addEventListener("click", undoStroke);
  ui.padClear.addEventListener("click", () => { strokes.length = 0; redrawPad(); updateCreate(); });

  function exportDrawing() {
    const r = ui.pad.getBoundingClientRect();
    const k = 3;
    const c = document.createElement("canvas");
    c.width = Math.round(r.width * k);
    c.height = Math.round(r.height * k);
    const ctx = c.getContext("2d");
    for (const s of strokes) drawStroke(ctx, s, k);
    return trimCanvas(c, 8);
  }

  // --- type
  let fontIndex = 0;
  function renderFonts() {
    const name = ui.typeName.value.trim() || "Your name";
    ui.fontChoices.replaceChildren(...FONTS.map((f, i) => {
      const b = document.createElement("button");
      b.className = "font-choice";
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(i === fontIndex));
      b.style.fontFamily = `"${f.family}", cursive`;
      b.style.fontWeight = f.weight;
      b.style.color = typeColor;
      b.textContent = name;
      b.addEventListener("click", () => { fontIndex = i; renderFonts(); updateCreate(); });
      return b;
    }));
  }
  ui.typeName.addEventListener("input", () => { renderFonts(); updateCreate(); });
  ui.typeName.addEventListener("keydown", (e) => { if (e.key === "Enter" && !ui.create.disabled) ui.create.click(); });

  async function exportTyped() {
    const text = ui.typeName.value.trim();
    if (!text) return null;
    const f = FONTS[fontIndex];
    const size = 120;
    const font = `${f.weight} ${size}px "${f.family}"`;
    try { await document.fonts.load(font, text); } catch { /* fall back to whatever loads */ }
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(text).width);
    c.width = width + size; c.height = Math.round(size * 2);
    ctx.font = font;
    ctx.fillStyle = typeColor;
    ctx.textBaseline = "middle";
    ctx.fillText(text, size / 2, c.height / 2);
    return trimCanvas(c, 8);
  }

  // --- upload
  let uploadFile = null;
  ui.uploadInput.addEventListener("change", () => { if (ui.uploadInput.files[0]) loadUpload(ui.uploadInput.files[0]); ui.uploadInput.value = ""; });
  ui.uploadClean.addEventListener("change", () => { if (uploadFile) loadUpload(uploadFile); });
  let uploadSig = null;
  async function loadUpload(file) {
    if (!file.type.startsWith("image/")) { toast("Please choose a picture (PNG or JPG).", true); return; }
    uploadFile = file;
    try {
      uploadSig = await imageToSignature(file, ui.uploadClean.checked);
    } catch { uploadSig = null; toast("Couldn't read that picture.", true); }
    ui.uploadPreview.hidden = !uploadSig;
    ui.uploadText.hidden = !!uploadSig;
    if (uploadSig) ui.uploadPreview.src = uploadSig.src;
    updateCreate();
  }
  function useDroppedImage(file) { if (file) { selectTab("upload"); loadUpload(file); } }

  function updateCreate() {
    ui.create.disabled = tab === "draw" ? strokes.length === 0
      : tab === "type" ? !ui.typeName.value.trim() : !uploadSig;
  }

  ui.create.addEventListener("click", async () => {
    let sig = null;
    if (tab === "draw") {
      const c = exportDrawing();
      if (c) sig = { id: uid(), src: c.toDataURL("image/png"), w: c.width, h: c.height };
    } else if (tab === "type") {
      const c = await exportTyped();
      if (c) sig = { id: uid(), src: c.toDataURL("image/png"), w: c.width, h: c.height };
    } else if (uploadSig) {
      sig = { ...uploadSig, id: uid() };
    }
    if (!sig) return;
    if (ui.save.checked) addSaved(sig);
    closeModal();
    strokes.length = 0; redrawPad();
    uploadSig = null; uploadFile = null; ui.uploadPreview.hidden = true; ui.uploadText.hidden = false;
    arm({ src: sig.src, w: sig.w, h: sig.h, savedId: ui.save.checked ? sig.id : null });
  });

  // ------------------------------------------------------------ writing into the PDF
  async function buildSignedPdf() {
    const bytes = await state.pdf.getData();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const cache = new Map();
    for (const p of placements) {
      const page = doc.getPage(p.page - 1);
      let image = cache.get(p.src);
      if (!image) {
        const data = Uint8Array.from(atob(p.src.split(",")[1]), (ch) => ch.charCodeAt(0));
        image = await doc.embedPng(data);
        cache.set(p.src, image);
      }
      const box = page.getCropBox();
      page.drawImage(image, {
        x: box.x + p.u * box.width,
        y: box.y + (1 - p.v - p.h) * box.height,
        width: p.w * box.width,
        height: p.h * box.height,
      });
    }
    return doc.save();
  }

  // ------------------------------------------------------------ public
  function escape() {
    if (armed) { disarm(); return true; }
    if (selectedId) { select(null); return true; }
    if (!ui.panel.hidden) { closePanel(); return true; }
    return false;
  }
  function reset() {
    disarm(); closePanel();
    placements = []; selectedId = null; dirty = false;
    updateCounts();
  }

  renderList();
  return {
    togglePanel, closePanel, escape, reset, handleKey, copySelected, fromImageFile, useDroppedImage, buildSignedPdf,
    count: () => placements.length,
    hasUnsaved: () => dirty && placements.length > 0,
    markSaved: () => { dirty = false; },
    modalOpen: () => !ui.modal.hidden,
    get placements() { return placements; },
  };
}

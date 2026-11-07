// PDF Viewer — a static, build-free PDF viewer (and signer) on top of Mozilla PDF.js.
// PDF.js (pdfjs-dist 4.10.38) and pdf-lib are vendored in /vendor so the app works offline and on GitHub Pages.
import * as pdfjsLib from "../vendor/pdfjs/build/pdf.min.mjs";
import { createSignatures } from "./signatures.js";

// pdf_viewer.mjs reads the core library from globalThis, so it must be loaded after this assignment.
globalThis.pdfjsLib = pdfjsLib;
const pdfjsViewer = await import("../vendor/pdfjs/web/pdf_viewer.mjs");

const PDFJS_VERSION = "4.10.38";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/build/pdf.worker.min.mjs", import.meta.url).href;
// Optional resources (only fetched for PDFs that need them).
const CMAP_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const STANDARD_FONT_DATA_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;
const DEFAULT_FILE = "samples/sample.pdf";
const NARROW = 720;

const FindState = { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 };
const $ = (id) => document.getElementById(id);
const els = {
  container: $("viewerContainer"), viewer: $("viewer"), thumbs: $("thumbs"), sidebar: $("sidebar"),
  sidebarToggle: $("sidebarToggle"), openFile: $("openFile"), fileInput: $("fileInput"), docTitle: $("docTitle"),
  prev: $("prevPage"), next: $("nextPage"), pageNumber: $("pageNumber"), pageCount: $("pageCount"),
  zoomIn: $("zoomIn"), zoomOut: $("zoomOut"), scaleSelect: $("scaleSelect"), customScale: $("customScale"),
  fitWidth: $("fitWidth"), fitPage: $("fitPage"), rotate: $("rotate"), download: $("download"), print: $("print"),
  themeToggle: $("themeToggle"), moreToggle: $("moreToggle"), secondary: $("secondary"), signToggle: $("signToggle"),
  findToggle: $("findToggle"), findbar: $("findbar"), findInput: $("findInput"), findCount: $("findCount"),
  findPrev: $("findPrev"), findNext: $("findNext"), findCase: $("findCase"), findWord: $("findWord"), findClose: $("findClose"),
  empty: $("emptyState"), emptyOpen: $("emptyOpen"), loading: $("loading"), loadingText: $("loadingText"),
  dropzone: $("dropzone"), toast: $("toast"), printContainer: $("printContainer"),
};

// ---------------------------------------------------------------- Viewer setup
const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus, externalLinkTarget: pdfjsViewer.LinkTarget?.BLANK ?? 2 });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container: els.container,
  viewer: els.viewer,
  eventBus,
  linkService,
  findController,
  removePageBorders: true,
  textLayerMode: 1,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
});
linkService.setViewer(pdfViewer);

const state = { pdf: null, loadingTask: null, fileName: "document.pdf", loadId: 0 };
const signatures = createSignatures({ pdfjsLib, pdfViewer, eventBus, els, state, toast, closeMore, onPlacementsChanged: markThumbs });

// ---------------------------------------------------------------- Opening documents
async function openDocument(source, fileName) {
  const loadId = ++state.loadId;
  showLoading("Loading…");
  els.empty.hidden = true;
  await closeDocument();

  const params = { cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: STANDARD_FONT_DATA_URL };
  if (typeof source === "string") params.url = source; else params.data = source;

  const task = pdfjsLib.getDocument(params);
  state.loadingTask = task;
  task.onPassword = (updatePassword, reason) => {
    const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? "Incorrect password. Please try again:" : "This PDF is password protected. Enter the password:";
    const pw = window.prompt(msg);
    if (pw === null) task.destroy(); else updatePassword(pw);
  };
  task.onProgress = ({ loaded, total }) => {
    if (total) els.loadingText.textContent = `Loading… ${Math.min(100, Math.round((loaded / total) * 100))}%`;
  };

  try {
    const pdf = await task.promise;
    if (loadId !== state.loadId) { pdf.destroy(); return; }
    state.pdf = pdf;
    state.fileName = fileName || "document.pdf";
    pdfViewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
    els.pageCount.textContent = pdf.numPages;
    setControlsEnabled(true);
    els.pageNumber.value = 1;
    els.prev.disabled = true;
    els.next.disabled = pdf.numPages <= 1;
    buildThumbnails(pdf);

    let title = state.fileName;
    try {
      const { info } = await pdf.getMetadata();
      if (info?.Title && String(info.Title).trim()) title = String(info.Title).trim();
    } catch { /* optional */ }
    els.docTitle.textContent = title;
    els.docTitle.title = state.fileName;
    document.title = `${title} – PDF Viewer`;
  } catch (err) {
    if (loadId !== state.loadId) return;
    console.warn("Failed to open PDF:", err);
    const msg = err?.name === "PasswordException" ? "Password required — document not opened."
      : err?.name === "InvalidPDFException" ? "That file doesn't look like a valid PDF."
      : err?.name === "MissingPDFException" ? "PDF not found."
      : "Couldn't load the PDF (if it's on another site, it must allow CORS).";
    toast(msg, true);
    els.empty.hidden = false;
    setControlsEnabled(false);
  } finally {
    if (loadId === state.loadId) hideLoading();
  }
}

async function closeDocument() {
  thumbObserver?.disconnect();
  els.thumbs.replaceChildren();
  closeFind();
  signatures.reset();
  if (state.loadingTask) { const t = state.loadingTask; state.loadingTask = null; await t.destroy().catch(() => {}); }
  if (state.pdf) {
    state.pdf = null;
    pdfViewer.setDocument(null);
    linkService.setDocument(null, null);
  }
}

function openFromFile(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    toast("Please choose a PDF file.", true);
    return;
  }
  if (signatures.hasUnsaved() && !window.confirm("Your placed signatures haven't been downloaded yet. Open the new file anyway?")) return;
  file.arrayBuffer().then((buf) => openDocument(new Uint8Array(buf), file.name));
  history.replaceState(null, "", location.pathname);
}

function fileNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "") || "document.pdf";
  } catch { return "document.pdf"; }
}

// ---------------------------------------------------------------- Viewer events
eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = window.innerWidth <= NARROW ? "page-width" : "auto";
  if (location.hash.length > 1) linkService.setHash(location.hash.slice(1));
  els.container.focus({ preventScroll: true });
});

eventBus.on("pagechanging", ({ pageNumber }) => {
  els.pageNumber.value = pageNumber;
  els.prev.disabled = pageNumber <= 1;
  els.next.disabled = pageNumber >= (state.pdf?.numPages ?? 1);
  setActiveThumb(pageNumber);
});

eventBus.on("scalechanging", ({ scale, presetValue }) => {
  const sel = els.scaleSelect;
  const preset = presetValue && [...sel.options].find((o) => o.value === String(presetValue));
  const exact = [...sel.options].find((o) => !o.hidden && Number(o.value) === scale);
  if (preset && isNaN(Number(presetValue))) {
    els.customScale.hidden = true; sel.value = preset.value;
  } else if (exact) {
    els.customScale.hidden = true; sel.value = exact.value;
  } else {
    els.customScale.hidden = false;
    els.customScale.textContent = `${Math.round(scale * 100)}%`;
    sel.value = "custom";
  }
  els.zoomOut.disabled = scale <= 0.1 + 1e-6;
  els.zoomIn.disabled = scale >= 10 - 1e-6;
});

eventBus.on("rotationchanging", () => rerenderThumbnails());

// ---------------------------------------------------------------- Toolbar actions
const actions = {
  prev: () => pdfViewer.previousPage(),
  next: () => pdfViewer.nextPage(),
  first: () => { pdfViewer.currentPageNumber = 1; },
  last: () => { pdfViewer.currentPageNumber = state.pdf?.numPages ?? 1; },
  zoomIn: () => pdfViewer.increaseScale(),
  zoomOut: () => pdfViewer.decreaseScale(),
  setScale: (v) => { pdfViewer.currentScaleValue = v; },
  rotate: (delta = 90) => { pdfViewer.pagesRotation = (pdfViewer.pagesRotation + delta + 360) % 360; },
};

function setControlsEnabled(on) {
  for (const el of [els.prev, els.next, els.pageNumber, els.zoomIn, els.zoomOut, els.scaleSelect, els.fitWidth,
    els.fitPage, els.rotate, els.download, els.print, els.findToggle, els.signToggle]) el.disabled = !on;
  if (!on) { els.pageCount.textContent = "–"; els.pageNumber.value = ""; els.docTitle.textContent = "PDF Viewer"; }
}

els.prev.addEventListener("click", actions.prev);
els.next.addEventListener("click", actions.next);
els.zoomIn.addEventListener("click", actions.zoomIn);
els.zoomOut.addEventListener("click", actions.zoomOut);
els.fitWidth.addEventListener("click", () => actions.setScale("page-width"));
els.fitPage.addEventListener("click", () => actions.setScale("page-fit"));
els.scaleSelect.addEventListener("change", () => {
  if (els.scaleSelect.value !== "custom") actions.setScale(els.scaleSelect.value);
  els.container.focus({ preventScroll: true });
});
els.rotate.addEventListener("click", () => { actions.rotate(); closeMore(); });
els.download.addEventListener("click", () => { download(); closeMore(); });
els.print.addEventListener("click", () => { printDocument(); closeMore(); });
els.themeToggle.addEventListener("click", () => { toggleTheme(); closeMore(); });
els.signToggle.addEventListener("click", (e) => { e.stopPropagation(); closeMore(); closeFind(); signatures.togglePanel(); });
els.sidebarToggle.addEventListener("click", toggleSidebar);
els.openFile.addEventListener("click", () => els.fileInput.click());
els.emptyOpen.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => { openFromFile(els.fileInput.files[0]); els.fileInput.value = ""; });
els.moreToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = els.secondary.classList.toggle("open");
  els.moreToggle.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => { if (!els.secondary.contains(e.target)) closeMore(); });
function closeMore() { els.secondary.classList.remove("open"); els.moreToggle.setAttribute("aria-expanded", "false"); }

els.pageNumber.addEventListener("change", commitPageNumber);
els.pageNumber.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { commitPageNumber(); els.container.focus({ preventScroll: true }); }
});
els.pageNumber.addEventListener("focus", () => els.pageNumber.select());
function commitPageNumber() {
  if (!state.pdf) return;
  const n = parseInt(els.pageNumber.value, 10);
  if (Number.isInteger(n) && n >= 1 && n <= state.pdf.numPages) pdfViewer.currentPageNumber = n;
  else els.pageNumber.value = pdfViewer.currentPageNumber;
}

// ---------------------------------------------------------------- Theme & sidebar
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("pdfv-theme", next); } catch { /* private mode */ }
}

function setSidebar(open) {
  document.body.classList.toggle("sidebar-closed", !open);
  els.sidebarToggle.setAttribute("aria-pressed", String(open));
}
function toggleSidebar() { setSidebar(document.body.classList.contains("sidebar-closed")); }
setSidebar(window.innerWidth > NARROW);
els.sidebar.addEventListener("transitionend", () => {
  const v = pdfViewer.currentScaleValue;
  if (state.pdf && isNaN(Number(v))) pdfViewer.currentScaleValue = v;
});

// ---------------------------------------------------------------- Thumbnails
const THUMB_WIDTH = 132;
let thumbObserver = null;

function buildThumbnails(pdf) {
  thumbObserver?.disconnect();
  els.thumbs.replaceChildren();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) renderThumbnail(entry.target);
  }, { root: els.sidebar, rootMargin: "300px 0px" });

  const frag = document.createDocumentFragment();
  for (let i = 1; i <= pdf.numPages; i++) {
    const btn = document.createElement("button");
    btn.className = "thumb";
    btn.dataset.page = i;
    btn.title = `Page ${i}`;
    btn.setAttribute("aria-label", `Go to page ${i}`);
    const box = document.createElement("div");
    box.className = "thumb-img";
    box.style.width = `${THUMB_WIDTH}px`;
    box.style.height = `${Math.round(THUMB_WIDTH * 1.414)}px`;
    const label = document.createElement("span");
    label.textContent = i;
    btn.append(box, label);
    btn.addEventListener("click", () => {
      pdfViewer.currentPageNumber = i;
      if (window.innerWidth <= NARROW) setSidebar(false);
    });
    frag.append(btn);
    thumbObserver.observe(btn);
  }
  els.thumbs.append(frag);
  setActiveThumb(1);
}

async function renderThumbnail(btn) {
  if (btn.dataset.rendered === "1" || !state.pdf) return;
  btn.dataset.rendered = "1";
  const pdf = state.pdf;
  const rotation = pdfViewer.pagesRotation;
  try {
    const page = await pdf.getPage(Number(btn.dataset.page));
    const rot = (page.rotate + rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation: rot });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width, rotation: rot });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({
      canvasContext: canvas.getContext("2d"), viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    if (pdf !== state.pdf || rotation !== pdfViewer.pagesRotation) return;
    const box = btn.querySelector(".thumb-img");
    box.style.width = canvas.style.width;
    box.style.height = canvas.style.height;
    const badge = box.querySelector(".thumb-signed");
    box.replaceChildren(canvas);
    if (badge) box.append(badge);
  } catch (err) {
    if (pdf !== state.pdf) return;
    btn.dataset.rendered = "";
    if (err?.name === "RenderingCancelledException") {
      thumbObserver?.unobserve(btn);
      thumbObserver?.observe(btn);
    } else {
      console.warn("Thumbnail render failed", err);
    }
  }
}

function rerenderThumbnails() {
  if (!thumbObserver) return;
  for (const btn of els.thumbs.children) {
    btn.dataset.rendered = "";
    const box = btn.querySelector(".thumb-img");
    const [w, h] = [box.style.width, box.style.height];
    const badge = box.querySelector(".thumb-signed");
    box.replaceChildren();
    if (badge) box.append(badge);
    box.style.width = `${THUMB_WIDTH}px`;
    box.style.height = `${Math.round((parseFloat(w) / parseFloat(h)) * THUMB_WIDTH) || THUMB_WIDTH}px`;
    thumbObserver.unobserve(btn);
    thumbObserver.observe(btn);
  }
}

function setActiveThumb(n) {
  els.thumbs.querySelector(".thumb.active")?.classList.remove("active");
  const cur = els.thumbs.children[n - 1];
  if (!cur) return;
  cur.classList.add("active");
  const sb = els.sidebar;
  const top = cur.offsetTop, bottom = top + cur.offsetHeight;
  if (top < sb.scrollTop || bottom > sb.scrollTop + sb.clientHeight) {
    sb.scrollTo({ top: top - sb.clientHeight / 2 + cur.offsetHeight / 2, behavior: "smooth" });
  }
}

// Small pen badge on thumbnails of pages that carry a signature.
function markThumbs(pagesWithSignatures) {
  [...els.thumbs.children].forEach((btn, i) => {
    const box = btn.querySelector(".thumb-img");
    const has = pagesWithSignatures.has(i + 1);
    let badge = box.querySelector(".thumb-signed");
    if (has && !badge) {
      badge = document.createElement("span");
      badge.className = "thumb-signed";
      badge.title = "This page has a signature";
      badge.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 4.5l4 4L9 19H5v-4z"/><path d="M13 7l4 4"/></svg>';
      box.append(badge);
    } else if (!has && badge) badge.remove();
  });
}

// ---------------------------------------------------------------- Search
function openFind() {
  if (!state.pdf) return;
  signatures.closePanel();
  els.findbar.hidden = false;
  els.findToggle.setAttribute("aria-expanded", "true");
  els.findInput.focus();
  els.findInput.select();
}
function closeFind() {
  if (els.findbar.hidden) return;
  els.findbar.hidden = true;
  els.findToggle.setAttribute("aria-expanded", "false");
  eventBus.dispatch("findbarclose", { source: null });
  els.container.focus({ preventScroll: true });
}
function dispatchFind(type, findPrevious = false) {
  eventBus.dispatch("find", {
    source: null, type, query: els.findInput.value,
    caseSensitive: els.findCase.checked, entireWord: els.findWord.checked,
    highlightAll: true, findPrevious, matchDiacritics: false,
  });
}
function updateFindCount({ current, total }) {
  if (!els.findInput.value) { els.findCount.textContent = ""; return; }
  els.findCount.classList.toggle("notfound", total === 0);
  els.findCount.textContent = total ? `${current} of ${total}` : "No results";
}

els.findToggle.addEventListener("click", () => (els.findbar.hidden ? openFind() : closeFind()));
els.findClose.addEventListener("click", closeFind);
els.findInput.addEventListener("input", () => dispatchFind(""));
els.findCase.addEventListener("change", () => dispatchFind("casesensitivitychange"));
els.findWord.addEventListener("change", () => dispatchFind("entirewordchange"));
els.findNext.addEventListener("click", () => dispatchFind("again", false));
els.findPrev.addEventListener("click", () => dispatchFind("again", true));
els.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); dispatchFind("again", e.shiftKey); }
  else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
});
eventBus.on("updatefindmatchescount", ({ matchesCount }) => updateFindCount(matchesCount));
eventBus.on("updatefindcontrolstate", ({ state: s, matchesCount, previous }) => {
  if (s === FindState.PENDING) { els.findCount.textContent = "…"; return; }
  if (s === FindState.NOT_FOUND) { updateFindCount({ current: 0, total: 0 }); return; }
  if (matchesCount) updateFindCount(matchesCount);
  if (s === FindState.WRAPPED) toast(previous ? "Reached the top, continued from the bottom" : "Reached the end, continued from the top");
});

// ---------------------------------------------------------------- Download & print
function saveBlob(data, name) {
  const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function download() {
  if (!state.pdf) return;
  const base = state.fileName.replace(/\.pdf$/i, "");
  try {
    if (signatures.count() > 0) {
      showLoading("Adding signatures…");
      const bytes = await signatures.buildSignedPdf();
      saveBlob(bytes, `${base}-signed.pdf`);
      signatures.markSaved();
      toast("Signed copy downloaded");
    } else {
      saveBlob(await state.pdf.getData(), `${base}.pdf`);
    }
  } catch (err) {
    console.warn("Download failed", err);
    toast("Couldn't prepare the download.", true);
  } finally {
    hideLoading();
  }
}

let printing = false;
async function printDocument() {
  if (!state.pdf || printing) return;
  printing = true;
  let pdf = state.pdf;
  let temp = null;
  const urls = [];
  try {
    if (signatures.count() > 0) {
      showLoading("Adding signatures…");
      temp = await pdfjsLib.getDocument({
        data: await signatures.buildSignedPdf(),
        cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: STANDARD_FONT_DATA_URL,
      }).promise;
      pdf = temp;
    }
    els.printContainer.replaceChildren();
    for (let i = 1; i <= pdf.numPages; i++) {
      showLoading(`Preparing to print… ${i}/${pdf.numPages}`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 150 / 72, rotation: (page.rotate + pdfViewer.pagesRotation) % 360 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = new Image();
      img.src = url;
      els.printContainer.append(img);
      await img.decode().catch(() => {});
    }
    hideLoading();
    window.print();
  } catch (err) {
    console.warn("Print failed", err);
    toast("Printing failed.", true);
  } finally {
    hideLoading();
    printing = false;
    temp?.destroy();
    setTimeout(() => { els.printContainer.replaceChildren(); urls.forEach(URL.revokeObjectURL); }, 1000);
  }
}

// ---------------------------------------------------------------- Keyboard, wheel, drag & drop
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const tag = e.target.tagName;
  const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target.isContentEditable;
  if (signatures.modalOpen()) return; // the signature dialog handles its own keys

  if (mod && !e.altKey) {
    switch (e.key) {
      case "f": case "F": e.preventDefault(); openFind(); return;
      case "o": case "O": e.preventDefault(); els.fileInput.click(); return;
      case "p": case "P": if (state.pdf) { e.preventDefault(); printDocument(); } return;
      case "s": case "S": if (state.pdf) { e.preventDefault(); download(); } return;
      case "+": case "=": if (state.pdf) { e.preventDefault(); actions.zoomIn(); } return;
      case "-": case "_": if (state.pdf) { e.preventDefault(); actions.zoomOut(); } return;
      case "0": if (state.pdf) { e.preventDefault(); actions.setScale("auto"); } return;
      case "c": case "C": if (!typing && signatures.copySelected()) e.preventDefault(); return;
    }
    return;
  }
  if (e.key === "Escape") {
    if (signatures.escape()) return;
    closeFind(); closeMore(); return;
  }
  if (typing || !state.pdf || e.altKey) return;
  if (signatures.handleKey(e)) return;

  switch (e.key) {
    case "ArrowLeft": case "k": e.preventDefault(); actions.prev(); break;
    case "ArrowRight": case "j": e.preventDefault(); actions.next(); break;
    case "Home": e.preventDefault(); actions.first(); break;
    case "End": e.preventDefault(); actions.last(); break;
    case "r": actions.rotate(90); break;
    case "R": actions.rotate(-90); break;
    case "s": case "S": closeFind(); signatures.togglePanel(); break;
    case "+": case "=": actions.zoomIn(); break;
    case "-": actions.zoomOut(); break;
  }
});

els.container.addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !state.pdf) return;
  e.preventDefault();
  pdfViewer.updateScale({ drawingDelay: 300, steps: e.deltaY < 0 ? 1 : -1 });
}, { passive: false });

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e) || signatures.modalOpen()) return; e.preventDefault(); dragDepth++; els.dropzone.hidden = false; });
window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.hidden = true; } });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.hidden = true;
  if (signatures.modalOpen()) { signatures.useDroppedImage(e.dataTransfer.files[0]); return; }
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) { signatures.fromImageFile(file); return; }
  openFromFile(file);
});

window.addEventListener("resize", () => {
  const v = pdfViewer.currentScaleValue;
  if (state.pdf && isNaN(Number(v))) pdfViewer.currentScaleValue = v;
});

window.addEventListener("beforeunload", (e) => {
  if (signatures.hasUnsaved()) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------------------------------------------------------- UI helpers
function showLoading(text) { els.loadingText.textContent = text; els.loading.hidden = false; }
function hideLoading() { els.loading.hidden = true; }
let toastTimer;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("error", isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 5000 : 2200);
}

// ---------------------------------------------------------------- Boot
setControlsEnabled(false);
const fileParam = new URLSearchParams(location.search).get("file");
const initial = fileParam || DEFAULT_FILE;
openDocument(new URL(initial, location.href).href, fileNameFromUrl(initial));

// Exposed for debugging and automated tests.
window.PDFViewerApp = { findController, linkService, pdfjsLib, pdfViewer, eventBus, state, openDocument, actions, signatures };

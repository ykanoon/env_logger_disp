/**
 * micro:bit CSV Viewer (pure JS + Canvas)
 * - x: datetime
 * - left y: temp_OUT
 * - right y: moist_lv or light (selectable)
 *
 * Requirements:
 * - Serve with a local HTTP server (fetch needs it).
 */

const CSV_PATH = "./csv/microbit_20260208.csv";

const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");

const rightAxisSelect = document.getElementById("rightAxisSelect");
const rangeSelect = document.getElementById("rangeSelect");
const resetBtn = document.getElementById("resetBtn");

const sourcePathEl = document.getElementById("sourcePath");
const statsEl = document.getElementById("stats");

sourcePathEl.textContent = CSV_PATH;

// --------- Utilities ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pad2 = (n) => String(n).padStart(2, "0");

function parseCSV(text) {
  // Simple CSV parser (no quoted commas support). OK for this dataset.
  const lines = text.replace(/\r/g, "").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(s => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length !== headers.length) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const raw = cols[j].trim();
      const num = Number(raw);
      obj[key] = Number.isFinite(num) ? num : raw;
    }
    rows.push(obj);
  }
  return rows;
}

function toDate(row) {
  // Uses local time zone (Asia/Tokyo on most systems in Japan).
  const y = row.year, m = row.month, d = row.date;
  const hh = row.hour, mm = row.min, ss = row.sec;
  const iso = `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  return new Date(iso);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function niceTicks(min, max, targetCount = 6) {
  // Generate "nice" tick step: 1/2/5 * 10^n
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { step: 1, ticks: [min] };
  }
  const span = Math.abs(max - min);
  const rawStep = span / targetCount;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const candidates = [1, 2, 5, 10].map(x => x * pow10);
  let step = candidates[0];
  for (const c of candidates) if (Math.abs(c - rawStep) < Math.abs(step - rawStep)) step = c;

  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;

  const ticks = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(v);
  return { step, ticks };
}

function setHiDPICanvas(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssWidth + "px";
  canvas.style.height = cssHeight + "px";
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  return dpr;
}

// --------- State ----------
let raw = [];           // parsed CSV rows
let data = [];          // normalized: {t:Date, x:number(ms), temp:number, moist:number, light:number}
let rightKey = "moist_lv";
let xDomainAll = [0, 1]; // [minMs, maxMs]
let view = { x0: 0, x1: 1 }; // current view window (ms)
let isPanning = false;
let panStart = { x: 0, x0: 0, x1: 1 };

// Layout
const padding = { left: 64, right: 64, top: 18, bottom: 46 };
const legendH = 24;

// --------- Drawing ----------
function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawText(text, x, y, align="left", baseline="alphabetic", alpha=1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawLine(x1, y1, x2, y2, alpha=1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function domainForKey(key, domainX) {
  const [x0, x1] = domainX;
  let min = Infinity, max = -Infinity;
  for (const p of data) {
    if (p.x < x0 || p.x > x1) continue;
    const v = p[key];
    if (!Number.isFinite(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const pad = (max - min) * 0.06;
  return [min - pad, max + pad];
}

function xToPx(x, plot) {
  const { x0, x1, left, right } = plot;
  return left + (x - x0) / (x1 - x0) * (right - left);
}

function yToPx(y, yDomain, top, bottom) {
  const [y0, y1] = yDomain;
  return bottom - (y - y0) / (y1 - y0) * (bottom - top);
}

function drawAxes(plot, yLeftDomain, yRightDomain) {
  const dpr = window.devicePixelRatio || 1;

  // Styles
  ctx.save();
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = "rgba(155,176,209,0.22)";
  ctx.fillStyle = "rgba(231,238,252,0.92)";
  ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Noto Sans JP, sans-serif`;

  // Border
  ctx.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);

  // Y ticks left
  const leftTicks = niceTicks(yLeftDomain[0], yLeftDomain[1], 6).ticks;
  for (const v of leftTicks) {
    const y = yToPx(v, yLeftDomain, plot.top, plot.bottom);
    // grid
    drawLine(plot.left, y, plot.right, y, 0.35);
    // label
    ctx.fillStyle = "rgba(231,238,252,0.85)";
    drawText(v.toFixed(0), plot.left - 8 * dpr, y, "right", "middle", 0.9);
  }

  // Y ticks right
  const rightTicks = niceTicks(yRightDomain[0], yRightDomain[1], 6).ticks;
  for (const v of rightTicks) {
    const y = yToPx(v, yRightDomain, plot.top, plot.bottom);
    ctx.fillStyle = "rgba(231,238,252,0.72)";
    drawText(v.toFixed(0), plot.right + 8 * dpr, y, "left", "middle", 0.9);
  }

  // X ticks (time)
  const xSpan = plot.x1 - plot.x0;
  const targetXTicks = 7;
  const stepCandidates = [
    5*60*1000, 10*60*1000, 15*60*1000, 30*60*1000,
    60*60*1000, 2*60*60*1000, 3*60*60*1000, 6*60*60*1000,
    12*60*60*1000, 24*60*60*1000
  ];
  let step = stepCandidates[0];
  const raw = xSpan / targetXTicks;
  for (const c of stepCandidates) if (Math.abs(c - raw) < Math.abs(step - raw)) step = c;

  const start = Math.floor(plot.x0 / step) * step;
  for (let x = start; x <= plot.x1 + step; x += step) {
    const px = xToPx(x, plot);
    // vertical grid
    drawLine(px, plot.top, px, plot.bottom, 0.25);
    const d = new Date(x);
    const label = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    ctx.fillStyle = "rgba(231,238,252,0.75)";
    drawText(label, px, plot.bottom + 18 * dpr, "center", "top", 0.9);
  }

  // Axis titles
  ctx.fillStyle = "rgba(231,238,252,0.88)";
  drawText("temp_OUT (°C)", plot.left, plot.top - 8 * dpr, "left", "bottom", 0.95);
  drawText(`${rightKey}`, plot.right, plot.top - 8 * dpr, "right", "bottom", 0.95);

  ctx.restore();
}

function drawSeries(plot, keyLeft, keyRight, yLeftDomain, yRightDomain) {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.lineWidth = 2 * dpr;

  // Left series (temp_OUT) - accent
  ctx.strokeStyle = "rgba(122,162,255,0.95)";
  ctx.beginPath();
  let started = false;
  for (const p of data) {
    if (p.x < plot.x0 || p.x > plot.x1) continue;
    const v = p[keyLeft];
    if (!Number.isFinite(v)) continue;
    const x = xToPx(p.x, plot);
    const y = yToPx(v, yLeftDomain, plot.top, plot.bottom);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Right series - amber
  ctx.strokeStyle = "rgba(255,212,121,0.92)";
  ctx.beginPath();
  started = false;
  for (const p of data) {
    if (p.x < plot.x0 || p.x > plot.x1) continue;
    const v = p[keyRight];
    if (!Number.isFinite(v)) continue;
    const x = xToPx(p.x, plot);
    const y = yToPx(v, yRightDomain, plot.top, plot.bottom);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Legend
  ctx.fillStyle = "rgba(122,162,255,0.95)";
  ctx.fillRect(plot.left, plot.top + 6 * dpr, 10 * dpr, 10 * dpr);
  ctx.fillStyle = "rgba(231,238,252,0.88)";
  ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Noto Sans JP, sans-serif`;
  drawText("temp_OUT", plot.left + 16 * dpr, plot.top + 12 * dpr, "left", "middle", 0.95);

  ctx.fillStyle = "rgba(255,212,121,0.92)";
  ctx.fillRect(plot.left + 110 * dpr, plot.top + 6 * dpr, 10 * dpr, 10 * dpr);
  ctx.fillStyle = "rgba(231,238,252,0.88)";
  drawText(rightKey, plot.left + 126 * dpr, plot.top + 12 * dpr, "left", "middle", 0.95);

  ctx.restore();
}

function draw() {
  if (!data.length) return;

  // Fit canvas to container
  const rect = canvas.parentElement.getBoundingClientRect();
  const cssW = Math.max(680, Math.floor(rect.width));
  const cssH = 520;
  const dpr = setHiDPICanvas(canvas, cssW, cssH);

  // Scale all drawing ops
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Chart area in CSS pixels (transform already applied)
  const plot = {
    left: padding.left,
    right: cssW - padding.right,
    top: padding.top + legendH,
    bottom: cssH - padding.bottom,
    x0: view.x0,
    x1: view.x1,
  };

  // Compute Y domains within view
  const yLeftDomain = domainForKey("temp_OUT", [plot.x0, plot.x1]);
  const yRightDomain = domainForKey(rightKey, [plot.x0, plot.x1]);

  // Background
  ctx.fillStyle = "rgba(17,24,38,0.35)";
  ctx.fillRect(0, 0, cssW, cssH);

  // Axes + data
  ctx.strokeStyle = "rgba(155,176,209,0.22)";
  ctx.fillStyle = "rgba(231,238,252,0.9)";
  drawAxes(plot, yLeftDomain, yRightDomain);
  drawSeries(plot, "temp_OUT", rightKey, yLeftDomain, yRightDomain);

  // Stats
  const start = new Date(view.x0);
  const end = new Date(view.x1);
  statsEl.textContent =
    `rows=${data.length} | view=${formatDate(start)} 〜 ${formatDate(end)} | right=${rightKey}`;
}

// --------- Interaction (hover, pan, zoom) ----------
function hitTest(mouseX, mouseY) {
  if (!data.length) return null;
  const rect = canvas.getBoundingClientRect();
  const cssX = mouseX - rect.left;
  const cssY = mouseY - rect.top;

  const cssW = rect.width;
  const cssH = rect.height;
  const plot = {
    left: padding.left,
    right: cssW - padding.right,
    top: padding.top + legendH,
    bottom: cssH - padding.bottom,
    x0: view.x0,
    x1: view.x1,
  };

  if (cssX < plot.left || cssX > plot.right || cssY < plot.top || cssY > plot.bottom) return null;

  // Find nearest by x (binary search)
  const xVal = plot.x0 + (cssX - plot.left) / (plot.right - plot.left) * (plot.x1 - plot.x0);
  let lo = 0, hi = data.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (data[mid].x < xVal) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [lo, lo-1, lo+1].filter(i => i >= 0 && i < data.length);
  let best = candidates[0];
  let bestDx = Infinity;
  for (const i of candidates) {
    const dx = Math.abs(data[i].x - xVal);
    if (dx < bestDx) { bestDx = dx; best = i; }
  }
  const p = data[best];
  if (!p) return null;

  return { p, cssX, cssY, plot };
}

function showTooltip(hit) {
  const { p, cssX, cssY } = hit;
  const d = p.t;
  const html = `
    <div class="t">${formatDate(d)}</div>
    <div><span class="k">temp_OUT:</span> <span class="v">${p.temp_OUT}</span></div>
    <div><span class="k">${rightKey}:</span> <span class="v">${p[rightKey]}</span></div>
    <div><span class="k">light:</span> <span class="v">${p.light}</span> <span class="k">moist_lv:</span> <span class="v">${p.moist_lv}</span></div>
  `;
  tooltip.innerHTML = html;
  tooltip.hidden = false;

  const pad = 12;
  const rect = canvas.getBoundingClientRect();
  const tRect = tooltip.getBoundingClientRect();

  let left = cssX + pad;
  let top = cssY + pad;
  if (left + tRect.width > rect.width) left = cssX - tRect.width - pad;
  if (top + tRect.height > rect.height) top = cssY - tRect.height - pad;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

canvas.addEventListener("mousemove", (e) => {
  if (isPanning) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const dx = cssX - panStart.x;
    const span = panStart.x1 - panStart.x0;
    const pxSpan = rect.width - padding.left - padding.right;
    const msPerPx = span / pxSpan;
    const shift = -dx * msPerPx;
    const new0 = clamp(panStart.x0 + shift, xDomainAll[0], xDomainAll[1] - span);
    view.x0 = new0;
    view.x1 = new0 + span;
    draw();
    return;
  }

  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) { hideTooltip(); return; }
  showTooltip(hit);
});

canvas.addEventListener("mouseleave", () => hideTooltip());

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const cssX = e.clientX - rect.left;
  isPanning = true;
  panStart = { x: cssX, x0: view.x0, x1: view.x1 };
});

window.addEventListener("mouseup", () => {
  isPanning = false;
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cssX = e.clientX - rect.left;

  const plotLeft = padding.left;
  const plotRight = rect.width - padding.right;
  if (cssX < plotLeft || cssX > plotRight) return;

  const centerRatio = (cssX - plotLeft) / (plotRight - plotLeft);
  const span = view.x1 - view.x0;
  const zoomFactor = Math.exp(e.deltaY * 0.0012); // wheel up -> zoom in
  const newSpan = clamp(span * zoomFactor, 5 * 60 * 1000, xDomainAll[1] - xDomainAll[0]);

  const center = view.x0 + span * centerRatio;
  let new0 = center - newSpan * centerRatio;
  let new1 = center + newSpan * (1 - centerRatio);
  if (new0 < xDomainAll[0]) { new1 += (xDomainAll[0] - new0); new0 = xDomainAll[0]; }
  if (new1 > xDomainAll[1]) { new0 -= (new1 - xDomainAll[1]); new1 = xDomainAll[1]; }
  new0 = clamp(new0, xDomainAll[0], xDomainAll[1] - newSpan);
  new1 = new0 + newSpan;

  view.x0 = new0;
  view.x1 = new1;
  draw();
}, { passive: false });

// --------- Controls ----------
rightAxisSelect.addEventListener("change", () => {
  rightKey = rightAxisSelect.value;
  draw();
});

rangeSelect.addEventListener("change", () => {
  const v = rangeSelect.value;
  if (v === "all") {
    view.x0 = xDomainAll[0];
    view.x1 = xDomainAll[1];
  } else {
    const hours = v === "6h" ? 6 : 24;
    const end = xDomainAll[1];
    const span = hours * 60 * 60 * 1000;
    view.x1 = end;
    view.x0 = Math.max(xDomainAll[0], end - span);
  }
  draw();
});

resetBtn.addEventListener("click", () => {
  rightAxisSelect.value = "moist_lv";
  rangeSelect.value = "all";
  rightKey = "moist_lv";
  view.x0 = xDomainAll[0];
  view.x1 = xDomainAll[1];
  draw();
});

// --------- Load ----------
async function main() {
  const res = await fetch(CSV_PATH, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  raw = parseCSV(text);

  // normalize
  data = raw
    .map(r => {
      const t = toDate(r);
      return {
        t,
        x: t.getTime(),
        temp_OUT: Number(r.temp_OUT),
        moist_lv: Number(r.moist_lv),
        light: Number(r.light),
      };
    })
    .filter(p => Number.isFinite(p.x))
    .sort((a,b) => a.x - b.x);

  if (!data.length) throw new Error("No data rows");

  xDomainAll = [data[0].x, data[data.length - 1].x];
  view = { x0: xDomainAll[0], x1: xDomainAll[1] };

  draw();
  window.addEventListener("resize", () => draw());
}

main().catch(err => {
  console.error(err);
  statsEl.textContent = String(err);
});

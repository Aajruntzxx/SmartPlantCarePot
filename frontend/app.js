/* Smart Plant Care Pot - Dashboard Logic
 * Real-time SSE + MySQL Database Logs + Dual Threshold Controller
 */

const $ = (id) => document.getElementById(id);

const state = {
  devices: [],
  device: null,      // perangkat yang sedang dipilih
  online: false,
  mode: "AUTO",
  pump: false,
  dryThreshold: 40,
  wetThreshold: 70,
  lightThreshold: 50,
  range: "today",
  stream: null,
  lastLogsFetch: 0,
  historyLogs: [],
  historyFilter: "all",
  historySearch: "",
  historyViewMode: "card",
  notifications: [],   // {id, type, msg, time, read}
  unreadCount: 0,
  _lastDryNotif: 0,
  _lastPumpOnNotif: 0
};

let toastTimer = null;

// ================= NOTIFIKASI ==================

const NOTIF_ICONS = {
  warning: {
    icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`,
    cls: 'type-warning'
  },
  info: {
    icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>`,
    cls: 'type-info'
  },
  offline: {
    icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/></svg>`,
    cls: 'type-offline'
  },
  online: {
    icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    cls: 'type-online'
  }
};

function fmtNotifTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  if (diffMs < 60000) return 'Baru saja';
  if (diffMs < 3600000) return `${Math.floor(diffMs/60000)} menit lalu`;
  if (diffMs < 86400000) return `${Math.floor(diffMs/3600000)} jam lalu`;
  return d.toLocaleString('id-ID', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function addNotification(type, msg) {
  const notif = { id: Date.now(), type, msg, time: Date.now(), read: false };
  state.notifications.unshift(notif);
  if (state.notifications.length > 50) state.notifications.pop();
  state.unreadCount++;
  renderNotifBadge();
  renderNotifPanel();
}

function renderNotifBadge() {
  const badge = $('notifBadge');
  if (!badge) return;
  if (state.unreadCount > 0) {
    badge.textContent = state.unreadCount > 99 ? '99+' : state.unreadCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderNotifPanel() {
  const list = $('notifList');
  const empty = $('notifEmpty');
  if (!list) return;
  list.replaceChildren();
  if (state.notifications.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  state.notifications.forEach(n => {
    const icon = NOTIF_ICONS[n.type] || NOTIF_ICONS.info;
    const item = document.createElement('div');
    item.className = `notif-item${n.read ? '' : ' unread'}`;
    item.innerHTML = `
      <div class="notif-icon ${icon.cls}">${icon.icon}</div>
      <div class="notif-body">
        <div class="notif-msg">${n.msg}</div>
        <div class="notif-time">${fmtNotifTime(n.time)}</div>
      </div>`;
    list.appendChild(item);
  });
}

// Bell toggle
if ($('notifBtn')) {
  $('notifBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('notifPanel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    $('notifBtn').setAttribute('aria-expanded', isOpen);
    if (isOpen) {
      // Mark all as read
      state.notifications.forEach(n => { n.read = true; });
      state.unreadCount = 0;
      renderNotifBadge();
      renderNotifPanel();
    }
  });
}

// Clear all
if ($('clearNotifBtn')) {
  $('clearNotifBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    state.notifications = [];
    state.unreadCount = 0;
    renderNotifBadge();
    renderNotifPanel();
  });
}

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  const panel = $('notifPanel');
  const btn = $('notifBtn');
  if (panel && panel.classList.contains('open')) {
    if (!panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
      panel.classList.remove('open');
      btn?.setAttribute('aria-expanded', 'false');
    }
  }
});

// ================= MOBILE SIDEBAR ==================

if ($('hamburgerBtn')) {
  $('hamburgerBtn').addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    const overlay = $('mobileSidebarOverlay');
    if (sidebar) sidebar.classList.toggle('mobile-open');
    if (overlay) overlay.classList.toggle('active');
  });
}

if ($('mobileSidebarOverlay')) {
  $('mobileSidebarOverlay').addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    const overlay = $('mobileSidebarOverlay');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('active');
  });
}

// ================= UTIL ==================

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "PotPintar" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { location.replace("/login.html"); throw new Error("Belum login"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Terjadi kesalahan.");
  return data;
}

function showToast(message) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

// ================= GRAFIK ==================

function makeChart(canvasId, color, fill, withThreshold) {
  const el = $(canvasId);
  if (!el || typeof Chart === "undefined") return null;
  const datasets = [{
    label: "Nilai",
    data: [],
    borderColor: color,
    backgroundColor: fill,
    fill: true,
    tension: 0.4,
    borderWidth: 2.5,
    pointRadius: 2.5,
    pointHoverRadius: 5
  }];
  if (withThreshold) {
    datasets.push({
      label: "Batas Kering",
      data: [],
      borderColor: "#df7834",
      borderDash: [5, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
    datasets.push({
      label: "Batas Lembab",
      data: [],
      borderColor: "#32976a",
      borderDash: [5, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });
  }
  return new Chart(el, {
    type: "line",
    data: { labels: [], datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 750,
        easing: "easeOutQuart"
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y}%` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#9cb0a2", maxTicksLimit: 6, font: { size: 10 } } },
        y: {
          min: 0, max: 100, grid: { color: "#f0f4f1" },
          ticks: { stepSize: 25, color: "#9cb0a2", callback: (v) => `${v}%`, font: { size: 10 } }
        }
      }
    }
  });
}

// Chart 1: Plant Details - Growth & Humidity (Orange Accent)
const soilChart = makeChart("humidityChart", "#df7834", "rgba(223, 120, 52, 0.16)", true);
// Chart 2: Water Level - Light & Water Dynamics (Blue Accent)
const lightChart = makeChart("lightChart", "#3b82f6", "rgba(59, 130, 246, 0.15)", false);

function labelFor(iso) {
  const d = new Date(iso);
  if (state.range === "today") return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderThresholdLine() {
  if (soilChart && soilChart.data.datasets.length > 2) {
    soilChart.data.datasets[1].data = soilChart.data.labels.map(() => state.dryThreshold);
    soilChart.data.datasets[2].data = soilChart.data.labels.map(() => state.wetThreshold);
    soilChart.update("none");
  }
}

function renderHistoryLogs() {
  const allLogs = state.historyLogs || [];
  const q = (state.historySearch || "").toLowerCase().trim();
  const filter = state.historyFilter || "all";

  // Filter logs sesuai chip dan pencarian
  const filtered = allLogs.filter((r) => {
    // 1. Filter Kategori
    if (filter === "pump-on" && r.pump_status !== "ON") return false;
    if (filter === "pump-off" && r.pump_status !== "OFF") return false;
    if (filter === "soil-dry" && Number(r.soil_moisture) >= Number(state.dryThreshold || 40)) return false;
    if (filter === "mode-auto" && r.mode !== "AUTO") return false;
    if (filter === "mode-manual" && r.mode !== "MANUAL") return false;

    // 2. Search Text
    if (q) {
      const dateStr = new Date(r.recorded_at).toLocaleString("id-ID").toLowerCase();
      const analysis = getPlantAnalysis(r.soil_moisture, r.light_intensity, state.dryThreshold, state.lightThreshold);
      const textMatch =
        dateStr.includes(q) ||
        String(r.mode || "").toLowerCase().includes(q) ||
        String(r.pump_status || "").toLowerCase().includes(q) ||
        analysis.text.toLowerCase().includes(q);
      if (!textMatch) return false;
    }
    return true;
  });

  // Update Summary Stats Bar (Angka Bersih)
  if ($("histStatCount")) $("histStatCount").textContent = allLogs.length;
  if ($("histStatPump")) $("histStatPump").textContent = allLogs.filter((x) => x.pump_status === "ON").length;
  if ($("histStatSoil")) {
    const avgSoil = allLogs.length ? (allLogs.reduce((acc, c) => acc + Number(c.soil_moisture), 0) / allLogs.length).toFixed(1) : "0";
    $("histStatSoil").textContent = `${avgSoil}%`;
  }
  if ($("histStatLight")) {
    const avgLight = allLogs.length ? (allLogs.reduce((acc, c) => acc + Number(c.light_intensity), 0) / allLogs.length).toFixed(1) : "0";
    $("histStatLight").textContent = `${avgLight}%`;
  }
  if ($("historyCountPill")) $("historyCountPill").textContent = `${filtered.length} data`;

  // Render Table View (Tabel Responsif Bersih & Rapi)
  const body = $("historyBody");
  if (body) {
    body.replaceChildren();
    filtered.forEach((r) => {
      const analysis = getPlantAnalysis(r.soil_moisture, r.light_intensity, state.dryThreshold, state.lightThreshold);
      const isPumpOn = r.pump_status === "ON";
      const isAuto = r.mode === "AUTO";
      const isDry = Number(r.soil_moisture) < Number(state.dryThreshold || 40);
      const isBright = Number(r.light_intensity) >= Number(state.lightThreshold || 50);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="history-cell-time">${new Date(r.recorded_at).toLocaleString("id-ID")}</td>
        <td>
          <span class="history-metric-val">${r.soil_moisture}%</span>
          <span class="history-sub-badge ${isDry ? "badge-warn" : "badge-ok"}">${isDry ? "Kering" : "Lembab"}</span>
        </td>
        <td>
          <span class="history-metric-val">${r.light_intensity}%</span>
          <span class="history-sub-badge ${isBright ? "badge-ok" : "badge-subtle"}">${isBright ? "Terang" : "Redup"}</span>
        </td>
        <td>
          <span class="hist-badge ${isPumpOn ? "pump-on" : "pump-off"}">
            ${isPumpOn ? '<span class="pulse-dot"></span> Menyiram' : "Standby"}
          </span>
        </td>
        <td>
          <span class="hist-badge ${isAuto ? "mode-auto" : "mode-manual"}">
            ${isAuto ? "Otomatis" : "Manual"}
          </span>
        </td>
        <td class="history-analysis-text">${analysis.text}</td>
      `;
      body.appendChild(tr);
    });
  }

  if ($("historyEmpty")) $("historyEmpty").hidden = filtered.length > 0;
}

async function loadLogs() {
  if (!state.device) return;
  state.lastLogsFetch = Date.now();
  const refreshBtn = $("historyRefreshBtn");
  if (refreshBtn) refreshBtn.classList.add("spinning");

  try {
    const data = await api(`/api/devices/${state.device.id}/logs?range=${state.range}`);

    const labels = data.series.map((p) => labelFor(p.t));
    if (soilChart) {
      soilChart.data.labels = labels;
      soilChart.data.datasets[0].data = data.series.map((p) => p.soil_moisture);
      renderThresholdLine();
      soilChart.update();
    }

    if (lightChart) {
      lightChart.data.labels = labels;
      lightChart.data.datasets[0].data = data.series.map((p) => p.light_intensity);
      lightChart.update();
    }

    const note = { today: "Rata-rata per 5 menit", "7d": "Rata-rata per 1 jam", "30d": "Rata-rata per 6 jam" }[data.range];
    if ($("chartNote")) $("chartNote").textContent = note;

    state.historyLogs = data.recent || [];
    renderHistoryLogs();
  } catch (e) {
    showToast(e.message);
  } finally {
    if (refreshBtn) {
      setTimeout(() => refreshBtn.classList.remove("spinning"), 500);
    }
  }
}

// ================= STATUS PERANGKAT ==================

function setConnection(online, message) {
  const prevOnline = state.online;
  state.online = online;
  if ($("connectionText")) $("connectionText").textContent = message;
  if ($("sideConnection")) $("sideConnection").textContent = online ? "Online" : "Offline";
  ["topDot", "sideDot"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.classList.toggle("online", online);
      el.classList.toggle("offline", !online);
    }
  });
  if ($("connectionPill")) $("connectionPill").classList.toggle("connected", online);
  if ($("sheetOnlineTag")) {
    $("sheetOnlineTag").textContent = online ? "HEALTHY" : "OFFLINE";
    $("sheetOnlineTag").className = `health-badge ${online ? "healthy" : "offline"}`;
  }
  updatePumpButton();

  // Kirim notifikasi jika status berubah
  if (prevOnline !== null && prevOnline !== undefined && prevOnline !== online) {
    if (online) {
      addNotification("online", "ESP32 berhasil terhubung (Online).");
    } else {
      addNotification("offline", "Koneksi ke ESP32 terputus (Offline).");
    }
  }
}

function updatePumpButton() {
  if ($("pumpButton")) {
    $("pumpButton").disabled = !state.online || state.mode !== "MANUAL";
  }
}

function renderMode(mode) {
  state.mode = mode;
  if ($("autoModeBtn")) $("autoModeBtn").classList.toggle("selected", mode === "AUTO");
  if ($("manualModeBtn")) $("manualModeBtn").classList.toggle("selected", mode === "MANUAL");
  if ($("modeDescriptionTag")) $("modeDescriptionTag").textContent = mode;
  if ($("modeDescription")) {
    $("modeDescription").textContent =
      mode === "AUTO" ? "AUTO - Mengikuti ambang sensor otomatis." : "MANUAL - Kendali manual via website.";
  }
  if ($("pumpHelp")) {
    $("pumpHelp").textContent =
      mode === "AUTO"
        ? "Mode AUTO aktif. Pompa akan menyiram otomatis saat tanah kering dan hari terang."
        : "Mode MANUAL aktif. Tekan tombol di atas untuk menyiram.";
  }
  if ($("dashPumpSub") && !state.pump) {
    $("dashPumpSub").innerHTML = `Mode: <b>${mode === "AUTO" ? "AUTO (Siaga)" : "MANUAL (Mati)"}</b>`;
  }
  updatePumpButton();
}

function renderPump(on) {
  state.pump = Boolean(on);
  if ($("pumpValue")) $("pumpValue").textContent = state.pump ? "AKTIF" : "MATI";
  if ($("pumpDot")) {
    $("pumpDot").classList.toggle("online", state.pump);
    $("pumpDot").classList.toggle("offline", !state.pump);
  }
  if ($("ctrlPumpDot")) {
    $("ctrlPumpDot").classList.toggle("online", state.pump);
    $("ctrlPumpDot").classList.toggle("offline", !state.pump);
  }
  if ($("dashPumpDot")) {
    $("dashPumpDot").classList.toggle("online", state.pump);
    $("dashPumpDot").classList.toggle("offline", !state.pump);
  }
  if ($("dashPumpStatusText")) {
    $("dashPumpStatusText").textContent = state.pump ? "AKTIF" : "MATI";
    $("dashPumpStatusText").style.color = state.pump ? "#10b981" : "#64748b";
  }
  if ($("dashPumpSub")) {
    $("dashPumpSub").innerHTML = state.pump
      ? `<span class="text-green" style="font-weight:700;">Sedang Menyiram Air</span>`
      : `Mode: <b>${state.mode === "AUTO" ? "AUTO (Siaga)" : "MANUAL (Mati)"}</b>`;
  }
  if ($("dashPumpCard")) {
    $("dashPumpCard").classList.toggle("active-pump", state.pump);
  }
  const pumpPanel = document.querySelector(".pump-actuator-panel");
  if (pumpPanel) {
    pumpPanel.classList.toggle("pump-running", state.pump);
  }
  if ($("ctrlPumpStatus")) {
    $("ctrlPumpStatus").textContent = state.pump ? "MENYALAKAN POMPA" : (state.mode === "AUTO" ? "SIAGA (AUTO)" : "MATI (MANUAL)");
    $("ctrlPumpStatus").className = state.pump ? "text-green" : "text-muted";
  }
  if ($("pumpBadge")) {
    $("pumpBadge").textContent = state.pump ? "MENYALA" : (state.mode === "AUTO" ? "AUTO - SIAGA" : "MANUAL - MATI");
    $("pumpBadge").className = `task-badge ${state.pump ? "active" : ""}`;
  }
  if ($("pumpButton")) {
    $("pumpButton").innerHTML = state.pump
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg><span>Matikan Pompa Air</span>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg><span>Nyalakan Pompa Air</span>`;
    $("pumpButton").classList.toggle("stop", state.pump);
  }
  updatePumpButton();
}

// Smooth macOS-style Number Counter for Sensor Values
function updateSensorValueSmooth(el, targetVal, unit = "%") {
  if (!el) return;
  const currentText = el.textContent || "";
  const match = currentText.match(/[-+]?[0-9]*\.?[0-9]+/);
  const currentVal = match ? parseFloat(match[0]) : NaN;
  const roundedTarget = Math.round(targetVal);

  if (isNaN(currentVal) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = `${roundedTarget}${unit}`;
    return;
  }
  if (Math.abs(currentVal - roundedTarget) < 0.5) {
    el.textContent = `${roundedTarget}${unit}`;
    return;
  }

  el.classList.add("value-updating");
  const startVal = currentVal;
  const diff = roundedTarget - startVal;
  const startTime = performance.now();
  const duration = 350;

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = `${Math.round(startVal + diff * ease)}${unit}`;
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      el.textContent = `${roundedTarget}${unit}`;
      setTimeout(() => el.classList.remove("value-updating"), 150);
    }
  }
  requestAnimationFrame(tick);
}

function lightLabel(v) {
  if (v < 30) return "Redup";
  if (v < 70) return "Sedang";
  return "Terang";
}

function getPlantAnalysis(soil, light, dryThr = state.dryThreshold || 40, lightThr = state.lightThreshold || 50) {
  const isMalam = Number(light) < Number(lightThr);
  const isKering = Number(soil) < Number(dryThr);
  const isTinggi = !isMalam;
  const soilState = isKering ? "Kering" : "Lembab";
  const lightState = isTinggi ? "Terang (Siang)" : "Redup (Malam)";

  let text = "";
  let key = "";
  if (isMalam) {
    if (isKering) {
      // Aturan 4: Jika malam hari dan tanah kering
      text = "TANAH KERING - PENYIRAMAN DITUNDA";
      key = "dry-low";
    } else {
      text = "Malam hari: kelembapan terjaga, tanaman beristirahat";
      key = "wet-low";
    }
  } else {
    // Siang hari
    if (isKering) {
      text = `Siang hari: tanah kering (< ${dryThr}%), menyiram otomatis (3 Kriteria Terpenuhi)`;
      key = "dry-high";
    } else {
      text = `Siang hari: kelembapan cukup (>= ${dryThr}%), pompa standby`;
      key = "wet-high";
    }
  }

  return { isKering, isTinggi, isMalam, soilState, lightState, text, key };
}

function renderTelemetry(t) {
  if (!t) return;
  const soil = clamp(Number(t.soil_moisture), 0, 100);
  const light = clamp(Number(t.light_intensity), 0, 100);

  if ($("humidityValue")) updateSensorValueSmooth($("humidityValue"), soil);
  if ($("lightValue")) updateSensorValueSmooth($("lightValue"), light);
  if ($("ctrlHumidity")) updateSensorValueSmooth($("ctrlHumidity"), soil);
  if ($("ctrlLight")) updateSensorValueSmooth($("ctrlLight"), light);
  if ($("humidityBar")) $("humidityBar").style.width = `${soil}%`;
  if ($("lightBar")) $("lightBar").style.width = `${light}%`;

  // Matriks Analisis Kondisi Tanaman
  const analysis = getPlantAnalysis(soil, light, state.dryThreshold, state.lightThreshold);
  if ($("analysisResultText")) $("analysisResultText").textContent = analysis.text;
  if ($("analysisSoilBadge")) {
    $("analysisSoilBadge").textContent = `Tanah: ${analysis.soilState}`;
    $("analysisSoilBadge").className = `sensor-pill-badge ${analysis.isKering ? "state-kering" : "state-basah"}`;
  }
  if ($("analysisLightBadge")) {
    $("analysisLightBadge").textContent = `Cahaya: ${analysis.lightState}`;
    $("analysisLightBadge").className = `sensor-pill-badge ${analysis.isTinggi ? "state-tinggi" : "state-rendah"}`;
  }
  if ($("plantAnalysisCard")) {
    $("plantAnalysisCard").setAttribute("data-analysis", analysis.key);
  }

  // Sorot baris aktif pada tabel acuan analisis
  ["dry-high", "dry-low", "wet-high", "wet-low"].forEach((k) => {
    const row = $(`matrixRow_${k.replace("-", "_")}`);
    if (row) {
      if (k === analysis.key) {
        row.classList.add("row-active");
      } else {
        row.classList.remove("row-active");
      }
    }
  });
  if ($("matrixCurrentStatus")) {
    $("matrixCurrentStatus").textContent = `Kondisi Aktif: ${analysis.soilState} & ${analysis.lightState}`;
  }

  const isMalam = light < (state.lightThreshold || 50);
  let soilStatusText = "";
  let waterStatusTag = "Optimal";
  let waterClass = "good-txt";
  if (soil < state.dryThreshold) {
    soilStatusText = isMalam
      ? `Kering (< ${state.dryThreshold}%) - Ditunda (Malam)`
      : `Kering (< ${state.dryThreshold}%) - Menyiram`;
    waterStatusTag = isMalam ? "Kering (Malam)" : "Kering";
    waterClass = "dry-txt";
  } else if (soil >= state.wetThreshold) {
    soilStatusText = `Lembab (≥ ${state.wetThreshold}%) - Cukup`;
    waterStatusTag = "Lembab";
    waterClass = "wet-txt";
  } else {
    soilStatusText = `Optimal (${state.dryThreshold}% - ${state.wetThreshold}%)`;
    waterStatusTag = "Optimal";
    waterClass = "good-txt";
  }

  if ($("soilStatus")) $("soilStatus").textContent = soilStatusText;
  if ($("ctrlSoilStatus")) $("ctrlSoilStatus").textContent = waterStatusTag;
  const lightTxt = isMalam ? `Redup/Malam (< ${state.lightThreshold}%)` : `Terang/Siang (≥ ${state.lightThreshold}%)`;
  if ($("lightStatus")) $("lightStatus").textContent = lightTxt;
  if ($("ctrlLightStatus")) $("ctrlLightStatus").textContent = isMalam ? "Malam" : "Siang";
  if ($("lightChartStatus")) $("lightChartStatus").textContent = lightTxt;

  if ($("wateringStatus")) {
    if (t.pump_status === "ON") {
      $("wateringStatus").textContent = "Sedang menyiram (Penyiraman Otomatis)";
    } else if (soil < (state.dryThreshold || 60) && isMalam) {
      $("wateringStatus").textContent = "TANAH KERING - PENYIRAMAN DITUNDA";
    } else {
      $("wateringStatus").textContent = "Pompa Siaga (Mati)";
    }
  }
  if ($("wateringStatusNote")) {
    if (t.pump_status === "ON") {
      $("wateringStatusNote").textContent = "Pompa menyiram • Otomatis";
    } else if (soil < (state.dryThreshold || 60) && isMalam) {
      $("wateringStatusNote").textContent = "TANAH KERING - PENYIRAMAN DITUNDA";
    } else {
      $("wateringStatusNote").textContent = "Sistem Otomatis Terjaga";
    }
  }

  if ($("activeWaterStatus")) {
    $("activeWaterStatus").textContent = waterStatusTag;
    $("activeWaterStatus").className = waterClass;
  }
  if ($("activeWaterProgress")) {
    $("activeWaterProgress").style.width = `${soil}%`;
  }

  // Update Vertical Glassmorphic Ruler Gauge (Phone 3 Mockup)
  if ($("gaugeHumidity")) $("gaugeHumidity").textContent = `${Math.round(soil)}%`;
  if ($("gaugeSunlight")) $("gaugeSunlight").textContent = `${Math.round(light)}%`;
  if ($("gaugeStatus")) $("gaugeStatus").textContent = waterStatusTag;
  if ($("gaugeThumb")) $("gaugeThumb").style.bottom = `${clamp(soil, 8, 92)}%`;

  // Notifikasi cerdas: kelembapan tanah di bawah batas kering pada mode AUTO
  if (soil < state.dryThreshold && state.mode === "AUTO") {
    if (!state._lastDryNotif || Date.now() - state._lastDryNotif > 60000) {
      addNotification("warning", `Tanah terlalu kering! Kelembapan ${Math.round(soil)}% (< batas ${state.dryThreshold}%).`);
      state._lastDryNotif = Date.now();
    }
  }

  // Notifikasi cerdas: pompa aktif
  if (t.pump_status === "ON" && !state.pump) {
    if (!state._lastPumpOnNotif || Date.now() - state._lastPumpOnNotif > 30000) {
      addNotification("info", "Pompa air otomatis diaktifkan untuk penyiraman.");
      state._lastPumpOnNotif = Date.now();
    }
  }

  renderMode(t.mode);
  renderPump(t.pump_status === "ON");
  renderReported(t.reported_dry_threshold ?? t.reported_threshold, t.reported_wet_threshold, t.reported_light_threshold);
}

function renderReported(dry, wet, light) {
  if ($("reportedDry")) $("reportedDry").textContent = (dry === null || dry === undefined) ? "--" : `${Number(dry)}%`;
  if ($("reportedWet")) $("reportedWet").textContent = (wet === null || wet === undefined) ? "--" : `${Number(wet)}%`;
  if ($("reportedLight")) $("reportedLight").textContent = (light === null || light === undefined) ? "--" : `${Number(light)}%`;
}

function updateZoneBar(dry, wet) {
  const d = clamp(dry, 0, 100);
  const w = clamp(wet, 0, 100);
  const left = Math.min(d, w);
  const mid = Math.max(0, w - d);
  const right = Math.max(0, 100 - Math.max(d, w));

  const dryEl = $("zoneDry");
  const idealEl = $("zoneIdeal");
  const wetEl = $("zoneWet");
  if (dryEl) dryEl.style.width = `${left}%`;
  if (idealEl) idealEl.style.width = `${mid}%`;
  if (wetEl) wetEl.style.width = `${right}%`;
}

function renderThreshold(dry, wet, light = 50) {
  state.dryThreshold = Number(dry);
  state.wetThreshold = Number(wet);
  state.lightThreshold = Number(light ?? 50);

  if ($("savedDry")) $("savedDry").textContent = `${state.dryThreshold}%`;
  if ($("savedWet")) $("savedWet").textContent = `${state.wetThreshold}%`;
  if ($("savedLight")) $("savedLight").textContent = `${state.lightThreshold}%`;

  if ($("dryInput")) $("dryInput").value = state.dryThreshold;
  if ($("dryRange")) $("dryRange").value = state.dryThreshold;
  if ($("wetInput")) $("wetInput").value = state.wetThreshold;
  if ($("wetRange")) $("wetRange").value = state.wetThreshold;
  if ($("lightInput")) $("lightInput").value = state.lightThreshold;
  if ($("lightRange")) $("lightRange").value = state.lightThreshold;

  if ($("ruleText")) {
    $("ruleText").textContent =
      `Pompa ON jika kelembapan < ${state.dryThreshold}%, OFF jika kelembapan ≥ ${state.wetThreshold}%. Kategori Cahaya Tinggi ≥ ${state.lightThreshold}%.`;
  }

  updateZoneBar(state.dryThreshold, state.wetThreshold);
  renderThresholdLine();
}

// ================= REAL-TIME (SSE) ==================

function openStream() {
  if (state.stream) state.stream.close();
  const es = new EventSource(`/api/devices/${state.device.id}/stream`);
  state.stream = es;

  es.addEventListener("init", (e) => {
    const d = JSON.parse(e.data);
    setConnection(d.online, d.online ? "ESP32 online" : "ESP32 offline");
    const dry = d.dry_threshold ?? d.soil_threshold ?? 40;
    const wet = d.wet_threshold ?? 70;
    const light = d.light_threshold ?? 50;
    renderThreshold(dry, wet, light);
    renderReported(d.reported_dry_threshold ?? d.reported_threshold, d.reported_wet_threshold, d.reported_light_threshold);
    if (d.latest) renderTelemetry(d.latest);
  });

  es.addEventListener("telemetry", (e) => {
    const t = JSON.parse(e.data);
    setConnection(true, "ESP32 online");
    renderTelemetry(t);
    if (Date.now() - state.lastLogsFetch > 30000) loadLogs();
  });

  es.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    setConnection(s.online, s.online ? "ESP32 online" : "ESP32 offline");
  });

  es.onerror = () => {
    setConnection(false, "Menyambung ke server...");
  };
}

// ================= KONTROL ==================

async function sendCommand(cmd) {
  try {
    await api(`/api/devices/${state.device.id}/command`, { method: "POST", body: cmd });
    showToast("Perintah dikirim ke ESP32.");
  } catch (e) {
    showToast(e.message);
  }
}

if ($("autoModeBtn")) $("autoModeBtn").addEventListener("click", () => sendCommand({ mode: "AUTO" }));
if ($("manualModeBtn")) $("manualModeBtn").addEventListener("click", () => sendCommand({ mode: "MANUAL" }));
if ($("pumpButton")) {
  $("pumpButton").addEventListener("click", () => {
    if (state.mode !== "MANUAL") return;
    sendCommand({ mode: "MANUAL", pump: state.pump ? "OFF" : "ON" });
  });
}

// ================= PENGATURAN AMBANG ==================

if ($("dryRange") && $("dryInput")) {
  $("dryRange").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("dryInput").value = v;
    updateZoneBar(v, Number($("wetInput").value));
  });
  $("dryInput").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) {
      $("dryRange").value = clamp(v, 0, 100);
      updateZoneBar(clamp(v, 0, 100), Number($("wetInput").value));
    }
  });
}

if ($("wetRange") && $("wetInput")) {
  $("wetRange").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("wetInput").value = v;
    updateZoneBar(Number($("dryInput").value), v);
  });
  $("wetInput").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) {
      $("wetRange").value = clamp(v, 0, 100);
      updateZoneBar(Number($("dryInput").value), clamp(v, 0, 100));
    }
  });
}

if ($("lightRange") && $("lightInput")) {
  $("lightRange").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("lightInput").value = v;
  });
  $("lightInput").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) {
      $("lightRange").value = clamp(v, 0, 100);
    }
  });
}

if ($("saveThresholdBtn")) {
  $("saveThresholdBtn").addEventListener("click", async () => {
    const msg = $("thresholdMsg");
    const rawDry = $("dryInput").value.trim();
    const rawWet = $("wetInput").value.trim();
    const rawLight = $("lightInput") ? $("lightInput").value.trim() : "50";
    const dryVal = Number(rawDry);
    const wetVal = Number(rawWet);
    const lightVal = Number(rawLight);

    msg.hidden = false;
    if (rawDry === "" || !Number.isFinite(dryVal) || dryVal < 0 || dryVal > 100) {
      msg.className = "form-error";
      msg.textContent = "Batas kering harus berupa angka antara 0 dan 100.";
      return;
    }
    if (rawWet === "" || !Number.isFinite(wetVal) || wetVal < 0 || wetVal > 100) {
      msg.className = "form-error";
      msg.textContent = "Batas lembab harus berupa angka antara 0 dan 100.";
      return;
    }
    if (rawLight === "" || !Number.isFinite(lightVal) || lightVal < 0 || lightVal > 100) {
      msg.className = "form-error";
      msg.textContent = "Batas cahaya harus berupa angka antara 0 dan 100.";
      return;
    }
    if (dryVal >= wetVal) {
      msg.className = "form-error";
      msg.textContent = "Batas kering harus lebih kecil dari batas lembab.";
      return;
    }

    $("saveThresholdBtn").disabled = true;
    try {
      const r = await api(`/api/devices/${state.device.id}/threshold`, {
        method: "PUT",
        body: { dry_threshold: dryVal, wet_threshold: wetVal, light_threshold: lightVal }
      });
      renderThreshold(r.dry_threshold, r.wet_threshold, r.light_threshold);
      msg.className = "form-ok";
      msg.textContent = r.message;
    } catch (e) {
      msg.className = "form-error";
      msg.textContent = e.message;
    } finally {
      $("saveThresholdBtn").disabled = false;
    }
  });
}

// ================= RENTANG RIWAYAT ==================

if ($("rangeTabs")) {
  $("rangeTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    state.range = btn.dataset.range;
    [...$("rangeTabs").children].forEach((b) => b.classList.toggle("selected", b === btn));
    loadLogs();
  });
}

// ================= TAB NAVIGATION ==================

function switchTab(tab) {
  // Update floating dock dan sidebar nav items
  document.querySelectorAll(".dock-nav-item, .nav-item, .mobile-nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.tab === tab);
  });

  // Switch active tab view
  document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.remove("active"));
  const target = $(`view-${tab}`) || $("view-dashboard");
  if (target) target.classList.add("active");

  // Tutup mobile drawer jika sedang terbuka
  const sidebar = document.querySelector(".sidebar");
  const overlay = $("mobileSidebarOverlay");
  if (sidebar) sidebar.classList.remove("mobile-open");
  if (overlay) overlay.classList.remove("active");

  // Scroll kembali ke atas dengan mulus
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (tab === "history") loadLogs();
}
window.switchTab = switchTab;

document.querySelectorAll(".dock-nav-item, .nav-item, .mobile-nav-item").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    switchTab(link.dataset.tab);
  });
});

// Click Hero Plant Card on Mobile opens the Detail & Gauge screen
if ($("heroPlantCard")) {
  $("heroPlantCard").addEventListener("click", () => {
    if (window.innerWidth <= 860) {
      switchTab("control");
    }
  });
}

// Quick Flash Action button on top right of detail view (toggles AUTO / MANUAL)
if ($("quickModeBtn")) {
  $("quickModeBtn").addEventListener("click", () => {
    const newMode = state.mode === "AUTO" ? "MANUAL" : "AUTO";
    sendCommand({ mode: newMode });
  });
}

// Search filter for Plant cards
if ($("potSearchInput")) {
  $("potSearchInput").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    document.querySelectorAll(".plant-card, .variant-plant-card").forEach((card) => {
      const text = card.textContent.toLowerCase();
      card.style.display = text.includes(q) ? "" : "none";
    });
  });
}

// Room category filter tabs
if ($("roomFilterRow")) {
  $("roomFilterRow").addEventListener("click", (e) => {
    const btn = e.target.closest(".room-pill");
    if (!btn) return;
    [...$("roomFilterRow").children].forEach((b) => b.classList.toggle("active", b === btn));
    const filter = (btn.dataset.filter || "all").toLowerCase();
    document.querySelectorAll(".plant-card").forEach((card) => {
      if (filter === "all") {
        card.style.display = "";
      } else {
        const room = (card.getAttribute("data-room") || "").toLowerCase();
        card.style.display = room.includes(filter) ? "" : "none";
      }
    });
  });
}

// ================= INTERAKTIVITAS RIWAYAT LOG TELEMETRI =================
if ($("historySearchInput")) {
  $("historySearchInput").addEventListener("input", (e) => {
    state.historySearch = e.target.value;
    if ($("historySearchClear")) $("historySearchClear").hidden = !e.target.value;
    renderHistoryLogs();
  });
}

if ($("historySearchClear")) {
  $("historySearchClear").addEventListener("click", () => {
    if ($("historySearchInput")) $("historySearchInput").value = "";
    state.historySearch = "";
    $("historySearchClear").hidden = true;
    renderHistoryLogs();
  });
}

document.querySelectorAll(".history-filter-chips .filter-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".history-filter-chips .filter-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.historyFilter = chip.dataset.filter || "all";
    renderHistoryLogs();
  });
});

if ($("historyRefreshBtn")) {
  $("historyRefreshBtn").addEventListener("click", () => {
    loadLogs();
  });
}

// Modal Claim Perangkat
function openClaimModal() {
  const m = $("claimModal");
  if (m) {
    m.hidden = false;
    m.classList.remove("is-hidden");
    m.style.display = "grid";
    const input = m.querySelector("input[name='device_code']");
    if (input) input.focus();
  }
}
function closeClaimModal() {
  const m = $("claimModal");
  if (m) {
    m.hidden = true;
    m.classList.add("is-hidden");
    m.style.display = "none";
  }
}
window.openClaimModal = openClaimModal;
window.closeClaimModal = closeClaimModal;

if ($("openClaimBtn")) $("openClaimBtn").addEventListener("click", openClaimModal);
if ($("sidebarAddBtn")) $("sidebarAddBtn").addEventListener("click", openClaimModal);
if ($("closeClaimBtn")) $("closeClaimBtn").addEventListener("click", closeClaimModal);

if ($("claimModal")) {
  $("claimModal").addEventListener("click", (e) => {
    if (e.target === $("claimModal")) {
      closeClaimModal();
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("claimModal") && !$("claimModal").hidden) {
    closeClaimModal();
  }
});

// ================= PERANGKAT & AKUN ==================

const PLANT_PRESETS = [
  {
    name: "Monstera",
    room: "LIVING ROOM",
    svg: `<svg viewBox="0 0 120 120" width="85" height="85" fill="none">
      <ellipse cx="60" cy="104" rx="22" ry="7" fill="#d1e3d6"/>
      <path d="M44 80 L48 104 C49 107, 71 107, 72 104 L76 80 Z" fill="#ffffff" stroke="#c2d9c8" stroke-width="2"/>
      <path d="M60 80 Q58 50 54 28" stroke="#2e7d43" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M60 70 Q45 52 32 44" stroke="#388e4c" stroke-width="3" stroke-linecap="round"/>
      <path d="M60 65 Q75 48 88 42" stroke="#388e4c" stroke-width="3" stroke-linecap="round"/>
      <path d="M54 28 C42 16 52 4 60 8 C68 4 78 16 66 28 C62 32 58 32 54 28 Z" fill="#22c55e"/>
      <circle cx="56" cy="18" r="2" fill="#e5f2e8"/>
      <circle cx="64" cy="18" r="2" fill="#e5f2e8"/>
      <path d="M32 44 C20 34 26 22 36 26 C44 24 50 34 42 44 Z" fill="#16a34a"/>
      <path d="M88 42 C100 34 94 22 84 26 C76 24 70 34 78 44 Z" fill="#16a34a"/>
    </svg>`
  },
  {
    name: "Fiddle Leaf",
    room: "BEDROOM",
    svg: `<svg viewBox="0 0 120 120" width="85" height="85" fill="none">
      <ellipse cx="60" cy="104" rx="20" ry="6" fill="#d1e3d6"/>
      <path d="M46 84 L49 104 C50 106, 70 106, 71 104 L74 84 Z" fill="#ffffff" stroke="#c2d9c8" stroke-width="2"/>
      <path d="M60 84 L60 30" stroke="#4d7c0f" stroke-width="3.5" stroke-linecap="round"/>
      <ellipse cx="60" cy="28" rx="14" ry="20" fill="#15803d"/>
      <ellipse cx="48" cy="46" rx="12" ry="16" fill="#16a34a" transform="rotate(-20 48 46)"/>
      <ellipse cx="72" cy="46" rx="12" ry="16" fill="#16a34a" transform="rotate(20 72 46)"/>
      <ellipse cx="50" cy="68" rx="11" ry="14" fill="#22c55e" transform="rotate(-25 50 68)"/>
      <ellipse cx="70" cy="68" rx="11" ry="14" fill="#22c55e" transform="rotate(25 70 68)"/>
    </svg>`
  },
  {
    name: "Snake Plant",
    room: "OFFICE",
    svg: `<svg viewBox="0 0 120 120" width="85" height="85" fill="none">
      <ellipse cx="60" cy="104" rx="20" ry="6" fill="#d1e3d6"/>
      <path d="M45 84 L48 104 C49 106, 71 106, 72 104 L75 84 Z" fill="#ffffff" stroke="#c2d9c8" stroke-width="2"/>
      <path d="M50 84 Q48 50 56 16 Q62 50 58 84 Z" fill="#166534" stroke="#ca8a04" stroke-width="1.5"/>
      <path d="M60 84 Q58 45 64 22 Q68 45 66 84 Z" fill="#15803d" stroke="#eab308" stroke-width="1.5"/>
      <path d="M44 84 Q40 55 46 32 Q52 55 50 84 Z" fill="#14532d" stroke="#ca8a04" stroke-width="1.5"/>
      <path d="M68 84 Q74 55 70 32 Q66 55 64 84 Z" fill="#166534" stroke="#eab308" stroke-width="1.5"/>
    </svg>`
  },
  {
    name: "Pothos",
    room: "KITCHEN",
    svg: `<svg viewBox="0 0 120 120" width="85" height="85" fill="none">
      <ellipse cx="60" cy="98" rx="22" ry="7" fill="#d1e3d6"/>
      <path d="M42 74 L46 98 C47 101, 73 101, 74 98 L78 74 Z" fill="#ffffff" stroke="#c2d9c8" stroke-width="2"/>
      <path d="M60 74 Q40 58 36 78 Q30 92 26 96" stroke="#15803d" stroke-width="2.5" fill="none"/>
      <path d="M60 74 Q80 58 84 78 Q90 92 94 96" stroke="#15803d" stroke-width="2.5" fill="none"/>
      <circle cx="60" cy="60" r="16" fill="#22c55e"/>
      <circle cx="46" cy="54" r="12" fill="#4ade80"/>
      <circle cx="74" cy="54" r="12" fill="#4ade80"/>
      <circle cx="34" cy="74" r="9" fill="#16a34a"/>
      <circle cx="86" cy="74" r="9" fill="#16a34a"/>
    </svg>`
  },
  {
    name: "ZZ Plant",
    room: "BEDROOM",
    svg: `<svg viewBox="0 0 120 120" width="85" height="85" fill="none">
      <ellipse cx="60" cy="104" rx="20" ry="6" fill="#d1e3d6"/>
      <path d="M46 84 L49 104 C50 106, 70 106, 71 104 L74 84 Z" fill="#ffffff" stroke="#c2d9c8" stroke-width="2"/>
      <path d="M54 84 Q50 50 48 24" stroke="#166534" stroke-width="3" stroke-linecap="round"/>
      <path d="M66 84 Q70 50 72 24" stroke="#166534" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="44" cy="28" rx="6" ry="10" fill="#15803d" transform="rotate(-30 44 28)"/>
      <ellipse cx="56" cy="34" rx="6" ry="10" fill="#22c55e" transform="rotate(30 56 34)"/>
      <ellipse cx="42" cy="46" rx="6" ry="10" fill="#15803d" transform="rotate(-30 42 46)"/>
      <ellipse cx="58" cy="52" rx="6" ry="10" fill="#22c55e" transform="rotate(30 58 52)"/>
    </svg>`
  },
  {
    name: "Spider Plant",
    room: "OFFICE",
    svg: `<svg viewBox="0 0 120 120" width="85" height="85" fill="none">
      <ellipse cx="60" cy="104" rx="22" ry="7" fill="#d1e3d6"/>
      <path d="M46 84 L49 104 C50 106, 70 106, 71 104 L75 84 Z" fill="#ffffff" stroke="#c2d9c8" stroke-width="2"/>
      <path d="M60 84 Q30 50 18 65" stroke="#15803d" stroke-width="2.5" fill="none"/>
      <path d="M60 84 Q90 50 102 65" stroke="#15803d" stroke-width="2.5" fill="none"/>
      <path d="M60 84 Q40 35 30 42" stroke="#22c55e" stroke-width="2.5" fill="none"/>
      <path d="M60 84 Q80 35 90 42" stroke="#22c55e" stroke-width="2.5" fill="none"/>
    </svg>`
  }
];

function renderPlantList() {
  const container = $("plantListItems");
  if (!container) return;
  container.replaceChildren();

  if ($("deviceCountPill")) {
    $("deviceCountPill").textContent = `${state.devices.length} Pot`;
  }

  if (state.devices.length === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "notif-empty";
    emptyP.textContent = "Belum ada pot terhubung. Klik '+ Tambah Pot' untuk memulai.";
    container.appendChild(emptyP);
    return;
  }

  state.devices.forEach((d, idx) => {
    const isSelected = state.device && state.device.id === d.id;
    const preset = PLANT_PRESETS[idx % PLANT_PRESETS.length];
    const room = preset.room;

    const isDry = state.online && state.device && state.device.id === d.id
      ? (state.latestMoisture !== undefined && state.latestMoisture < state.dryThreshold)
      : false;

    const card = document.createElement("div");
    card.className = `plant-card${isSelected ? " selected" : ""}`;
    card.setAttribute("data-id", d.id);
    card.setAttribute("data-room", room.toLowerCase());

    const statusText = isDry
      ? "Needs Water"
      : (isSelected ? "Optimal • Active" : "Next water: 3 days");

    const statusIcon = "";

    card.innerHTML = `
      <div class="plant-card-visual">
        <span class="room-tag">${room}</span>
        <div class="plant-illustration">
          ${preset.svg}
        </div>
      </div>
      <div class="plant-card-content">
        <div class="plant-card-title-row">
          <strong class="plant-name">${d.device_name || preset.name}</strong>
          <span class="plant-status-icon">${statusIcon}</span>
        </div>
        <span class="plant-subtitle ${isDry ? "needs-water" : ""}">${statusText}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      const sel = $("deviceSelect");
      if (sel) sel.value = d.id;
      selectDevice(d);
    });

    container.appendChild(card);
  });
}

function selectDevice(device) {
  state.device = device;
  if ($("deviceCodeLabel")) $("deviceCodeLabel").textContent = device.device_code;
  if ($("heroPlantName")) $("heroPlantName").textContent = device.device_name;
  if ($("heroPlantSubtitle")) $("heroPlantSubtitle").textContent = device.device_code;
  if ($("activePlantTitle")) $("activePlantTitle").textContent = device.device_name;
  if ($("activePlantSubtitle")) $("activePlantSubtitle").textContent = device.device_code;
  if ($("sheetPlantTitle")) $("sheetPlantTitle").textContent = device.device_name;

  renderPlantList();

  const dry = device.dry_threshold ?? device.soil_threshold ?? 40;
  const wet = device.wet_threshold ?? 70;
  const light = device.light_threshold ?? 50;
  renderThreshold(dry, wet, light);
  renderReported(device.reported_dry_threshold ?? device.reported_threshold, device.reported_wet_threshold, device.reported_light_threshold);
  setConnection(false, "Memuat...");
  openStream();
  loadLogs();
}

function showApp(hasDevices) {
  if (!hasDevices) {
    openClaimModal();
  } else {
    closeClaimModal();
  }
}

async function loadDevices(selectId) {
  const { devices } = await api("/api/devices");
  state.devices = devices;
  const sel = $("deviceSelect");
  if (sel) {
    sel.replaceChildren();
    devices.forEach((d) => {
      const o = document.createElement("option");
      o.value = d.id;
      o.textContent = d.device_name;
      sel.appendChild(o);
    });
  }
  showApp(devices.length > 0);
  if (!devices.length) { setConnection(false, "Belum ada perangkat"); renderPlantList(); return; }
  const chosen = devices.find((d) => d.id === selectId) || devices[0];
  if (sel) sel.value = chosen.id;
  selectDevice(chosen);
}

if ($("deviceSelect")) {
  $("deviceSelect").addEventListener("change", (e) => {
    const d = state.devices.find((x) => String(x.id) === e.target.value);
    if (d) selectDevice(d);
  });
}

if ($("claimForm")) {
  $("claimForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("claimError");
    if (err) err.hidden = true;
    try {
      const code = e.target.device_code.value.trim();
      const name = e.target.device_name.value.trim();
      const { device } = await api("/api/devices", {
        method: "POST",
        body: { device_code: code, device_name: name }
      });
      closeClaimModal();
      await loadDevices(device.id);
      showToast("Perangkat berhasil ditambahkan!");
    } catch (ex) {
      if (err) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    }
  });
}

if ($("logoutBtn")) {
  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    location.replace("/login.html");
  });
}

// Inisialisasi Tanggal & Salam
function initDate() {
  const d = new Date();
  const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const formatted = `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  if ($("currentDateDisplay")) $("currentDateDisplay").textContent = formatted;

  const hour = d.getHours();
  let greet = "Good Morning";
  if (hour >= 12 && hour < 17) greet = "Good Afternoon";
  else if (hour >= 17 || hour < 5) greet = "Good Evening";
  if ($("greetingTitle")) $("greetingTitle").textContent = greet;
}

(async function init() {
  initDate();
  try {
    const { user } = await api("/api/auth/me");
    if ($("userName")) {
      $("userName").textContent = user.name;
      $("userName").title = user.name;
    }
    if ($("welcomeUserName")) $("welcomeUserName").textContent = user.name;
    const initial = (user.name || "U")[0].toUpperCase();
    if ($("userInitial")) $("userInitial").textContent = initial;
    if ($("topbarUserInitial")) $("topbarUserInitial").textContent = initial;
    if ($("topbarUserName")) $("topbarUserName").textContent = user.name ? user.name.split(" ")[0] : "User";
    await loadDevices();
  } catch (e) {
    if (e.message !== "Belum login") showToast(e.message);
  }
})();

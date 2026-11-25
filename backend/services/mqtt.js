const mqtt = require("mqtt");
const db = require("../config/database");
const realtime = require("./realtime");

const ROOT = process.env.MQTT_TOPIC_ROOT || "potpintar";
const OFFLINE_AFTER_MS = Number(process.env.DEVICE_OFFLINE_AFTER_SEC || 45) * 1000;
const CODE_RE = /^[A-Za-z0-9_-]{3,64}$/;

// Pola topic: potpintar/<device_code>/{telemetry|config|status|command}
const topic = (code, kind) => `${ROOT}/${code}/${kind}`;

let client = null;

// State sementara perangkat (hanya untuk status online dan telemetri terakhir).
// Riwayat dan konfigurasi permanen tetap di MySQL.
const state = new Map(); // device_code -> { deviceId, lastSeenMs, reportedOnline, latest }

function getState(code) {
  if (!state.has(code)) {
    state.set(code, { deviceId: null, lastSeenMs: 0, reportedOnline: false, latest: null });
  }
  return state.get(code);
}

function isOnline(s) {
  return s.reportedOnline && Date.now() - s.lastSeenMs <= OFFLINE_AFTER_MS;
}

function snapshot(code) {
  const s = getState(code);
  return {
    online: isOnline(s),
    last_seen_ms: s.lastSeenMs || null,
    latest: s.latest
  };
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function normalizeTelemetry(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return p;
  const out = { ...p };

  // Kompatibilitas dengan nama field lama / variasi simulator
  if (out.soil_moisture === undefined && out.humidity !== undefined) {
    out.soil_moisture = typeof out.humidity === "string" ? parseFloat(out.humidity) : out.humidity;
  }
  if (out.light_intensity === undefined && out.light !== undefined) {
    out.light_intensity = typeof out.light === "string" ? parseFloat(out.light) : out.light;
  }
  if (typeof out.soil_moisture === "string") {
    out.soil_moisture = parseFloat(out.soil_moisture);
  }
  if (typeof out.light_intensity === "string") {
    out.light_intensity = parseFloat(out.light_intensity);
  }
  if (out.pump_status === undefined && out.pump !== undefined) {
    out.pump_status = (out.pump === true || out.pump === "ON" || out.pump === 1 || out.pump === "1") ? "ON" : "OFF";
  }
  if (!out.mode || (out.mode !== "AUTO" && out.mode !== "MANUAL")) {
    out.mode = "AUTO";
  }
  return out;
}

function validateTelemetry(p, codeFromTopic) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "payload bukan objek";
  if (p.device_id !== undefined && p.device_id !== codeFromTopic) return "device_id tidak cocok dengan topic";
  if (!isNum(p.soil_moisture) || p.soil_moisture < 0 || p.soil_moisture > 100) return "soil_moisture tidak valid";
  if (!isNum(p.light_intensity) || p.light_intensity < 0 || p.light_intensity > 100) return "light_intensity tidak valid";
  if (p.pump_status !== "ON" && p.pump_status !== "OFF") return "pump_status tidak valid";
  if (p.mode !== "AUTO" && p.mode !== "MANUAL") return "mode tidak valid";
  if (p.dry_threshold !== undefined && (!isNum(p.dry_threshold) || p.dry_threshold < 0 || p.dry_threshold > 100)) {
    return "dry_threshold tidak valid";
  }
  if (p.wet_threshold !== undefined && (!isNum(p.wet_threshold) || p.wet_threshold < 0 || p.wet_threshold > 100)) {
    return "wet_threshold tidak valid";
  }
  if (p.soil_threshold !== undefined && (!isNum(p.soil_threshold) || p.soil_threshold < 0 || p.soil_threshold > 100)) {
    return "soil_threshold tidak valid";
  }
  if (p.light_threshold !== undefined && (!isNum(p.light_threshold) || p.light_threshold < 0 || p.light_threshold > 100)) {
    return "light_threshold tidak valid";
  }
  return null;
}

async function findDevice(code) {
  const [rows] = await db.execute(
    "SELECT id, dry_threshold, wet_threshold, soil_threshold, light_threshold FROM devices WHERE device_code = ? LIMIT 1",
    [code]
  );
  return rows[0] || null;
}

function computePlantAnalysis(soil, light, dryThr, lightThr) {
  const isMalam = Number(light) < Number(lightThr || 50);
  const isKering = Number(soil) < Number(dryThr || 40);

  if (isMalam) {
    if (isKering) {
      // Aturan 4: Jika malam hari dan tanah kering, tampilkan status ini
      return "TANAH KERING - PENYIRAMAN DITUNDA";
    }
    return "Malam hari: kelembapan terjaga, tanaman beristirahat";
  } else {
    // Siang hari
    if (isKering) {
      return `Siang hari: tanah kering (< ${dryThr}%), menyiram otomatis (3 Kriteria Terpenuhi)`;
    }
    return `Siang hari: kelembapan cukup (>= ${dryThr}%), pompa standby`;
  }
}

async function handleTelemetry(code, p) {
  const device = await findDevice(code);
  if (!device) return;

  const dryThr = Number(device.dry_threshold ?? device.soil_threshold ?? 40);
  const wetThr = Number(device.wet_threshold ?? 70);
  const lightThr = Number(device.light_threshold ?? 50);

  const soil = Number(p.soil_moisture);
  const light = Number(p.light_intensity);
  const currentPump = p.pump_status; // "ON" | "OFF"
  const isMalam = light < lightThr;

  // ==================== FULL CLOUD DECISION ENGINE ====================
  // Logika Pompa Menyala dan Mati Memenuhi 3 Kriteria Pengaturan User:
  // 1. Kriteria Cahaya (light_threshold): Pompa HANYA boleh menyiram saat Siang/Terang (light >= lightThr).
  //    Jika Malam/Gelap (light < lightThr), pompa SELALU OFF meskipun tanah kering!
  // 2. Kriteria Batas Kering (dry_threshold): Pompa MENYALA saat tanah kering (soil < dryThr).
  // 3. Kriteria Batas Lembab (wet_threshold): Pompa MATI saat tanah lembab (soil >= wetThr).
  // Di antara dryThr dan wetThr: sistem mempertahankan status pompa (histeresis).
  if (p.mode === "AUTO") {
    let desiredPump = currentPump;

    if (isMalam) {
      // Kriteria 3: Malam Hari -> Pompa WAJIB MATI
      desiredPump = "OFF";
    } else {
      // Evaluasi Kriteria 1 & 2 di Siang Hari
      if (soil < dryThr) {
        desiredPump = "ON";
      } else if (soil >= wetThr) {
        desiredPump = "OFF";
      }
    }

    if (desiredPump !== currentPump) {
      console.log(
        `[CLOUD DECISION] Perangkat ${code}: Mode AUTO -> Soil=${soil}% (dry=${dryThr}%, wet=${wetThr}%), Light=${light}% (lightThr=${lightThr}%, ${isMalam ? "MALAM" : "SIANG"}) => Keputusan Pompa: ${desiredPump}`
      );
      publishCommand(code, { pump: desiredPump });
      p.pump_status = desiredPump;
    }
  }

  p.analysis = computePlantAnalysis(soil, light, dryThr, lightThr);
  p.soil_state = soil < dryThr ? "Kering" : (soil >= wetThr ? "Basah" : "Optimal");
  p.light_state = isMalam ? "Redup (Malam)" : "Terang (Siang)";

  const now = new Date();
  await db.execute(
    `INSERT INTO sensor_logs (device_id, soil_moisture, light_intensity, pump_status, mode, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [device.id, p.soil_moisture, p.light_intensity, p.pump_status, p.mode, now]
  );

  const reportedDry = p.dry_threshold ?? p.soil_threshold ?? null;
  const reportedWet = p.wet_threshold ?? null;
  const reportedLight = p.light_threshold ?? null;

  await db.execute(
    `UPDATE devices SET
       last_seen_at = ?,
       reported_dry_threshold = COALESCE(?, reported_dry_threshold),
       reported_wet_threshold = COALESCE(?, reported_wet_threshold),
       reported_threshold = COALESCE(?, reported_threshold),
       reported_light_threshold = COALESCE(?, reported_light_threshold)
     WHERE id = ?`,
    [now, reportedDry, reportedWet, reportedDry, reportedLight, device.id]
  );

  const s = getState(code);
  s.deviceId = device.id;
  s.lastSeenMs = now.getTime();
  s.reportedOnline = true; // telemetri masuk berarti perangkat hidup
  s.latest = {
    soil_moisture: p.soil_moisture,
    light_intensity: p.light_intensity,
    pump_status: p.pump_status,
    mode: p.mode,
    reported_dry_threshold: reportedDry,
    reported_wet_threshold: reportedWet,
    reported_threshold: reportedDry,
    reported_light_threshold: reportedLight,
    analysis: p.analysis || null,
    soil_state: p.soil_state || null,
    light_state: p.light_state || null,
    recorded_at: now.toISOString()
  };
  realtime.emit(device.id, "telemetry", { ...s.latest, online: true });
}

async function handleStatus(code, p) {
  const device = await findDevice(code);
  if (!device) return;
  const s = getState(code);
  s.deviceId = device.id;
  const online = p && p.status === "online";
  s.reportedOnline = online;
  if (online) {
    s.lastSeenMs = Date.now();
    await db.execute("UPDATE devices SET last_seen_at = ? WHERE id = ?", [new Date(), device.id]);
    // ESP32 baru online: kirim ulang konfigurasi terbaru dari database.
    const dry = device.dry_threshold ?? device.soil_threshold ?? 40;
    const wet = device.wet_threshold ?? 70;
    const light = device.light_threshold ?? 50;
    publishConfig(code, dry, wet, light);
  }
  realtime.emit(device.id, "status", { online: isOnline(s) });
}

function onMessage(t, buf) {
  const parts = t.split("/");
  if (parts.length !== 3 || parts[0] !== ROOT) return;
  const [, code, kind] = parts;
  if (!CODE_RE.test(code)) return;
  if (kind !== "telemetry" && kind !== "status") return;

  let payload;
  try {
    payload = JSON.parse(buf.toString("utf8"));
  } catch {
    console.warn(`[MQTT] JSON tidak valid di ${t}`);
    return;
  }

  if (kind === "telemetry") {
    const normalized = normalizeTelemetry(payload);
    const err = validateTelemetry(normalized, code);
    if (err) {
      console.warn(`[MQTT] telemetri ditolak (${code}): ${err}`);
      return;
    }
    handleTelemetry(code, normalized).catch((e) => console.error("[MQTT] gagal simpan telemetri:", e.message));
  } else {
    if (!payload || typeof payload !== "object" || !["online", "offline"].includes(payload.status)) {
      console.warn(`[MQTT] status tidak valid di ${t}`);
      return;
    }
    handleStatus(code, payload).catch((e) => console.error("[MQTT] gagal proses status:", e.message));
  }
}

// Konfigurasi: retained + QoS1 agar ESP32 selalu menerima nilai terbaru saat (re)connect.
function publishConfig(code, dryThreshold, wetThreshold, lightThreshold) {
  if (!client || !client.connected) return false;
  const dry = Number(dryThreshold);
  const wet = wetThreshold !== undefined ? Number(wetThreshold) : 70;
  const light = lightThreshold !== undefined ? Number(lightThreshold) : 50;
  const body = JSON.stringify({
    device_id: code,
    dry_threshold: dry,
    wet_threshold: wet,
    soil_threshold: dry,
    light_threshold: light
  });
  client.publish(topic(code, "config"), body, { qos: 1, retain: true }, (err) => {
    if (err) console.error(`[MQTT] gagal publish config ${code}:`, err.message);
  });
  return true;
}

// Perintah mode/pompa: tidak retained (jangan dieksekusi ulang saat reconnect).
function publishCommand(code, cmd) {
  if (!client || !client.connected) return false;
  const body = JSON.stringify({ device_id: code, ...cmd });
  client.publish(topic(code, "command"), body, { qos: 1, retain: false }, (err) => {
    if (err) console.error(`[MQTT] gagal publish command ${code}:`, err.message);
  });
  return true;
}

async function syncAllConfigs() {
  try {
    const [rows] = await db.execute("SELECT device_code, dry_threshold, wet_threshold, soil_threshold, light_threshold FROM devices");
    rows.forEach((r) => {
      const dry = r.dry_threshold ?? r.soil_threshold ?? 40;
      const wet = r.wet_threshold ?? 70;
      const light = r.light_threshold ?? 50;
      publishConfig(r.device_code, dry, wet, light);
    });
    console.log(`[MQTT] sinkronisasi konfigurasi untuk ${rows.length} perangkat`);
  } catch (e) {
    console.error("[MQTT] gagal sinkronisasi konfigurasi:", e.message);
  }
}

async function subscribeDevices() {
  if (!client || !client.connected) return;
  try {
    const [rows] = await db.execute("SELECT device_code FROM devices");
    const topics = [];
    rows.forEach((r) => {
      topics.push(`${ROOT}/${r.device_code}/telemetry`);
      topics.push(`${ROOT}/${r.device_code}/status`);
    });
    if (topics.length > 0) {
      client.subscribe(topics, { qos: 1 }, (err) => {
        if (err) console.error("[MQTT] gagal subscribe perangkat:", err.message);
      });
    }
  } catch (e) {
    console.error("[MQTT] gagal memuat daftar subscribe perangkat:", e.message);
  }
}

function subscribeDevice(code) {
  if (!client || !client.connected || !code) return;
  client.subscribe([`${ROOT}/${code}/telemetry`, `${ROOT}/${code}/status`], { qos: 1 });
}

function init() {
  const url = process.env.MQTT_URL || "mqtt://broker.hivemq.com:1883";
  const opts = {
    clientId: `potpintar-backend-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 15000,
    keepalive: 30
  };
  if (process.env.MQTT_USERNAME) {
    opts.username = process.env.MQTT_USERNAME;
    opts.password = process.env.MQTT_PASSWORD;
  }

  client = mqtt.connect(url, opts);

  client.on("connect", () => {
    console.log(`[MQTT] terhubung ke ${url}`);
    subscribeDevices();
    syncAllConfigs();
  });
  client.on("reconnect", () => console.log("[MQTT] mencoba menyambung ulang..."));
  client.on("close", () => console.warn("[MQTT] koneksi ditutup"));
  client.on("error", (e) => console.error("[MQTT] error:", e.message));
  client.on("message", onMessage);

  // Deteksi perangkat yang berhenti mengirim data (tanpa LWT sekalipun).
  setInterval(() => {
    for (const [, s] of state) {
      if (s.deviceId && s.reportedOnline && Date.now() - s.lastSeenMs > OFFLINE_AFTER_MS) {
        s.reportedOnline = false;
        realtime.emit(s.deviceId, "status", { online: false });
      }
    }
  }, 10000).unref();
}

module.exports = {
  init,
  publishConfig,
  publishCommand,
  subscribeDevice,
  snapshot,
  isConnected: () => Boolean(client && client.connected)
};

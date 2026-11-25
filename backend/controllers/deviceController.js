const db = require("../config/database");
const mqttService = require("../services/mqtt");
const realtime = require("../services/realtime");

const CODE_RE = /^[A-Za-z0-9_-]{3,64}$/;
const RANGES = {
  today: { bucket: 300 },   // rata-rata per 5 menit
  "7d": { bucket: 3600 },   // per 1 jam
  "30d": { bucket: 21600 }  // per 6 jam
};

function rangeStart(range) {
  const d = new Date();
  if (range === "today") { d.setHours(0, 0, 0, 0); return d; }
  return new Date(d.getTime() - (range === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000);
}

// Mengambil perangkat HANYA jika dimiliki user yang sedang login.
async function ownedDevice(req, res) {
  const id = req.params.id;
  if (!/^\d{1,10}$/.test(id)) { res.status(400).json({ error: "ID perangkat tidak valid." }); return null; }
  const [rows] = await db.execute(
    `SELECT id, device_code, device_name,
            dry_threshold, wet_threshold, soil_threshold, light_threshold,
            reported_dry_threshold, reported_wet_threshold, reported_threshold, reported_light_threshold,
            last_seen_at, created_at
     FROM devices WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, req.user.id]
  );
  if (!rows[0]) { res.status(404).json({ error: "Perangkat tidak ditemukan." }); return null; }
  return rows[0];
}

function present(d) {
  const snap = mqttService.snapshot(d.device_code);
  const dry = d.dry_threshold ?? d.soil_threshold ?? 40;
  const wet = d.wet_threshold ?? 70;
  const light = d.light_threshold ?? 50;
  const repDry = snap.latest?.reported_dry_threshold ?? d.reported_dry_threshold ?? snap.latest?.reported_threshold ?? d.reported_threshold ?? null;
  const repWet = snap.latest?.reported_wet_threshold ?? d.reported_wet_threshold ?? null;
  const repLight = snap.latest?.reported_light_threshold ?? d.reported_light_threshold ?? null;
  return {
    id: d.id,
    device_code: d.device_code,
    device_name: d.device_name,
    dry_threshold: dry,
    wet_threshold: wet,
    soil_threshold: dry,
    light_threshold: light,
    reported_dry_threshold: repDry,
    reported_wet_threshold: repWet,
    reported_threshold: repDry,
    reported_light_threshold: repLight,
    last_seen_at: d.last_seen_at,
    online: snap.online,
    latest: snap.latest
  };
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(`${req.method} ${req.originalUrl}:`, e.message); if (!res.headersSent) res.status(500).json({ error: "Terjadi kesalahan server." }); }
};

exports.list = wrap(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT id, device_code, device_name,
            dry_threshold, wet_threshold, soil_threshold, light_threshold,
            reported_dry_threshold, reported_wet_threshold, reported_threshold, reported_light_threshold,
            last_seen_at, created_at
     FROM devices WHERE user_id = ? ORDER BY id`,
    [req.user.id]
  );
  res.json({ devices: rows.map(present) });
});

// Klaim perangkat yang belum punya pemilik, atau daftarkan perangkat baru.
exports.claim = wrap(async (req, res) => {
  const code = String(req.body.device_code ?? "").trim();
  const name = String(req.body.device_name ?? "PotPintar").trim().slice(0, 100) || "PotPintar";
  if (!CODE_RE.test(code)) return res.status(400).json({ error: "Kode perangkat 3–64 karakter: huruf, angka, _ atau -." });

  const [rows] = await db.execute("SELECT id, user_id FROM devices WHERE device_code = ?", [code]);
  if (rows[0]) {
    if (rows[0].user_id !== null && rows[0].user_id !== req.user.id) {
      return res.status(409).json({ error: "Perangkat sudah dimiliki akun lain." });
    }
    if (rows[0].user_id === null) {
      await db.execute("UPDATE devices SET user_id = ?, device_name = ? WHERE id = ? AND user_id IS NULL", [req.user.id, name, rows[0].id]);
    }
  } else {
    await db.execute("INSERT INTO devices (user_id, device_code, device_name, dry_threshold, wet_threshold, soil_threshold, light_threshold) VALUES (?, ?, ?, 40.00, 70.00, 40.00, 50.00)", [req.user.id, code, name]);
  }
  const [d] = await db.execute(
    `SELECT id, device_code, device_name,
            dry_threshold, wet_threshold, soil_threshold, light_threshold,
            reported_dry_threshold, reported_wet_threshold, reported_threshold, reported_light_threshold,
            last_seen_at, created_at
     FROM devices WHERE device_code = ? AND user_id = ?`,
    [code, req.user.id]
  );
  const dry = d[0].dry_threshold ?? d[0].soil_threshold ?? 40;
  const wet = d[0].wet_threshold ?? 70;
  const light = d[0].light_threshold ?? 50;
  mqttService.publishConfig(d[0].device_code, dry, wet, light);
  mqttService.subscribeDevice(d[0].device_code);
  res.status(201).json({ device: present(d[0]) });
});

exports.getOne = wrap(async (req, res) => {
  const d = await ownedDevice(req, res);
  if (d) res.json({ device: present(d) });
});

exports.status = wrap(async (req, res) => {
  const d = await ownedDevice(req, res);
  if (!d) return;
  const p = present(d);
  res.json({
    online: p.online,
    last_seen_at: p.last_seen_at,
    dry_threshold: p.dry_threshold,
    wet_threshold: p.wet_threshold,
    soil_threshold: p.soil_threshold,
    light_threshold: p.light_threshold,
    reported_dry_threshold: p.reported_dry_threshold,
    reported_wet_threshold: p.reported_wet_threshold,
    reported_threshold: p.reported_threshold,
    reported_light_threshold: p.reported_light_threshold,
    latest: p.latest,
    mqtt_connected: mqttService.isConnected()
  });
});

exports.updateThreshold = wrap(async (req, res) => {
  const d = await ownedDevice(req, res);
  if (!d) return;

  let rawDry = req.body.dry_threshold ?? req.body.soil_threshold;
  let rawWet = req.body.wet_threshold;
  let rawLight = req.body.light_threshold;

  // Jika hanya satu yang dikirim, isi pasangannya dari data yang sudah ada
  if (rawDry === undefined && rawWet !== undefined) {
    rawDry = d.dry_threshold ?? d.soil_threshold ?? 40;
  }
  if (rawWet === undefined && rawDry !== undefined) {
    rawWet = d.wet_threshold ?? 70;
  }
  if (rawLight === undefined) {
    rawLight = d.light_threshold ?? 50;
  }

  if (typeof rawDry !== "number" || !Number.isFinite(rawDry) || rawDry < 0 || rawDry > 100) {
    return res.status(400).json({ error: "Batas kering harus berupa angka 0–100." });
  }
  if (typeof rawWet !== "number" || !Number.isFinite(rawWet) || rawWet < 0 || rawWet > 100) {
    return res.status(400).json({ error: "Batas lembab harus berupa angka 0–100." });
  }
  if (typeof rawLight !== "number" || !Number.isFinite(rawLight) || rawLight < 0 || rawLight > 100) {
    return res.status(400).json({ error: "Batas cahaya harus berupa angka 0–100." });
  }

  const dryVal = Math.round(rawDry * 100) / 100;
  const wetVal = Math.round(rawWet * 100) / 100;
  const lightVal = Math.round(rawLight * 100) / 100;

  if (dryVal >= wetVal) {
    return res.status(400).json({ error: "Batas kering harus lebih kecil dari batas lembab." });
  }

  await db.execute(
    "UPDATE devices SET dry_threshold = ?, wet_threshold = ?, soil_threshold = ?, light_threshold = ? WHERE id = ? AND user_id = ?",
    [dryVal, wetVal, dryVal, lightVal, d.id, req.user.id]
  );
  const published = mqttService.publishConfig(d.device_code, dryVal, wetVal, lightVal);

  res.json({
    dry_threshold: dryVal,
    wet_threshold: wetVal,
    soil_threshold: dryVal,
    light_threshold: lightVal,
    mqtt_published: published,
    message: published
      ? "Tersimpan di database dan dikirim ke ESP32."
      : "Tersimpan di database. MQTT sedang terputus; konfigurasi dikirim otomatis saat tersambung kembali."
  });
});

exports.sendCommand = wrap(async (req, res) => {
  const d = await ownedDevice(req, res);
  if (!d) return;
  const { mode, pump } = req.body;
  const cmd = {};
  if (mode !== undefined) {
    if (mode !== "AUTO" && mode !== "MANUAL") return res.status(400).json({ error: "mode harus AUTO atau MANUAL." });
    cmd.mode = mode;
  }
  if (pump !== undefined) {
    if (pump !== "ON" && pump !== "OFF") return res.status(400).json({ error: "pump harus ON atau OFF." });
    cmd.pump = pump;
  }
  if (!Object.keys(cmd).length) return res.status(400).json({ error: "Tidak ada perintah." });
  if (!mqttService.publishCommand(d.device_code, cmd)) {
    return res.status(503).json({ error: "Backend belum terhubung ke broker MQTT." });
  }
  res.json({ sent: cmd });
});

exports.logs = wrap(async (req, res) => {
  const d = await ownedDevice(req, res);
  if (!d) return;
  const range = RANGES[req.query.range] ? req.query.range : "today";
  const bucket = RANGES[range].bucket; // konstanta dari whitelist, aman diinterpolasi
  const since = rangeStart(range);

  const [series] = await db.execute(
    `SELECT FLOOR(UNIX_TIMESTAMP(recorded_at) / ${bucket}) * ${bucket} AS bucket_ts,
            AVG(soil_moisture) AS soil_moisture,
            AVG(light_intensity) AS light_intensity,
            COUNT(*) AS samples
     FROM sensor_logs
     WHERE device_id = ? AND recorded_at >= ?
     GROUP BY bucket_ts ORDER BY bucket_ts`,
    [d.id, since]
  );
  const [recent] = await db.execute(
    `SELECT soil_moisture, light_intensity, pump_status, mode, recorded_at
     FROM sensor_logs WHERE device_id = ? AND recorded_at >= ?
     ORDER BY recorded_at DESC LIMIT 20`,
    [d.id, since]
  );

  res.json({
    range,
    bucket_seconds: bucket,
    series: series.map((r) => ({
      t: new Date(Number(r.bucket_ts) * 1000).toISOString(),
      soil_moisture: Math.round(Number(r.soil_moisture) * 10) / 10,
      light_intensity: Math.round(Number(r.light_intensity) * 10) / 10,
      samples: r.samples
    })),
    recent
  });
});

exports.stream = wrap(async (req, res) => {
  const d = await ownedDevice(req, res);
  if (!d) return;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  const p = present(d);
  res.write(
    `event: init\ndata: ${JSON.stringify({
      online: p.online,
      latest: p.latest,
      dry_threshold: p.dry_threshold,
      wet_threshold: p.wet_threshold,
      soil_threshold: p.soil_threshold,
      light_threshold: p.light_threshold,
      reported_dry_threshold: p.reported_dry_threshold,
      reported_wet_threshold: p.reported_wet_threshold,
      reported_threshold: p.reported_threshold,
      reported_light_threshold: p.reported_light_threshold
    })}\n\n`
  );
  realtime.subscribe(d.id, res);
});

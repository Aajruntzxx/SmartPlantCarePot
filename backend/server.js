const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

if (!process.env.JWT_SECRET || !process.env.DB_USER || process.env.DB_PASSWORD === undefined) {
  console.error("Variabel JWT_SECRET, DB_USER, atau DB_PASSWORD belum ada di file .env");
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.startsWith("GANTI")) {
  console.error("JWT_SECRET terlalu lemah. Buat string acak minimal 32 karakter.");
  process.exit(1);
}

const db = require("./config/database");
const mqttService = require("./services/mqtt");
const { requireCustomHeader } = require("./middleware/auth");

const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"]
      }
    }
  })
);
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

app.use("/api", requireCustomHeader);
app.use("/api/auth", require("./routes/auth"));
app.use("/api/devices", require("./routes/devices"));
app.get("/api/health", (req, res) => res.json({ ok: true, mqtt_connected: mqttService.isConnected() }));
app.use("/api", (req, res) => res.status(404).json({ error: "Endpoint tidak ditemukan." }));

app.use(express.static(path.join(__dirname, "..", "frontend")));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON tidak valid." });
  console.error(err);
  res.status(500).json({ error: "Terjadi kesalahan server." });
});

async function migrateSchema() {
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'`
    );
    const colNames = cols.map((c) => c.COLUMN_NAME.toLowerCase());
    if (colNames.length > 0) {
      if (!colNames.includes("dry_threshold")) {
        console.log("[DB] Migrasi: Menambahkan kolom dry_threshold...");
        await db.query("ALTER TABLE devices ADD COLUMN dry_threshold DECIMAL(5,2) NOT NULL DEFAULT 40.00 AFTER device_name");
      }
      if (!colNames.includes("wet_threshold")) {
        console.log("[DB] Migrasi: Menambahkan kolom wet_threshold...");
        await db.query("ALTER TABLE devices ADD COLUMN wet_threshold DECIMAL(5,2) NOT NULL DEFAULT 70.00 AFTER dry_threshold");
      }
      if (!colNames.includes("soil_threshold")) {
        await db.query("ALTER TABLE devices ADD COLUMN soil_threshold DECIMAL(5,2) NOT NULL DEFAULT 40.00 AFTER wet_threshold");
      }
      if (!colNames.includes("light_threshold")) {
        console.log("[DB] Migrasi: Menambahkan kolom light_threshold...");
        await db.query("ALTER TABLE devices ADD COLUMN light_threshold DECIMAL(5,2) NOT NULL DEFAULT 50.00 AFTER wet_threshold");
      }
      if (!colNames.includes("reported_dry_threshold")) {
        console.log("[DB] Migrasi: Menambahkan kolom reported_dry_threshold...");
        await db.query("ALTER TABLE devices ADD COLUMN reported_dry_threshold DECIMAL(5,2) NULL AFTER wet_threshold");
      }
      if (!colNames.includes("reported_wet_threshold")) {
        console.log("[DB] Migrasi: Menambahkan kolom reported_wet_threshold...");
        await db.query("ALTER TABLE devices ADD COLUMN reported_wet_threshold DECIMAL(5,2) NULL AFTER reported_dry_threshold");
      }
      if (!colNames.includes("reported_threshold")) {
        console.log("[DB] Migrasi: Menambahkan kolom reported_threshold...");
        await db.query("ALTER TABLE devices ADD COLUMN reported_threshold DECIMAL(5,2) NULL AFTER reported_wet_threshold");
      }
      if (!colNames.includes("reported_light_threshold")) {
        console.log("[DB] Migrasi: Menambahkan kolom reported_light_threshold...");
        await db.query("ALTER TABLE devices ADD COLUMN reported_light_threshold DECIMAL(5,2) NULL AFTER reported_wet_threshold");
      }
    }
  } catch (e) {
    console.warn("[DB] Peringatan saat cek migrasi skema:", e.message);
  }
}

async function start() {
  try {
    await db.query("SELECT 1");
    console.log("[DB] terhubung ke MySQL");
    await migrateSchema();
  } catch (e) {
    console.error("[DB] gagal terhubung ke MySQL:", e.message);
    process.exit(1);
  }
  mqttService.init();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`PotPintar berjalan di http://localhost:${port}`));
}
start();

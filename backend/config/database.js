const mysql = require("mysql2/promise");

const tz = process.env.DB_TIMEZONE || "+07:00";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "potpintar_db",
  waitForConnections: true,
  connectionLimit: 10,
  timezone: tz,
  decimalNumbers: true // DECIMAL dikembalikan sebagai number, bukan string
});

// Samakan zona waktu sesi MySQL dengan zona waktu yang dipakai Node,
// agar pengelompokan waktu (UNIX_TIMESTAMP) pada grafik akurat.
pool.on("connection", (conn) => {
  conn.query("SET time_zone = ?", [tz]);
});

module.exports = pool;

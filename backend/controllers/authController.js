const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { issueSession, clearSession } = require("../middleware/auth");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Hash palsu agar waktu respons login tidak membocorkan apakah email terdaftar.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

async function register(req, res) {
  if (process.env.ALLOW_REGISTRATION === "false") {
    return res.status(403).json({ error: "Registrasi dinonaktifkan." });
  }
  const name = String(req.body.name ?? "").trim();
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");

  if (name.length < 1 || name.length > 100) return res.status(400).json({ error: "Nama wajib diisi (maks. 100 karakter)." });
  if (!EMAIL_RE.test(email) || email.length > 190) return res.status(400).json({ error: "Format email tidak valid." });
  // bcrypt hanya memakai 72 byte pertama, jadi batasi panjangnya.
  if (password.length < 8 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: "Password 8–72 karakter." });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.execute(
      "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      [name, email, hash]
    );
    const user = { id: result.insertId, name, email };

    const owner = (process.env.DEVICE_OWNER_EMAIL || "").trim().toLowerCase();
    if (owner && owner === email) {
      await db.execute(
        "UPDATE devices SET user_id = ? WHERE device_code = 'smartplant_azarya_01' AND user_id IS NULL",
        [user.id]
      );
    } else if (!owner) {
      const [countRows] = await db.execute("SELECT COUNT(*) AS total FROM users");
      if (countRows[0] && countRows[0].total === 1) {
        await db.execute(
          "UPDATE devices SET user_id = ? WHERE device_code = 'smartplant_azarya_01' AND user_id IS NULL",
          [user.id]
        );
      }
    }
    issueSession(res, user);
    res.status(201).json({ user });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email sudah terdaftar." });
    console.error("register:", e.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
}

async function login(req, res) {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  if (!email || !password || password.length > 200) {
    return res.status(400).json({ error: "Email dan password wajib diisi." });
  }
  try {
    const [rows] = await db.execute(
      "SELECT id, name, email, password_hash FROM users WHERE email = ? LIMIT 1",
      [email]
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: "Email atau password salah." });
    issueSession(res, user);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error("login:", e.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
}

function logout(req, res) {
  clearSession(res);
  res.json({ ok: true });
}

async function me(req, res) {
  try {
    const [rows] = await db.execute("SELECT id, name, email FROM users WHERE id = ?", [req.user.id]);
    if (!rows[0]) { clearSession(res); return res.status(401).json({ error: "Akun tidak ditemukan." }); }
    res.json({ user: rows[0] });
  } catch (e) {
    console.error("me:", e.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
}

module.exports = { register, login, logout, me };

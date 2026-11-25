const jwt = require("jsonwebtoken");

const COOKIE = "pp_token";

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  };
}

function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE, token, cookieOptions());
}

function clearSession(res) {
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: "Belum login." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub };
    next();
  } catch {
    clearSession(res);
    res.status(401).json({ error: "Sesi tidak valid atau kedaluwarsa. Silakan login ulang." });
  }
}

// Perlindungan CSRF: request yang mengubah data wajib membawa header kustom.
// Form lintas-situs tidak dapat menambahkan header ini.
function requireCustomHeader(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Requested-With") !== "PotPintar") {
    return res.status(403).json({ error: "Permintaan ditolak." });
  }
  next();
}

module.exports = { requireAuth, requireCustomHeader, issueSession, clearSession };

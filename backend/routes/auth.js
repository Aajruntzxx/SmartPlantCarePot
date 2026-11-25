const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const c = require("../controllers/authController");

const router = express.Router();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." }
});

router.post("/register", limiter, c.register);
router.post("/login", limiter, c.login);
router.post("/logout", c.logout);
router.get("/me", requireAuth, c.me);

module.exports = router;

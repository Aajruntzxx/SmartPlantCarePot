const express = require("express");
const { requireAuth } = require("../middleware/auth");
const c = require("../controllers/deviceController");

const router = express.Router();
router.use(requireAuth);

router.get("/", c.list);
router.post("/", c.claim);
router.get("/:id", c.getOne);
router.put("/:id/threshold", c.updateThreshold);
router.post("/:id/command", c.sendCommand);
router.get("/:id/logs", c.logs);
router.get("/:id/status", c.status);
router.get("/:id/stream", c.stream);

module.exports = router;

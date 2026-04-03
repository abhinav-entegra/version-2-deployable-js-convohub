import express from "express";
import { requireAuth, requireClient } from "../dependencies.js";

const router = express.Router();

/** Legacy path — use POST /api/send_message (channel_name or receiver_id). */
router.post("/send-message", requireAuth, requireClient, (_req, res) => {
  return res.status(410).json({
    detail: "Deprecated: POST /api/send_message with channel_name or receiver_id",
  });
});

export default router;

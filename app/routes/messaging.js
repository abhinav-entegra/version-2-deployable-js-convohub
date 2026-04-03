import express from "express";

const router = express.Router();

router.get("/ws-info", (_req, res) => {
  return res.json({ status: "ok", message: "Connect via WebSocket at /ws" });
});

export default router;

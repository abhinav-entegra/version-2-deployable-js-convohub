import express from "express";
import { requireAuth } from "../dependencies.js";

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  return res.json({ status: "ok", message: "Team routes ready", user: req.user.email });
});

export default router;

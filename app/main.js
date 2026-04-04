import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import http from "http";
import { WebSocketServer } from "ws";
import adminRouter from "./routes/admin.js";
import authRouter, {
  postLoginAdminRoot,
  postLoginClientRoot,
  revokeSession,
} from "./routes/auth.js";
import clientRouter from "./routes/client.js";
import messagingRouter from "./routes/messaging.js";
import teamsRouter from "./routes/teams.js";
import unifiedApiRouter from "./routes/unified_api.js";
import { registerDashboardRoute } from "./routes/dashboard_route.js";
import { registerAdminConsoleRoute } from "./routes/admin_console_route.js";
import { attachSocketIO } from "./socketio_server.js";
import { manager } from "./utils/websocket_manager.js";
import { AUTH_DISABLED, GUEST_USER_ID } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const callRingtonePath = path.join(rootDir, "universfield-ringtone-088-496414.mp3");

const app = express();
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
});
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json({ limit: "32mb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API_MAX || 800),
  standardHeaders: true,
  legacyHeaders: false,
});
const isProd = process.env.NODE_ENV === "production";
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || (isProd ? 300 : 5000)),
  standardHeaders: true,
  legacyHeaders: false,
  /** Session polling (GET /auth/session) was burning the budget and caused 429 on login. */
  skip: (req) => req.method === "GET",
});
app.use("/api", apiLimiter);
app.use("/auth", authLimiter);

const adminLoginFile = path.join(publicDir, "admin-login.html");
/** Must run before `express.static` and before `app.use("/admin", …)` so GET /admin/login is not swallowed. */
app.get("/admin/login", (_req, res) => {
  res.sendFile(adminLoginFile);
});

app.use(express.static(publicDir));

// Serves ringtone audio for incoming calls.
// Using the MP3 file placed alongside this project (not required to be in `/public`).
app.get("/call-ringtone.mp3", (_req, res) => {
  if (!fs.existsSync(callRingtonePath)) return res.status(404).end();
  res.sendFile(callRingtonePath);
});

app.get("/healthz", (_req, res) => {
  console.log("[healthcheck] /healthz pinged");
  res.type("text/plain").send("ok");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/** Layout-only shell (JS UI, no API). Use for the next integration pass. */
app.get("/shell", (_req, res) => {
  res.sendFile(path.join(publicDir, "shell.html"));
});

registerDashboardRoute(app);
registerAdminConsoleRoute(app, publicDir);

/** Master-prompt REST paths (same handlers as /auth/login/*). */
app.post("/login/client", authLimiter, postLoginClientRoot);
app.post("/login/admin", authLimiter, postLoginAdminRoot);
app.get("/logout", async (req, res) => {
  await revokeSession(req, res);
  res.redirect(302, "/");
});

app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/client", clientRouter);
app.use("/teams", teamsRouter);
app.use("/messaging", messagingRouter);
app.use("/api", unifiedApiRouter);

const server = http.createServer(app);

attachSocketIO(server);

// wss deprecated in favor of Socket.IO

// Default to 8003 so websocket/socket.io clients can connect without manual env changes.
// Default to 8080 for standard cloud environments (Railway, etc)
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  if (AUTH_DISABLED) {
    console.warn(
      `[convohub] AUTH_DISABLED: using guest user id ${GUEST_USER_ID} when no JWT (set AUTH_DISABLED=0 or unset to require login)`
    );
  }
});

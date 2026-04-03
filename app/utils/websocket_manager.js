import { decodeAccessToken } from "./security.js";

export class ConnectionManager {
  constructor() {
    this.activeConnections = new Set();
    /** @type {Map<number, Set<import('ws').WebSocket>>} */
    this.byUser = new Map();
  }

  connect(ws) {
    this.activeConnections.add(ws);
    ws._authed = false;
  }

  disconnect(ws) {
    this.activeConnections.delete(ws);
    if (ws.userId != null) {
      const bucket = this.byUser.get(ws.userId);
      if (bucket) {
        bucket.delete(ws);
        if (bucket.size === 0) this.byUser.delete(ws.userId);
      }
    }
    if (ws._authed && ws.userId != null) {
      this.broadcastJson({
        type: "user_status_change",
        user_id: ws.userId,
        status: "offline",
      });
    }
  }

  /** @param {import('ws').WebSocket} ws */
  registerUser(ws, userId) {
    ws.userId = userId;
    ws._authed = true;
    if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
    this.byUser.get(userId).add(ws);
    this.broadcastJson({
      type: "user_status_change",
      user_id: userId,
      status: "online",
    });
  }

  broadcastJson(obj) {
    const msg = JSON.stringify(obj);
    for (const c of this.activeConnections) {
      if (c.readyState === 1) c.send(msg);
    }
  }

  /** User ids with at least one connected socket */
  getOnlineUserIds() {
    return [...this.byUser.keys()];
  }

  sendToUser(userId, obj) {
    const bucket = this.byUser.get(userId);
    if (!bucket) return;
    const msg = JSON.stringify(obj);
    for (const c of bucket) {
      if (c.readyState === 1) c.send(msg);
    }
  }

  /**
   * First client message must be JSON { type: "auth", token: "<jwt>" }.
   * Optional: { type: "signal", event: "call-user", payload: {...} } relay to target user.
   */
  handleClientMessage(ws, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data?.type === "auth" && data.token) {
      const payload = decodeAccessToken(data.token);
      const uid = Number(payload?.sub);
      if (payload && Number.isFinite(uid)) {
        this.registerUser(ws, uid);
        ws.send(JSON.stringify({ type: "auth_ok", user_id: uid }));
      } else {
        ws.send(JSON.stringify({ type: "auth_error" }));
      }
      return;
    }
    if (!ws._authed) return;

    if (data?.type === "signal" && data.event && data.to != null) {
      const targetId = Number(data.to);
      if (!Number.isFinite(targetId)) return;
      this.sendToUser(targetId, {
        type: "signal",
        event: data.event,
        from: ws.userId,
        payload: data.payload ?? null,
      });
    }
  }
}

export const manager = new ConnectionManager();

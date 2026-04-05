/**
 * Extra Socket.IO chat entry points (same pipeline as `message` → dispatchOutboundMessage).
 * Lets clients use send_message / send_dm names (e.g. chat_socket_client.js) without a second fan-out path.
 */
import { dispatchOutboundMessage } from "../services/message_dispatch.js";

export function attachChatAliases(socket, io, u) {
  void io;

  socket.on("send_message", async (payload, ack) => {
    try {
      const p = payload || {};
      const result = await dispatchOutboundMessage(u, {
        content: p.content,
        channel_name: p.channel_name ?? null,
        receiver_id: p.receiver_id ?? null,
        type: p.type ?? "text",
        file_path: p.file_path ?? null,
        client_msg_id: p.client_msg_id ?? null,
      });
      if (typeof ack === "function") {
        if (result.ok) {
          ack({ ok: true, client_msg_id: p.client_msg_id || null, msg_id: result.msg_id });
        } else {
          ack({ error: result.error || "send failed", status: result.status });
        }
      }
    } catch (e) {
      console.error("[socket] send_message error", e);
      if (typeof ack === "function") ack({ error: "internal_error", status: 500 });
    }
  });

  socket.on("send_dm", async (payload, ack) => {
    try {
      const p = payload || {};
      const result = await dispatchOutboundMessage(u, {
        content: p.content,
        receiver_id: p.receiver_id,
        channel_name: null,
        type: p.type ?? "text",
        file_path: p.file_path ?? null,
        client_msg_id: p.client_msg_id ?? null,
      });
      if (typeof ack === "function") {
        if (result.ok) {
          ack({ ok: true, client_msg_id: p.client_msg_id || null, msg_id: result.msg_id });
        } else {
          ack({ error: result.error || "send failed", status: result.status });
        }
      }
    } catch (e) {
      console.error("[socket] send_dm error", e);
      if (typeof ack === "function") ack({ error: "internal_error", status: 500 });
    }
  });
}

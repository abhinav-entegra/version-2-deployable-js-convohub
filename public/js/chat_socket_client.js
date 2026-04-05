/**
 * Optional Socket.IO helper for Convohub (uses /api/socket_token + path /socket.io).
 * Does not auto-connect until you call ChatSocket.connect() or send/join methods.
 */
(function (global) {
  "use strict";

  const SOCKET_URL = global.location.origin;
  const HISTORY_TTL_MS = 60_000;

  let _socket = null;
  const _listeners = {};
  const _optimistic = {};
  let _tokenCache = null;

  async function resolveToken() {
    if (_tokenCache) return _tokenCache;
    const m = document.cookie.match(/(?:^|;\s*)socket_token=([^;]+)/);
    if (m) {
      _tokenCache = m[1];
      return _tokenCache;
    }
    try {
      const r = await fetch("/api/socket_token", { credentials: "include" });
      const j = await r.json().catch(function () {
        return null;
      });
      _tokenCache = j && j.token ? j.token : null;
      return _tokenCache;
    } catch {
      return null;
    }
  }

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function cacheKey(room) {
    return "chat_hist_" + room;
  }

  function readCache(room) {
    try {
      const raw = sessionStorage.getItem(cacheKey(room));
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Date.now() - o.ts > HISTORY_TTL_MS) return null;
      return o.msgs;
    } catch {
      return null;
    }
  }

  function writeCache(room, msgs) {
    try {
      sessionStorage.setItem(cacheKey(room), JSON.stringify({ ts: Date.now(), msgs: msgs }));
    } catch {}
  }

  function emit(event, data) {
    (_listeners[event] || []).forEach(function (cb) {
      try {
        cb(data);
      } catch (e) {
        console.error(e);
      }
    });
  }

  let _activeChannel = null;
  let _activeDm = null;

  async function connect() {
    if (_socket && _socket.connected) return _socket;
    const token = await resolveToken();
    if (!token || typeof global.io !== "function") return null;

    _socket = global.io(SOCKET_URL, {
      auth: { token: token },
      path: "/socket.io",
      transports: ["websocket"],
      upgrade: false,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 5000,
    });

    _socket.on("connect", function () {
      emit("connect", {});
      if (_activeChannel) _socket.emit("join_channel", { channel_name: _activeChannel });
      if (_activeDm) _socket.emit("join_dm", { receiver_id: _activeDm });
    });

    _socket.on("disconnect", function (reason) {
      emit("disconnect", { reason: reason });
    });

    _socket.on("new_message", function (msg) {
      const cmid = String((msg && msg.message && msg.message.client_msg_id) || msg.client_msg_id || "");
      if (cmid && _optimistic[cmid]) {
        delete _optimistic[cmid];
        emit("message_confirmed", msg.message || msg);
      } else {
        emit("new_message", msg);
      }
    });

    return _socket;
  }

  const ChatSocket = {
    on: function (event, cb) {
      _listeners[event] = _listeners[event] || [];
      _listeners[event].push(cb);
      return ChatSocket;
    },
    off: function (event, cb) {
      if (!cb) {
        _listeners[event] = [];
        return;
      }
      _listeners[event] = (_listeners[event] || []).filter(function (f) {
        return f !== cb;
      });
    },
    joinChannel: function (channelName) {
      _activeChannel = channelName;
      _activeDm = null;
      connect().then(function (sock) {
        if (sock) sock.emit("join_channel", { channel_name: channelName });
      });
    },
    joinDm: function (receiverId) {
      _activeDm = receiverId;
      _activeChannel = null;
      connect().then(function (sock) {
        if (sock) sock.emit("join_dm", { receiver_id: receiverId });
      });
    },
    sendMessage: function (payload) {
      const cmid = (payload && payload.client_msg_id) || uid();
      _optimistic[cmid] = true;
      connect().then(function (sock) {
        if (!sock) return;
        sock.emit(
          "send_message",
          Object.assign({}, payload, { client_msg_id: cmid }),
          function (ack) {
            if (ack && ack.error) {
              delete _optimistic[cmid];
              emit("send_error", { client_msg_id: cmid, error: ack.error });
            }
          }
        );
      });
      return cmid;
    },
    sendDm: function (payload) {
      const cmid = (payload && payload.client_msg_id) || uid();
      _optimistic[cmid] = true;
      connect().then(function (sock) {
        if (!sock) return;
        sock.emit(
          "send_dm",
          Object.assign({}, payload, { client_msg_id: cmid }),
          function (ack) {
            if (ack && ack.error) {
              delete _optimistic[cmid];
              emit("send_error", { client_msg_id: cmid, error: ack.error });
            }
          }
        );
      });
      return cmid;
    },
    connect: function () {
      return connect();
    },
    get connected() {
      return !!(_socket && _socket.connected);
    },
  };

  global.ChatSocket = ChatSocket;
})(window);

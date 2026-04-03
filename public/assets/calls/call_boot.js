// Remade Call feature (voice + video) with clean frontend architecture.
// Loaded as an ES module. It attaches click handlers and handles WebRTC lifecycle.
/* eslint-disable no-undef */

const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function $(id) {
  return document.getElementById(id);
}

function readBootFromDom() {
  const el = document.getElementById("dashboard-boot-json");
  if (!el) return null;
  try {
    const text = el.textContent || "";
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getBootToken() {
  try {
    const fromWindow = window?.boot?.socket_bootstrap_token || null;
    if (fromWindow) return fromWindow;

    const boot = readBootFromDom();
    return boot?.socket_bootstrap_token || null;
  } catch {
    return null;
  }
}

async function waitForBootToken(timeoutMs = 5000) {
  const start = Date.now();
  // Token is usually already available from `dashboard-boot-json`,
  // but this keeps a fallback for any timing/order issues.
  while (Date.now() - start < timeoutMs) {
    const t = getBootToken();
    if (t) return t;
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
}

function getSocketBaseUrl() {
  const boot = readBootFromDom();
  const publicUrl = boot?.signaling_public_url;
  if (publicUrl && String(publicUrl).trim()) {
    let u = String(publicUrl).trim();
    // If env var is host:port only, prepend protocol.
    if (!/^https?:\/\//i.test(u)) u = location.protocol + "//" + u;
    return u.replace(/\/+$/, "");
  }
  // Default: same origin as the dashboard page.
  return location.origin;
}

function formatClockTime(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  try {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return d.toISOString();
  }
}

function formatDurationMs(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return mm + ":" + ss;
}

class CallUI {
  constructor() {
    this.callModal = $("call-modal");
    this.callPanel = $("call-panel");
    this.callStatusText = $("call-status-text");

    this.callLocalVideo = $("call-local-video");
    this.callLocalAudio = $("call-local-audio");
    this.callLocalVoiceLabel = $("call-local-voice-label");
    this.callRemoteGrid = $("call-remote-grid");

    this.callRingtoneAudio = $("call-ringtone-audio");

    this.callAcceptBtn = $("call-accept-btn");
    this.callRejectBtn = $("call-reject-btn");
    this.callEndBtn = $("call-end-btn");

    this.callPanelAcceptBtn = $("call-panel-accept-btn");
    this.callPanelRejectBtn = $("call-panel-reject-btn");
    this.callPanelTitle = $("call-panel-title");
    this.callPanelSubtitle = $("call-panel-subtitle");
  }

  setModalVisible(visible) {
    if (!this.callModal) return;
    if (visible) this.callModal.classList.remove("hidden");
    else this.callModal.classList.add("hidden");
  }

  setPanelVisible(visible) {
    if (!this.callPanel) return;
    if (visible) this.callPanel.classList.remove("hidden");
    else this.callPanel.classList.add("hidden");
  }

  setStatus(text) {
    if (!this.callStatusText) return;
    this.callStatusText.textContent = text || "";
  }

  setAcceptRejectState(opts) {
    const canAccept = opts?.canAccept === true;
    const canReject = opts?.canReject === true;
    if (this.callAcceptBtn) this.callAcceptBtn.disabled = !canAccept;
    if (this.callRejectBtn) this.callRejectBtn.disabled = !canReject;
    if (this.callPanelAcceptBtn) this.callPanelAcceptBtn.disabled = !canAccept;
    if (this.callPanelRejectBtn) this.callPanelRejectBtn.disabled = !canReject;
  }

  setEndEnabled(enabled) {
    if (!this.callEndBtn) return;
    this.callEndBtn.disabled = !enabled;
  }

  setPanelTitle(title) {
    if (this.callPanelTitle) this.callPanelTitle.textContent = title || "";
  }

  setPanelSubtitle(subtitle) {
    if (this.callPanelSubtitle) this.callPanelSubtitle.textContent = subtitle || "";
  }

  clearRemoteGrid() {
    if (!this.callRemoteGrid) return;
    this.callRemoteGrid.innerHTML = "";
  }

  clearLocalPreview() {
    if (this.callLocalVideo) {
      this.callLocalVideo.classList.add("hidden");
      this.callLocalVideo.srcObject = null;
    }
    if (this.callLocalAudio) {
      this.callLocalAudio.classList.add("hidden");
      this.callLocalAudio.srcObject = null;
    }
    if (this.callLocalVoiceLabel) this.callLocalVoiceLabel.classList.remove("hidden");
  }

  attachLocalPreview(stream, mode) {
    if (!stream) return;
    if (mode === "video") {
      if (this.callLocalVoiceLabel) this.callLocalVoiceLabel.classList.add("hidden");
      if (this.callLocalVideo) {
        this.callLocalVideo.classList.remove("hidden");
        if (this.callLocalAudio) this.callLocalAudio.classList.add("hidden");
        this.callLocalVideo.srcObject = stream;
        this.callLocalVideo.play().catch(() => {});
      }
    } else {
      // Voice mode should never play back user's own microphone.
      // Keep only a label indicator; do not attach local stream to playable audio UI.
      if (this.callLocalVideo) this.callLocalVideo.classList.add("hidden");
      if (this.callLocalAudio) {
        this.callLocalAudio.classList.add("hidden");
        this.callLocalAudio.srcObject = null;
      }
      if (this.callLocalVoiceLabel) this.callLocalVoiceLabel.classList.remove("hidden");
    }
  }

  startRingtone() {
    if (!this.callRingtoneAudio) return;
    try {
      this.callRingtoneAudio.pause();
      this.callRingtoneAudio.currentTime = 0;
      const p = this.callRingtoneAudio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // ignore autoplay failures
    }
  }

  stopRingtone() {
    if (!this.callRingtoneAudio) return;
    try {
      this.callRingtoneAudio.pause();
      this.callRingtoneAudio.currentTime = 0;
    } catch {
      // ignore
    }
  }

  addRemoteStream(peerId, stream, mode) {
    if (!this.callRemoteGrid || !peerId || !stream) return;
    const id = "call-remote-" + peerId;
    let el = document.getElementById(id);

    if (mode === "video") {
      if (!el) {
        el = document.createElement("video");
        el.id = id;
        el.className = "call-video";
        el.autoplay = true;
        el.playsInline = true;
        el.muted = false;
        this.callRemoteGrid.appendChild(el);
      }
      el.srcObject = stream;
      el.play().catch(() => {});
    } else {
      if (!el) {
        el = document.createElement("audio");
        el.id = id;
        el.className = "call-audio";
        el.controls = true;
        this.callRemoteGrid.appendChild(el);
      }
      el.srcObject = stream;
      el.play().catch(() => {});
    }
  }

  removeRemoteStream(peerId) {
    if (!peerId) return;
    const el = document.getElementById("call-remote-" + peerId);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
}

class PeerConnectionManager {
  constructor({ ui, signaling, hooks }) {
    this.ui = ui;
    this.signaling = signaling;
    this.hooks = hooks || {};
    this.pcsByPeer = new Map(); // peerId -> RTCPeerConnection
  }

  hasPeer(peerId) {
    return this.pcsByPeer.has(peerId);
  }

  getPeer(peerId) {
    return this.pcsByPeer.get(peerId) || null;
  }

  createPeer(peerId, mode, localStream) {
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });

    pc.onicecandidate = (ev) => {
      if (!ev?.candidate) return;
      this.signaling.emitIceCandidate(peerId, ev.candidate);
    };

    pc.ontrack = (ev) => {
      const stream = (ev.streams && ev.streams[0] ? ev.streams[0] : null) || new MediaStream([ev.track]);
      this.ui.addRemoteStream(peerId, stream, mode);
      if (typeof this.hooks.onRemoteTrack === "function") this.hooks.onRemoteTrack(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && typeof this.hooks.onPeerConnected === "function") {
        this.hooks.onPeerConnected(peerId);
      }
    };

    // Add local tracks to the connection (caller + callee).
    if (localStream) {
      try {
        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      } catch {
        // ignore
      }
    }

    this.pcsByPeer.set(peerId, pc);
    return pc;
  }

  cleanupPeer(peerId) {
    const pc = this.pcsByPeer.get(peerId);
    try {
      if (pc) pc.close();
    } catch {
      // ignore
    }
    this.pcsByPeer.delete(peerId);
    this.ui.removeRemoteStream(peerId);
  }

  cleanupAll() {
    for (const peerId of this.pcsByPeer.keys()) this.cleanupPeer(peerId);
  }

  peerCount() {
    return this.pcsByPeer.size;
  }
}

class SocketSignaling {
  constructor() {
    this.socket = null;
    this.ready = false;
    this.connectPromise = null;
  }

  async ensureConnected() {
    if (this.ready && this.socket) return this.socket;
    if (this.connectPromise) return this.connectPromise;

    const token = (await waitForBootToken()) || getBootToken();
    if (!token) throw new Error("Missing socket bootstrap token (boot.socket_bootstrap_token).");

    if (typeof io !== "function") throw new Error("Socket.IO client not loaded.");

    const socketBaseUrl = getSocketBaseUrl();
    this.connectPromise = new Promise((resolve) => {
      const socket = io(socketBaseUrl, {
        auth: { token },
        path: "/socket.io",
        // Use polling first for compatibility; websocket can upgrade afterwards.
        transports: ["polling", "websocket"],
      });
      this.socket = socket;

      socket.on("connect", () => {
        this.ready = true;
        resolve(socket);
      });
      socket.on("connect_error", () => {
        this.ready = false;
        resolve(socket);
      });
    });

    return this.connectPromise;
  }

  onIncomingCall(cb) {
    this.socket?.on("incoming-call", cb);
  }

  onCallAnswered(cb) {
    this.socket?.on("call-answered", cb);
  }

  onIceCandidate(cb) {
    this.socket?.on("ice-candidate", cb);
  }

  onCallEnded(cb) {
    this.socket?.on("call-ended", cb);
  }

  emitIceCandidate(toPeerId, candidate) {
    if (!this.socket) return;
    this.socket.emit("ice-candidate", { to: toPeerId, candidate });
  }

  emitCallUser(toPeerId, offerPayload, mode, context) {
    return new Promise((resolve) => {
      this.socket.emit("call-user", { to: toPeerId, offer: offerPayload, type: mode, context }, (resp) => resolve(resp));
    });
  }

  emitAnswerCall(toPeerId, answerPayload) {
    this.socket.emit("answer-call", { to: toPeerId, answer: answerPayload });
  }

  emitEndCall(toPeerId) {
    this.socket.emit("end-call", { to: toPeerId });
  }
}

class CallController {
  constructor() {
    this.ui = new CallUI();
    this.signaling = new SocketSignaling();
    this.peers = new PeerConnectionManager({
      ui: this.ui,
      signaling: this.signaling,
      hooks: {
        onPeerConnected: () => this.markConnected(),
        onRemoteTrack: () => this.markConnected(),
      },
    });

    this.state = {
      active: false,
      mode: null, // "voice" | "video"
      uiContext: null,
      localStream: null,
      pendingIncomingByPeer: new Map(), // peerId -> { offer, type }
      pendingIceByPeer: new Map(), // peerId -> Array<candidate>
      startedAt: null,
      connectedAt: null,
      outgoing: false,
      targetPeerIds: [],
      primaryPeerId: null,
      logFinalized: false,
    };

    this._signalingHandlersBound = false;
  }

  markConnected() {
    if (!this.state.connectedAt) this.state.connectedAt = new Date();
    const modeLabel = this.state.mode === "video" ? "Video" : "Voice";
    this.ui.setStatus("Connected - " + modeLabel + " call");
  }

  get pendingIncomingPeerIds() {
    return Array.from(this.state.pendingIncomingByPeer.keys());
  }

  get pendingIceByPeerMap() {
    return this.state.pendingIceByPeer;
  }

  async ensureLocalStream(mode) {
    const existing = this.state.localStream;
    const hasVideo = !!(existing && typeof existing.getVideoTracks === "function" && existing.getVideoTracks().length > 0);
    if (existing) {
      if (mode === "video" && hasVideo) return existing;
      if (mode === "voice" && !hasVideo) return existing;
      // Mode mismatch (e.g. voice->video): stop and reacquire.
      this.stopLocalStream();
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === "video" });
    this.state.localStream = stream;
    return stream;
  }

  stopLocalStream() {
    const stream = this.state.localStream;
    if (!stream) return;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }
    this.state.localStream = null;
    this.ui.clearLocalPreview();
  }

  async ensureSignalingReady() {
    const socket = await this.signaling.ensureConnected();
    if (!this._signalingHandlersBound) {
      this.signaling.onIncomingCall((data) => this.handleIncomingCall(data));
      this.signaling.onCallAnswered((data) => this.handleCallAnswered(data));
      this.signaling.onIceCandidate((data) => this.handleIceCandidate(data));
      this.signaling.onCallEnded((data) => this.handleCallEnded(data));
      this._signalingHandlersBound = true;
    }
    return socket;
  }

  async startOutgoing(targetPeerIds, mode, context) {
    const ids = (targetPeerIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (!ids.length) return alert("No one available to call.");

    this.state.mode = mode;
    this.state.active = true;
    this.state.uiContext = context || null;
    this.state.pendingIncomingByPeer.clear();
    this.state.pendingIceByPeer.clear();
    this.state.startedAt = new Date();
    this.state.connectedAt = null;
    this.state.outgoing = true;
    this.state.targetPeerIds = ids.slice();
    this.state.primaryPeerId = ids.length === 1 ? ids[0] : null;
    this.state.logFinalized = false;

    this.ui.stopRingtone();
    this.ui.clearRemoteGrid();
    this.ui.setPanelVisible(false);
    this.ui.setModalVisible(true);
    this.ui.setEndEnabled(true);
    this.ui.setAcceptRejectState({ canAccept: false, canReject: false });

    const cl = this.state.uiContext?.chat?.name ? String(this.state.uiContext.chat.name) : "";
    this.ui.setStatus("Calling… " + (mode === "video" ? "Video" : "Voice") + (cl ? " · " + cl : ""));

    try {
      await this.ensureSignalingReady();
      const localStream = await this.ensureLocalStream(mode);
      this.ui.attachLocalPreview(localStream, mode);

      let ackPending = ids.length;
      let ackOkCount = 0;

      for (const peerId of ids) {
        const pc = this.peers.createPeer(peerId, mode, localStream);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const ld = pc.localDescription;
        const offerPayload = ld ? { type: ld.type, sdp: ld.sdp } : null;
        if (!offerPayload) continue;

        // ack tells us whether DM permission was granted to the caller.
        // For group calls, backend uses policy checks too.
        await this.signaling.emitCallUser(peerId, offerPayload, mode, this.state.uiContext).then((resp) => {
          if (resp && resp.ok) ackOkCount += 1;
          ackPending -= 1;
        });
      }

      // If permission denied for everyone, reset immediately.
      if (ackPending <= 0 && ackOkCount <= 0) {
        alert("Call blocked by permissions. Try DM call instead.");
        this.endCall();
        return;
      }

      const startedMarker = this.state.startedAt;
      setTimeout(() => {
        if (!this.state.active) return;
        if (!this.state.outgoing) return;
        if (this.state.startedAt !== startedMarker) return;
        if (this.state.connectedAt) return;
        this.finalizeCallLog("missed");
        this.endCall();
      }, 25000);
    } catch (e) {
      console.error(e);
      alert("Could not start call: " + (e?.message ? e.message : "error"));
      this.resetUiAndState();
    }
  }

  async acceptIncoming() {
    const fromIds = this.pendingIncomingPeerIds;
    if (!fromIds.length) {
      this.ui.setStatus("No pending call to accept.");
      return;
    }

    this.ui.stopRingtone();
    this.ui.setPanelVisible(false);
    this.ui.setModalVisible(true);
    this.ui.setEndEnabled(true);
    this.ui.setAcceptRejectState({ canAccept: false, canReject: false });

    const first = this.state.pendingIncomingByPeer.get(fromIds[0]);
    this.state.mode = first?.type || this.state.mode || "voice";
    this.state.active = true;
    this.state.startedAt = new Date();
    this.state.connectedAt = null;
    this.state.outgoing = false;
    this.state.targetPeerIds = fromIds.slice();
    this.state.primaryPeerId = fromIds.length === 1 ? fromIds[0] : null;
    this.state.logFinalized = false;

    this.ui.setStatus("Connecting…");

    try {
      await this.ensureSignalingReady();
      const localStream = await this.ensureLocalStream(this.state.mode);
      this.ui.attachLocalPreview(localStream, this.state.mode);

      for (const fromId of fromIds) {
        const req = this.state.pendingIncomingByPeer.get(fromId);
        if (!req?.offer) continue;

        const pc = this.peers.createPeer(fromId, this.state.mode, localStream);
        await pc.setRemoteDescription(new RTCSessionDescription(req.offer));

        const pending = this.pendingIceByPeerMap.get(fromId);
        if (pending && pending.length) {
          this.pendingIceByPeerMap.delete(fromId);
          for (const cand of pending) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch {
              // ignore
            }
          }
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const ald = pc.localDescription;
        const answerPayload = ald ? { type: ald.type, sdp: ald.sdp } : null;
        if (answerPayload) this.signaling.emitAnswerCall(fromId, answerPayload);
      }

      this.state.pendingIncomingByPeer.clear();
    } catch (e) {
      console.error(e);
      alert("Could not accept call.");
      this.resetUiAndState();
    }
  }

  rejectIncoming() {
    const fromIds = this.pendingIncomingPeerIds;
    for (const fromId of fromIds) this.signaling.emitEndCall(fromId);
    this.finalizeCallLog("declined");
    this.resetUiAndState();
  }

  endCall() {
    // End all connected + pending peers.
    const connected = Array.from(this.peers.pcsByPeer.keys());
    const pending = this.pendingIncomingPeerIds;
    const ids = Array.from(new Set([...connected, ...pending]));
    for (const id of ids) this.signaling.emitEndCall(id);
    this.finalizeCallLog("ended");
    this.resetUiAndState();
  }

  async postDmCallLog(peerId, text) {
    if (!Number.isFinite(Number(peerId)) || !text) return;
    try {
      await fetch("/api/send_message", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          type: "text",
          receiver_id: Number(peerId),
        }),
      });
    } catch (e) {
      console.warn("Failed to post call log:", e);
    }
  }

  finalizeCallLog(reason) {
    if (this.state.logFinalized) return;
    this.state.logFinalized = true;

    const context = this.state.uiContext?.chat || null;
    if (!context || context.kind !== "dm") return;

    const peerId =
      (Number.isFinite(Number(this.state.primaryPeerId)) && Number(this.state.primaryPeerId)) ||
      (this.state.targetPeerIds.length === 1 ? Number(this.state.targetPeerIds[0]) : null);
    if (!Number.isFinite(Number(peerId))) return;

    const startedAt = this.state.startedAt || new Date();
    const connectedAt = this.state.connectedAt || null;
    const startedText = formatClockTime(startedAt);
    const modeLabel = this.state.mode === "video" ? "video" : "voice";

    if (reason === "declined") {
      this.postDmCallLog(peerId, "Call declined (" + modeLabel + ") at " + startedText);
      return;
    }

    if (reason === "missed" || !connectedAt) {
      this.postDmCallLog(peerId, "Missed call (" + modeLabel + ") at " + startedText);
      return;
    }

    const durationMs = Date.now() - new Date(connectedAt).getTime();
    const durationText = formatDurationMs(durationMs);
    this.postDmCallLog(
      peerId,
      "Call ended (" + modeLabel + ") - Started: " + startedText + " - Duration: " + durationText
    );
  }

  resetUiAndState(keepPanelHidden = false) {
    this.ui.stopRingtone();
    this.state.active = false;
    this.state.mode = null;
    this.state.uiContext = null;

    this.state.pendingIncomingByPeer.clear();
    this.state.pendingIceByPeer.clear();
    this.state.startedAt = null;
    this.state.connectedAt = null;
    this.state.outgoing = false;
    this.state.targetPeerIds = [];
    this.state.primaryPeerId = null;
    this.state.logFinalized = false;

    this.peers.cleanupAll();
    this.ui.setStatus("");
    this.ui.setAcceptRejectState({ canAccept: false, canReject: false });
    this.ui.setEndEnabled(false);
    this.ui.setModalVisible(false);
    if (!keepPanelHidden) this.ui.setPanelVisible(false);
    this.ui.clearRemoteGrid();
    this.stopLocalStream();
  }

  handleIncomingCall(data) {
    try {
      const fromId = Number(data?.from);
      const offer = data?.offer || null;
      const type = data?.type === "video" ? "video" : "voice";
      if (!Number.isFinite(fromId) || !offer) return;

      this.state.pendingIncomingByPeer.set(fromId, { offer, type });

      // If we’re already in a call and we already have a PC for this peer,
      // treat it as mid-call renegotiation (silent upgrade), per Slack v18 flow.
      const existingPc = this.peers.getPeer(fromId);
      if (this.state.active && existingPc) {
        (async () => {
          try {
            // Ensure local media matches the renegotiated mode.
            const localStream = await this.ensureLocalStream(type);
            this.state.mode = type;
            this.ui.attachLocalPreview(localStream, type);

            // Replace/attach tracks so the peer connection matches requested mode.
            localStream.getTracks().forEach((t) => {
              const senders = existingPc.getSenders ? existingPc.getSenders().filter((s) => s.track && s.track.kind === t.kind) : [];
              if (senders && senders.length && senders[0].replaceTrack) {
                senders[0].replaceTrack(t).catch(() => {});
              } else {
                try {
                  existingPc.addTrack(t, localStream);
                } catch {}
              }
            });

            // Apply the incoming offer and respond with an answer.
            await existingPc.setRemoteDescription(new RTCSessionDescription(offer));

            const pending = this.pendingIceByPeerMap.get(fromId);
            if (pending && pending.length) {
              this.pendingIceByPeerMap.delete(fromId);
              for (const cand of pending) {
                try {
                  await existingPc.addIceCandidate(new RTCIceCandidate(cand));
                } catch {
                  // ignore
                }
              }
            }

            const answer = await existingPc.createAnswer();
            await existingPc.setLocalDescription(answer);
            const ald = existingPc.localDescription;
            const answerPayload = ald ? { type: ald.type, sdp: ald.sdp } : null;
            if (answerPayload) this.signaling.emitAnswerCall(fromId, answerPayload);

            // Clear pending offer now that we handled renegotiation.
            this.state.pendingIncomingByPeer.delete(fromId);
          } catch (e) {
            console.error("renegotiation (incoming-call) failed", e);
          }
        })();
        return;
      }

      // If we’re already in a call, don't interrupt the active session UI.
      if (this.state.active) return;

      this.state.uiContext = data?.context || null;
      this.state.mode = type;

      this.ui.clearRemoteGrid();
      this.ui.setModalVisible(false);
      this.ui.setPanelVisible(true);
      this.ui.setEndEnabled(false);
      this.ui.setAcceptRejectState({ canAccept: true, canReject: true });

      const email = data?.from_email ? String(data.from_email) : "";
      const title = "Incoming " + (type === "video" ? "video" : "voice") + " call" + (email ? " from " + email : "");
      const subtitle =
        (data?.context && data.context.chat && data.context.chat.name && String(data.context.chat.name)) || "—";
      this.ui.setPanelTitle(title);
      this.ui.setPanelSubtitle(subtitle);

      const chatName = subtitle && subtitle !== "—" ? String(subtitle) : "";
      this.ui.setStatus("Incoming " + (type === "video" ? "video" : "voice") + " call… " + (chatName ? "· " + chatName : ""));

      this.ui.startRingtone();
    } catch (e) {
      console.error("incoming-call handler error", e);
    }
  }

  async handleCallAnswered(data) {
    try {
      const fromId = Number(data?.from);
      const answer = data?.answer;
      if (!Number.isFinite(fromId) || !answer) return;
      const pc = this.peers.getPeer(fromId);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      this.markConnected();

      // If ICE arrived early, add it now that remote description exists.
      const pending = this.pendingIceByPeerMap.get(fromId);
      if (pending && pending.length) {
        this.pendingIceByPeerMap.delete(fromId);
        for (const cand of pending) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch {
            // ignore
          }
        }
      }
    } catch (e) {
      console.error("call-answered handler error", e);
    }
  }

  handleIceCandidate(data) {
    try {
      const fromId = Number(data?.from);
      const candidate = data?.candidate;
      if (!Number.isFinite(fromId) || !candidate) return;

      const pc = this.peers.getPeer(fromId);
      // Queue until the RTCPeerConnection has a remote description.
      // This prevents early ICE from being lost when `setRemoteDescription()` hasn't run yet.
      if (!pc || !pc.remoteDescription) {
        if (!this.pendingIceByPeerMap.has(fromId)) this.pendingIceByPeerMap.set(fromId, []);
        this.pendingIceByPeerMap.get(fromId).push(candidate);
        return;
      }

      pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    } catch (e) {
      console.error("ice-candidate handler error", e);
    }
  }

  handleCallEnded(data) {
    try {
      const fromId = Number(data?.from);
      if (!Number.isFinite(fromId)) return;

      // If this peer was still only "ringing" (not yet accepted), clear it.
      this.state.pendingIncomingByPeer.delete(fromId);
      this.state.pendingIceByPeer.delete(fromId);

      this.peers.cleanupPeer(fromId);

      // If nothing is left (connected and pending), fully reset.
      const hasPeers = this.peers.peerCount() > 0;
      const hasPendingIncoming = this.pendingIncomingPeerIds.length > 0;
      if (!hasPeers && !hasPendingIncoming) {
        if (this.state.outgoing && !this.state.connectedAt) this.finalizeCallLog("declined");
        else this.finalizeCallLog("ended");
        this.resetUiAndState();
      }
    } catch (e) {
      console.error("call-ended handler error", e);
    }
  }
}

function safeGetGroupLabel() {
  const selectedGroupId = window?.selectedGroupId || null;
  if (!selectedGroupId) return "Group";
  try {
    const g = typeof window?.getGroup === "function" ? window.getGroup(selectedGroupId) : null;
    return (g && (g.display_name || g.name)) || selectedGroupId || "Group";
  } catch {
    return String(selectedGroupId);
  }
}

function safeGetChatTargets() {
  try {
    const dmMembers = window?.dmMembers;
    if (!Array.isArray(dmMembers)) return [];
    return dmMembers.map((m) => Number(m.id)).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function safeGetDmTarget() {
  const activeDmUserId = window?.activeDmUserId;
  if (!Number.isFinite(Number(activeDmUserId))) return null;
  return Number(activeDmUserId);
}

function safeDmLabel() {
  const activeDmUserId = safeGetDmTarget();
  if (activeDmUserId == null) return "DM";
  try {
    const dmMembers = window?.dmMembers;
    const target = Array.isArray(dmMembers) ? dmMembers.find((m) => Number(m.id) === Number(activeDmUserId)) : null;
    if (target && typeof window?.memberDisplayName === "function") return window.memberDisplayName(target);
    return String(activeDmUserId);
  } catch {
    return String(activeDmUserId);
  }
}

function mountCallModule() {
  const controller = new CallController();

  // Attach incoming call UI buttons.
  if (controller.ui.callAcceptBtn) controller.ui.callAcceptBtn.addEventListener("click", () => controller.acceptIncoming());
  if (controller.ui.callRejectBtn) controller.ui.callRejectBtn.addEventListener("click", () => controller.rejectIncoming());
  if (controller.ui.callPanelAcceptBtn) controller.ui.callPanelAcceptBtn.addEventListener("click", () => controller.acceptIncoming());
  if (controller.ui.callPanelRejectBtn) controller.ui.callPanelRejectBtn.addEventListener("click", () => controller.rejectIncoming());
  if (controller.ui.callEndBtn) controller.ui.callEndBtn.addEventListener("click", () => controller.endCall());

  // Outgoing call buttons
  const chatVoiceBtn = $("chat-voice-call-btn");
  const chatVideoBtn = $("chat-video-call-btn");
  if (chatVoiceBtn) {
    chatVoiceBtn.addEventListener("click", () => {
      if (chatVoiceBtn.disabled) return;
      const targets = safeGetChatTargets();
      if (!targets.length) return alert("No team members available for call.");
      controller.startOutgoing(targets, "voice", { chat: { kind: "group", name: safeGetGroupLabel() } });
    });
  }
  if (chatVideoBtn) {
    chatVideoBtn.addEventListener("click", () => {
      if (chatVideoBtn.disabled) return;
      const targets = safeGetChatTargets();
      if (!targets.length) return alert("No team members available for call.");
      controller.startOutgoing(targets, "video", { chat: { kind: "group", name: safeGetGroupLabel() } });
    });
  }

  const dmVoiceBtn = $("dm-voice-call-btn");
  const dmVideoBtn = $("dm-video-call-btn");
  if (dmVoiceBtn) {
    dmVoiceBtn.addEventListener("click", () => {
      if (dmVoiceBtn.disabled) return;
      const peerId = safeGetDmTarget();
      if (peerId == null) return alert("Select a DM first.");
      controller.startOutgoing([peerId], "voice", { chat: { kind: "dm", name: safeDmLabel() } });
    });
  }
  if (dmVideoBtn) {
    dmVideoBtn.addEventListener("click", () => {
      if (dmVideoBtn.disabled) return;
      const peerId = safeGetDmTarget();
      if (peerId == null) return alert("Select a DM first.");
      controller.startOutgoing([peerId], "video", { chat: { kind: "dm", name: safeDmLabel() } });
    });
  }

  // Ensure we listen for incoming calls even before user navigates.
  // This keeps the receiver responsive.
  controller.ensureSignalingReady().catch((e) => {
    console.warn("Call signaling init failed:", e);
  });
}

// Mount immediately (HTML is already loaded in this template).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountCallModule);
} else {
  mountCallModule();
}


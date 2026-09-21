/* ==========================================================================
   JOHN MINGLE — ADVANCED CLIENT APPLICATION
   Features: WebRTC HD, Web Audio Sound Synthesizer, Real-Time Video FX,
             Screen Sharing, Floating Emoji Bursts, Voice Speaker Glow,
             Polaroid Snapshot, Icebreakers & Keyboard Shortcuts.
   ========================================================================== */

const token = localStorage.getItem("token");
const username = localStorage.getItem("username");

if (!token) {
  location.href = "/";
}

const API_URL = localStorage.getItem("API_URL") || "";
const SERVER_URL = API_URL || location.origin;

// DOM Elements
const usernameEl = document.getElementById("username");
if (usernameEl) usernameEl.textContent = username || "User";
const userAvatarEl = document.getElementById("userAvatar");
if (userAvatarEl && username) userAvatarEl.textContent = username.charAt(0).toUpperCase();

const status = document.getElementById("status");
const partnerName = document.getElementById("partnerName");
const partnerSubtitle = document.getElementById("partnerSubtitle");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const messages = document.getElementById("messages");
const videoCard = document.querySelector(".video-card");
const videoPlaceholder = document.querySelector(".video-placeholder");
const reactionsOverlay = document.getElementById("reactionsOverlay");
const myVideoContainer = document.getElementById("myVideoContainer");
const soundToggleBtn = document.getElementById("soundToggle");
const filterBtn = document.getElementById("filterBtn");
const filterMenu = document.getElementById("filterMenu");
const screenShareBtn = document.getElementById("screenShare");
const typingIndicator = document.getElementById("typingIndicator");
const icebreakerText = document.getElementById("icebreakerText");
const shuffleTopicBtn = document.getElementById("shuffleTopicBtn");
const headerOnlineCount = document.getElementById("headerOnlineCount");

// WebRTC and Stream State
let socket = null;
let localStream = null;
let screenStream = null;
let peer = null;
let matched = false;
let isScreenSharing = false;
let currentFilter = "normal";
let soundMuted = localStorage.getItem("mingle_sound_muted") === "true";

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// ==========================================================================
// 1. WEB AUDIO SYNTHESIZER (No external audio files needed!)
// ==========================================================================
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

function playSound(type) {
  if (soundMuted) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    if (type === "match") {
      // Pleasant 3-tone arpeggio (C5 -> E5 -> G5)
      const freqs = [523.25, 659.25, 783.99];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, now + i * 0.1);
        gain.gain.setValueAtTime(0.001, now + i * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.1 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.1);
        osc.stop(now + i * 0.1 + 0.38);
      });
    } else if (type === "message") {
      // Cute glass bubble ping
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === "reaction") {
      // Bouncy pop sound
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(950, now + 0.09);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (type === "click") {
      // Gentle mechanical click
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(600, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    }
  } catch (e) {
    console.warn("Audio play error", e);
  }
}

// Sound toggle button setup
if (soundToggleBtn) {
  soundToggleBtn.textContent = soundMuted ? "🔇" : "🔊";
  soundToggleBtn.onclick = () => {
    soundMuted = !soundMuted;
    localStorage.setItem("mingle_sound_muted", String(soundMuted));
    soundToggleBtn.textContent = soundMuted ? "🔇" : "🔊";
    if (!soundMuted) playSound("click");
  };
}

// ==========================================================================
// 2. VOICE ACTIVITY ANALYZER (Speaker Pulse Ring Glow)
// ==========================================================================
let localAudioMeter = null;

function setupLocalVoiceDetection(stream) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function checkVoice() {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;
      if (myVideoContainer) {
        if (avg > 25) {
          myVideoContainer.classList.add("active-speaker");
        } else {
          myVideoContainer.classList.remove("active-speaker");
        }
      }
      requestAnimationFrame(checkVoice);
    }
    checkVoice();
  } catch (err) {
    console.warn("Voice detection setup note:", err);
  }
}

// ==========================================================================
// 3. UI STATE HELPERS
// ==========================================================================
function setStatus(text) {
  if (status) status.textContent = text;
}

function showFinding() {
  if (videoCard) videoCard.classList.remove("connected");
  if (videoPlaceholder) videoPlaceholder.style.display = "";
}

function hideFinding() {
  if (videoCard) videoCard.classList.add("connected");
  if (videoPlaceholder) videoPlaceholder.style.display = "none";
}

function send(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function formatTime() {
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

function addMessage(senderName, text, isYou) {
  const div = document.createElement("div");
  div.className = `message ${isYou ? "you" : "stranger"}`;

  const strong = document.createElement("strong");
  strong.textContent = senderName;

  const span = document.createElement("span");
  span.textContent = text;

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime();

  div.appendChild(strong);
  div.appendChild(span);
  div.appendChild(time);

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;

  if (!isYou) {
    playSound("message");
  }
}

// ==========================================================================
// 4. FLOATING EMOJI BURSTS
// ==========================================================================
function spawnFloatingEmoji(emoji) {
  if (!reactionsOverlay) return;

  // Create 5-7 emoji particles drifting upward
  const count = 6;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "floating-emoji";
    el.textContent = emoji;

    // Randomize initial position and drift
    const startX = 30 + Math.random() * 40; // 30% to 70% width
    const driftX = (Math.random() - 0.5) * 160; // -80px to 80px
    const rot = (Math.random() - 0.5) * 50; // -25deg to 25deg
    const delay = Math.random() * 0.25;

    el.style.left = `${startX}%`;
    el.style.setProperty("--drift-x", `${driftX}px`);
    el.style.setProperty("--rot", `${rot}deg`);
    el.style.animationDelay = `${delay}s`;

    reactionsOverlay.appendChild(el);

    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3200);
  }

  playSound("reaction");
}

function sendReaction(emoji) {
  spawnFloatingEmoji(emoji);
  if (matched) {
    send({
      type: "reaction",
      emoji: emoji
    });
  }
}

// Attach reaction pill listeners
document.querySelectorAll(".reaction-pill").forEach(btn => {
  btn.onclick = () => {
    const emoji = btn.getAttribute("data-emoji") || "🔥";
    sendReaction(emoji);
  };
});

// ==========================================================================
// 5. VIDEO FX FILTERS
// ==========================================================================
if (filterBtn && filterMenu) {
  filterBtn.onclick = (e) => {
    e.stopPropagation();
    filterMenu.classList.toggle("open");
  };

  document.addEventListener("click", (e) => {
    if (!filterMenu.contains(e.target) && e.target !== filterBtn) {
      filterMenu.classList.remove("open");
    }
  });

  document.querySelectorAll(".filter-opt").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".filter-opt").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const filterType = btn.getAttribute("data-filter") || "normal";
      currentFilter = filterType;

      // Remove existing fx classes
      const fxClasses = ["fx-normal", "fx-cyber", "fx-vhs", "fx-noir", "fx-dream", "fx-matrix"];
      fxClasses.forEach(cls => {
        localVideo.classList.remove(cls);
        remoteVideo.classList.remove(cls);
      });

      const newCls = `fx-${filterType}`;
      localVideo.classList.add(newCls);
      remoteVideo.classList.add(newCls);

      filterMenu.classList.remove("open");
      playSound("click");
    };
  });
}

// ==========================================================================
// 6. SCREEN SHARING
// ==========================================================================
async function toggleScreenShare() {
  if (!localStream) return;

  if (isScreenSharing) {
    // Revert to camera
    stopScreenShare();
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: false
      });

      const screenTrack = screenStream.getVideoTracks()[0];

      // Replace track on RTCPeerConnection sender
      if (peer) {
        const senders = peer.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === "video");
        if (videoSender) {
          videoSender.replaceTrack(screenTrack);
        }
      }

      // Update local preview
      localVideo.srcObject = screenStream;
      isScreenSharing = true;
      if (screenShareBtn) screenShareBtn.classList.add("active-feature");

      // Handle user clicking native "Stop sharing" chrome banner
      screenTrack.onended = () => {
        stopScreenShare();
      };

      playSound("click");
    } catch (err) {
      console.log("Screen share cancelled or failed:", err);
    }
  }
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    if (peer && camTrack) {
      const senders = peer.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === "video");
      if (videoSender) {
        videoSender.replaceTrack(camTrack);
      }
    }
    localVideo.srcObject = localStream;
  }

  isScreenSharing = false;
  if (screenShareBtn) screenShareBtn.classList.remove("active-feature");
  playSound("click");
}

if (screenShareBtn) {
  screenShareBtn.onclick = toggleScreenShare;
}

// ==========================================================================
// 7. CAMERA & MICROPHONE INITIALIZATION
// ==========================================================================
async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });

    localVideo.srcObject = localStream;
    setupLocalVoiceDetection(localStream);

  } catch (error) {
    console.error(error);
    alert("Camera and microphone permission is required to mingle.");
  }
}

// ==========================================================================
// 8. WEBRTC PEER CONNECTION
// ==========================================================================
async function createPeer() {
  if (peer) return;

  peer = new RTCPeerConnection(rtcConfig);

  const activeStream = isScreenSharing && screenStream ? screenStream : localStream;
  if (activeStream) {
    activeStream.getTracks().forEach(track => {
      peer.addTrack(track, activeStream);
    });
  }

  peer.ontrack = event => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      hideFinding();
      remoteVideo.play().catch(() => {});
    }
  };

  peer.onicecandidate = event => {
    if (event.candidate) {
      send({
        type: "signal",
        signal: { candidate: event.candidate }
      });
    }
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "connected") {
      hideFinding();
      setStatus("Connected");
      playSound("match");
    }

    if (peer.connectionState === "failed") {
      closePeer();
    }

    if (peer.connectionState === "disconnected") {
      setStatus("Connection interrupted...");
    }
  };
}

async function makeOffer() {
  await createPeer();
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  send({
    type: "signal",
    signal: { description: peer.localDescription }
  });
}

async function handleSignal(signal) {
  await createPeer();

  if (signal.description) {
    await peer.setRemoteDescription(new RTCSessionDescription(signal.description));

    if (signal.description.type === "offer") {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      send({
        type: "signal",
        signal: { description: peer.localDescription }
      });
    }
  }

  if (signal.candidate) {
    try {
      await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (error) {
      console.log("ICE error", error);
    }
  }
}

function closePeer() {
  if (peer) {
    peer.close();
    peer = null;
  }
  remoteVideo.srcObject = null;
  if (isScreenSharing) {
    stopScreenShare();
  }
  showFinding();
}

// ==========================================================================
// 9. WEBSOCKET LOGIC
// ==========================================================================
function connect() {
  const protocol = SERVER_URL.startsWith("https") ? "wss" : "ws";
  const host = SERVER_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");

  socket = new WebSocket(`${protocol}://${host}?token=${encodeURIComponent(token)}`);

  socket.onopen = () => {
    showFinding();
    setStatus("Finding someone...");
    send({ type: "find" });
  };

  socket.onclose = () => {
    matched = false;
    showFinding();
    setStatus("Server disconnected");
  };

  socket.onerror = () => {
    setStatus("Connection error");
  };

  socket.onmessage = async event => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "waiting") {
      matched = false;
      showFinding();
      partnerName.textContent = "Stranger";
      if (partnerSubtitle) partnerSubtitle.textContent = "Looking for matches...";
      setStatus("Waiting for someone...");
      return;
    }

    if (data.type === "matched") {
      matched = true;
      partnerName.textContent = data.partner;
      if (partnerSubtitle) partnerSubtitle.textContent = "Live Stranger Match";
      setStatus("Connected");
      messages.innerHTML = "";
      shuffleTopic();

      if (data.initiator) {
        await makeOffer();
      }
      return;
    }

    if (data.type === "chat") {
      addMessage(data.username, data.message, false);
      return;
    }

    if (data.type === "reaction") {
      spawnFloatingEmoji(data.emoji || "🔥");
      return;
    }

    if (data.type === "typing") {
      if (typingIndicator) {
        if (data.isTyping) {
          typingIndicator.classList.add("active");
        } else {
          typingIndicator.classList.remove("active");
        }
      }
      return;
    }

    if (data.type === "online_count") {
      if (headerOnlineCount) {
        const count = data.count || 1;
        headerOnlineCount.textContent = count > 1 ? `${count} Online` : `Online`;
      }
      return;
    }

    if (data.type === "signal") {
      await handleSignal(data.signal);
      return;
    }

    if (data.type === "partner_left") {
      matched = false;
      closePeer();
      partnerName.textContent = "Stranger";
      if (partnerSubtitle) partnerSubtitle.textContent = "Finding someone...";
      setStatus("Stranger left. Finding another...");
      send({ type: "find" });
      return;
    }

    if (data.type === "reported") {
      alert("User report submitted. Thank you for keeping Mingle safe.");
    }
  };
}

// ==========================================================================
// 10. CHAT INPUT & TYPING INDICATOR
// ==========================================================================
const messageInput = document.getElementById("message");
let typingTimeout = null;

if (messageInput) {
  messageInput.addEventListener("input", () => {
    if (!matched) return;
    send({ type: "typing", isTyping: true });

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      send({ type: "typing", isTyping: false });
    }, 1500);
  });
}

document.getElementById("messageForm").onsubmit = event => {
  event.preventDefault();
  const input = document.getElementById("message");
  const text = input.value.trim();

  if (!text || !matched) return;

  addMessage("You", text, true);
  send({ type: "chat", message: text });
  send({ type: "typing", isTyping: false });

  input.value = "";
  input.focus();
};

// ==========================================================================
// 11. NEXT & REPORT & LOGOUT
// ==========================================================================
function doNext() {
  playSound("click");
  closePeer();
  matched = false;
  messages.innerHTML = "";
  partnerName.textContent = "Stranger";
  if (partnerSubtitle) partnerSubtitle.textContent = "Matching...";
  showFinding();
  setStatus("Finding someone...");
  send({ type: "next" });
}

document.getElementById("next").onclick = doNext;

document.getElementById("camera").onclick = () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const camBtn = document.getElementById("camera");
  camBtn.textContent = track.enabled ? "📷" : "🚫";
  if (track.enabled) {
    camBtn.classList.remove("off");
  } else {
    camBtn.classList.add("off");
  }
  playSound("click");
};

document.getElementById("mic").onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const micBtn = document.getElementById("mic");
  micBtn.textContent = track.enabled ? "🎤" : "🔇";
  if (track.enabled) {
    micBtn.classList.remove("muted");
  } else {
    micBtn.classList.add("muted");
  }
  playSound("click");
};

document.getElementById("report").onclick = () => {
  if (!matched) {
    alert("You aren't connected to anyone.");
    return;
  }
  if (confirm("Report this person for inappropriate behavior?")) {
    send({ type: "report" });
  }
};

document.getElementById("logout").onclick = () => {
  if (socket) socket.close();
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  location.href = "/";
};

// ==========================================================================
// 12. SMART ICEBREAKERS TOPIC GENERATOR
// ==========================================================================
const topics = [
  "What is the best movie or series you've watched recently?",
  "If you could teleport anywhere in the world right now, where to?",
  "What's your all-time favorite comfort food?",
  "Would you rather explore deep space or the deep ocean?",
  "What's the best concert or live show you've ever been to?",
  "What's a totally useless talent or skill you have?",
  "If you won $5,000,000 today, what's your first purchase?",
  "What song do you have on repeat lately?",
  "Are you an early bird or a night owl?",
  "What's the funniest or weirdest rumor you've ever heard?",
  "If you had to eat one cuisine forever, what is it?",
  "Coffee, tea, or energy drinks to start your day?",
  "What superpower would make your daily life 10x easier?",
  "What is your dream bucket list vacation?"
];

function shuffleTopic() {
  const randomTopic = topics[Math.floor(Math.random() * topics.length)];
  if (icebreakerText) {
    icebreakerText.textContent = `🎲 ${randomTopic}`;
  }
}

if (shuffleTopicBtn) {
  shuffleTopicBtn.onclick = () => {
    shuffleTopic();
    playSound("click");
  };
}

if (icebreakerText) {
  icebreakerText.onclick = () => {
    const rawText = icebreakerText.textContent.replace(/^🎲\s*/, "");
    if (messageInput && rawText) {
      messageInput.value = rawText;
      messageInput.focus();
    }
  };
}

// ==========================================================================
// 13. POLAROID SNAPSHOT PHOTO BOOTH
// ==========================================================================
const snapshotBtn = document.getElementById("snapshotBtn");
const snapshotModal = document.getElementById("snapshotModal");
const snapshotPreviewImg = document.getElementById("snapshotPreviewImg");
const downloadSnapshotBtn = document.getElementById("downloadSnapshotBtn");

function capturePolaroid() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  canvas.width = 900;
  canvas.height = 700;

  // Polaroid Card Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Inner Photo Matte
  ctx.fillStyle = "#111019";
  ctx.fillRect(35, 35, 830, 500);

  // Draw Stranger video on left
  try {
    if (remoteVideo && remoteVideo.videoWidth > 0) {
      ctx.drawImage(remoteVideo, 35, 35, 415, 500);
    } else {
      ctx.fillStyle = "#1a1829";
      ctx.fillRect(35, 35, 415, 500);
      ctx.fillStyle = "#8b5cf6";
      ctx.font = "bold 24px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(partnerName.textContent || "Stranger", 242, 285);
    }
  } catch (e) {}

  // Draw Local video on right
  try {
    if (localVideo && localVideo.videoWidth > 0) {
      ctx.save();
      // Mirror local camera
      ctx.translate(865, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(localVideo, 0, 35, 415, 500);
      ctx.restore();
    }
  } catch (e) {}

  // Divider Line
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(450, 35);
  ctx.lineTo(450, 535);
  ctx.stroke();

  // Bottom Polaroid Labels
  ctx.fillStyle = "#111019";
  ctx.font = "bold 28px 'Inter', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("John Mingle ✨", 45, 595);

  ctx.font = "16px 'Inter', sans-serif";
  ctx.fillStyle = "#6b6579";
  const dateStr = new Date().toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit"
  });
  ctx.fillText(`${username} & ${partnerName.textContent} • ${dateStr}`, 45, 635);

  ctx.textAlign = "right";
  ctx.font = "bold 14px 'Inter', sans-serif";
  ctx.fillStyle = "#8b5cf6";
  ctx.fillText("WEBRTC HD CHAT", 855, 635);

  const dataUrl = canvas.toDataURL("image/png");
  if (snapshotPreviewImg) snapshotPreviewImg.src = dataUrl;
  if (downloadSnapshotBtn) downloadSnapshotBtn.href = dataUrl;

  openModal("snapshotModal");
  playSound("reaction");
}

if (snapshotBtn) snapshotBtn.onclick = capturePolaroid;

// ==========================================================================
// 14. MODAL HELPERS & KEYBOARD SHORTCUTS
// ==========================================================================
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add("open");
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove("open");
}
window.closeModal = closeModal;

const shortcutsBtn = document.getElementById("shortcutsBtn");
if (shortcutsBtn) {
  shortcutsBtn.onclick = () => openModal("shortcutsModal");
}

// Close modals when clicking backdrop
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.remove("open");
    }
  });
});

// Global Keyboard Shortcuts
window.addEventListener("keydown", (e) => {
  // If typing in input or textarea, don't trigger hotkeys except Escape
  const isTypingField = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);

  if (e.key === "Escape") {
    // Close open modals first if any
    const openModals = document.querySelectorAll(".modal-overlay.open");
    if (openModals.length > 0) {
      openModals.forEach(m => m.classList.remove("open"));
      return;
    }
    doNext();
    return;
  }

  if (isTypingField) return;

  if (e.key.toLowerCase() === "m") {
    document.getElementById("mic")?.click();
  } else if (e.key.toLowerCase() === "v") {
    document.getElementById("camera")?.click();
  } else if (e.key.toLowerCase() === "s") {
    toggleScreenShare();
  } else if (e.key === "?") {
    openModal("shortcutsModal");
  } else if (["1", "2", "3", "4", "5", "6"].includes(e.key)) {
    const emojis = ["❤️", "🔥", "😂", "🎉", "🚀", "🤯"];
    const idx = parseInt(e.key, 10) - 1;
    if (emojis[idx]) sendReaction(emojis[idx]);
  }
});

// ==========================================================================
// 15. STARTUP
// ==========================================================================
showFinding();
shuffleTopic();
startCamera().then(connect);

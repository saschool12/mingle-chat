const token = localStorage.getItem("token");
const username = localStorage.getItem("username");

if (!token) {
    location.href = "/";
}

const API_URL =
    localStorage.getItem("API_URL") || "";

const SERVER_URL =
    API_URL ||
    location.origin;

document.getElementById("username").textContent = username;

const status = document.getElementById("status");
const partnerName = document.getElementById("partnerName");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const messages = document.getElementById("messages");
const videoCard = document.querySelector(".video-card");
const videoPlaceholder = document.querySelector(".video-placeholder");

let socket = null;
let localStream = null;
let peer = null;
let matched = false;

const rtcConfig = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};

function setStatus(text) {
    status.textContent = text;
}

function showFinding() {
    if (videoCard) {
        videoCard.classList.remove("connected");
    }

    if (videoPlaceholder) {
        videoPlaceholder.style.display = "";
    }
}

function hideFinding() {
    if (videoCard) {
        videoCard.classList.add("connected");
    }

    if (videoPlaceholder) {
        videoPlaceholder.style.display = "none";
    }
}

function send(data) {
    if (
        socket &&
        socket.readyState === WebSocket.OPEN
    ) {
        socket.send(JSON.stringify(data));
    }
}

function addMessage(name, text) {
    const div = document.createElement("div");
    div.className = "message";

    const strong = document.createElement("strong");
    strong.textContent = name + ": ";

    const span = document.createElement("span");
    span.textContent = text;

    div.appendChild(strong);
    div.appendChild(span);

    messages.appendChild(div);

    messages.scrollTop = messages.scrollHeight;
}

/* CAMERA */

async function startCamera() {
    try {
        localStream =
            await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });

        localVideo.srcObject = localStream;

    } catch (error) {
        console.error(error);

        alert(
            "Camera and microphone permission is required."
        );
    }
}

/* WEBRTC */

async function createPeer() {
    if (peer) return;

    peer = new RTCPeerConnection(rtcConfig);

    if (localStream) {
        localStream.getTracks().forEach(track => {
            peer.addTrack(track, localStream);
        });
    }

    peer.ontrack = event => {
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];

            /* Stranger video is now actually connected */
            hideFinding();

            remoteVideo.play().catch(() => {});
        }
    };

    peer.onicecandidate = event => {
        if (event.candidate) {
            send({
                type: "signal",
                signal: {
                    candidate: event.candidate
                }
            });
        }
    };

    peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
            hideFinding();
            setStatus("Connected");
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
        signal: {
            description: peer.localDescription
        }
    });
}

async function handleSignal(signal) {
    await createPeer();

    if (signal.description) {
        await peer.setRemoteDescription(
            new RTCSessionDescription(
                signal.description
            )
        );

        if (signal.description.type === "offer") {
            const answer = await peer.createAnswer();

            await peer.setLocalDescription(answer);

            send({
                type: "signal",
                signal: {
                    description: peer.localDescription
                }
            });
        }
    }

    if (signal.candidate) {
        try {
            await peer.addIceCandidate(
                new RTCIceCandidate(
                    signal.candidate
                )
            );
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

    /* Show finding overlay again */
    showFinding();
}

/* WEBSOCKET */

function connect() {
    const protocol =
        SERVER_URL.startsWith("https")
            ? "wss"
            : "ws";

    const host =
        SERVER_URL
            .replace(/^https?:\/\//, "")
            .replace(/\/$/, "");

    socket = new WebSocket(
        `${protocol}://${host}?token=${encodeURIComponent(token)}`
    );

    socket.onopen = () => {
        showFinding();

        setStatus("Finding someone...");

        send({
            type: "find"
        });
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
        const data = JSON.parse(event.data);

        /* WAITING */

        if (data.type === "waiting") {
            matched = false;

            showFinding();

            setStatus("Waiting for someone...");

            return;
        }

        /* MATCHED */

        if (data.type === "matched") {
            matched = true;

            partnerName.textContent =
                data.partner;

            setStatus("Connected");

            messages.innerHTML = "";

            if (data.initiator) {
                await makeOffer();
            }

            return;
        }

        /* CHAT */

        if (data.type === "chat") {
            addMessage(
                data.username,
                data.message
            );

            return;
        }

        /* WEBRTC SIGNAL */

        if (data.type === "signal") {
            await handleSignal(data.signal);

            return;
        }

        /* PARTNER LEFT */

        if (data.type === "partner_left") {
            matched = false;

            closePeer();

            partnerName.textContent = "Stranger";

            setStatus("Finding another...");

            send({
                type: "find"
            });

            return;
        }

        /* REPORT */

        if (data.type === "reported") {
            alert("Report submitted.");
        }
    };
}

/* CHAT */

document.getElementById(
    "messageForm"
).onsubmit = event => {
    event.preventDefault();

    const input =
        document.getElementById("message");

    const text =
        input.value.trim();

    if (!text || !matched) return;

    addMessage("You", text);

    send({
        type: "chat",
        message: text
    });

    input.value = "";
};

/* NEXT */

document.getElementById(
    "next"
).onclick = () => {
    closePeer();

    matched = false;

    messages.innerHTML = "";

    partnerName.textContent = "Stranger";

    showFinding();

    setStatus("Finding someone...");

    send({
        type: "next"
    });
};

/* CAMERA BUTTON */

document.getElementById(
    "camera"
).onclick = () => {
    if (!localStream) return;

    const track =
        localStream.getVideoTracks()[0];

    track.enabled = !track.enabled;

    document.getElementById(
        "camera"
    ).textContent =
        track.enabled
            ? "📷"
            : "🚫";
};

/* MICROPHONE BUTTON */

document.getElementById(
    "mic"
).onclick = () => {
    if (!localStream) return;

    const track =
        localStream.getAudioTracks()[0];

    track.enabled = !track.enabled;

    document.getElementById(
        "mic"
    ).textContent =
        track.enabled
            ? "🎤"
            : "🔇";
};

/* REPORT */

document.getElementById(
    "report"
).onclick = () => {
    if (!matched) {
        alert("You aren't connected.");
        return;
    }

    if (confirm("Report this person?")) {
        send({
            type: "report"
        });
    }
};

/* LOGOUT */

document.getElementById(
    "logout"
).onclick = () => {
    if (socket) {
        socket.close();
    }

    localStorage.removeItem("token");
    localStorage.removeItem("username");

    location.href = "/";
};

/* START */

showFinding();

startCamera().then(connect);

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PRODUCTION";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const dataDir = path.join(__dirname, "data");
const usersFile = path.join(dataDir, "users.json");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, "[]");
}

function getUsers() {
    return JSON.parse(fs.readFileSync(usersFile, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

/* =========================
   SIGN UP
========================= */

app.post("/api/signup", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        if (username.length < 3 || username.length > 20) {
            return res.status(400).json({
                error: "Username must be 3-20 characters."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Password must be at least 6 characters."
            });
        }

        const users = getUsers();

        const exists = users.some(
            user => user.username.toLowerCase() === username.toLowerCase()
        );

        if (exists) {
            return res.status(409).json({
                error: "Username already exists."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        users.push({
            username,
            password: passwordHash,
            createdAt: Date.now()
        });

        saveUsers(users);

        const token = jwt.sign(
            { username },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            success: true,
            token,
            username
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Server error."
        });
    }
});

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        const users = getUsers();

        const user = users.find(
            user => user.username.toLowerCase() === username.toLowerCase()
        );

        if (!user) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        const valid = await bcrypt.compare(
            password,
            user.password
        );

        if (!valid) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        const token = jwt.sign(
            { username: user.username },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            success: true,
            token,
            username: user.username
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Server error."
        });
    }
});

/* =========================
   WEBSOCKET
========================= */

const waiting = [];
const clients = new Set();

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function removeWaiting(ws) {
    const index = waiting.indexOf(ws);

    if (index !== -1) {
        waiting.splice(index, 1);
    }
}

function leavePartner(ws) {
    const partner = ws.partner;

    if (!partner) return;

    ws.partner = null;
    partner.partner = null;

    send(partner, {
        type: "partner_left"
    });
}

function findPartner(ws) {
    removeWaiting(ws);

    while (waiting.length > 0) {
        const other = waiting.shift();

        if (
            other !== ws &&
            other.readyState === WebSocket.OPEN &&
            !other.partner
        ) {
            ws.partner = other;
            other.partner = ws;

            send(ws, {
                type: "matched",
                partner: other.username,
                initiator: true
            });

            send(other, {
                type: "matched",
                partner: ws.username,
                initiator: false
            });

            console.log(
                `${ws.username} matched with ${other.username}`
            );

            return;
        }
    }

    waiting.push(ws);

    send(ws, {
        type: "waiting"
    });
}

wss.on("connection", (ws, req) => {

    try {
        const url = new URL(
            req.url,
            "http://localhost"
        );

        const token = url.searchParams.get("token");

        if (!token) {
            ws.close();
            return;
        }

        const decoded = jwt.verify(
            token,
            JWT_SECRET
        );

        ws.username = decoded.username;
        ws.partner = null;

        clients.add(ws);

        send(ws, {
            type: "connected",
            username: ws.username
        });

    } catch (error) {
        console.log("WebSocket authentication failed.");
        ws.close();
        return;
    }

    ws.on("message", raw => {

        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }

        /* FIND */

        if (data.type === "find") {
            leavePartner(ws);
            findPartner(ws);
            return;
        }

        /* NEXT */

        if (data.type === "next") {
            leavePartner(ws);
            findPartner(ws);
            return;
        }

        /* CHAT */

        if (data.type === "chat") {

            if (!ws.partner) return;

            const message = String(
                data.message || ""
            ).slice(0, 1000);

            if (!message.trim()) return;

            send(ws.partner, {
                type: "chat",
                username: ws.username,
                message
            });

            return;
        }

        /* WEBRTC SIGNAL */

        if (data.type === "signal") {

            if (!ws.partner) return;

            send(ws.partner, {
                type: "signal",
                signal: data.signal
            });

            return;
        }

        /* REPORT */

        if (data.type === "report") {

            console.log(
                `REPORT: ${ws.username} reported ${ws.partner?.username || "unknown"}`
            );

            send(ws, {
                type: "reported"
            });

            return;
        }
    });

    ws.on("close", () => {

        removeWaiting(ws);
        leavePartner(ws);

        clients.delete(ws);

        console.log(
            `${ws.username} disconnected`
        );
    });
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", (req, res) => {
    res.json({
        online: true,
        users: clients.size
    });
});

server.listen(PORT, () => {
    console.log("");
    console.log("================================");
    console.log(" MINGLE SERVER");
    console.log("================================");
    console.log(`Running on port ${PORT}`);
    console.log("");
});

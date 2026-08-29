const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error("ERROR: JWT_SECRET is missing.");
    process.exit(1);
}

if (!process.env.SUPABASE_URL) {
    console.error("ERROR: SUPABASE_URL is missing.");
    process.exit(1);
}

if (!process.env.SUPABASE_SECRET_KEY) {
    console.error("ERROR: SUPABASE_SECRET_KEY is missing.");
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   SIGN UP
========================= */

app.post("/api/signup", async (req, res) => {
    try {
        const username =
            String(req.body.username || "").trim();

        const password =
            String(req.body.password || "");

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

        const { data: existing, error: findError } =
            await supabase
                .from("users")
                .select("id")
                .ilike("username", username)
                .maybeSingle();

        if (findError) {
            console.error(findError);

            return res.status(500).json({
                error: "Database error."
            });
        }

        if (existing) {
            return res.status(409).json({
                error: "Username already exists."
            });
        }

        const passwordHash =
            await bcrypt.hash(password, 12);

        const { error: insertError } =
            await supabase
                .from("users")
                .insert({
                    username: username,
                    password_hash: passwordHash
                });

       if (insertError) {
    console.error("SUPABASE INSERT ERROR:", insertError);

    return res.status(500).json({
        error: insertError.message
    });
}

        const token =
            jwt.sign(
                { username },
                JWT_SECRET,
                { expiresIn: "7d" }
            );

        return res.json({
            success: true,
            token,
            username
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Server error."
        });
    }
});

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {
    try {
        const username =
            String(req.body.username || "").trim();

        const password =
            String(req.body.password || "");

        const { data: user, error } =
            await supabase
                .from("users")
                .select("username,password_hash")
                .ilike("username", username)
                .maybeSingle();

        if (error) {
            console.error(error);

            return res.status(500).json({
                error: "Database error."
            });
        }

        if (!user) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        const valid =
            await bcrypt.compare(
                password,
                user.password_hash
            );

        if (!valid) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        const token =
            jwt.sign(
                { username: user.username },
                JWT_SECRET,
                { expiresIn: "7d" }
            );

        return res.json({
            success: true,
            token,
            username: user.username
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
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
    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {
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

        const url =
            new URL(
                req.url,
                "http://localhost"
            );

        const token =
            url.searchParams.get("token");

        if (!token) {
            ws.close();
            return;
        }

        const decoded =
            jwt.verify(
                token,
                JWT_SECRET
            );

        ws.username =
            decoded.username;

        ws.partner = null;

        clients.add(ws);

        send(ws, {
            type: "connected",
            username: ws.username
        });

    } catch (error) {

        console.log(
            "WebSocket authentication failed."
        );

        ws.close();

        return;
    }

    ws.on("message", raw => {

        let data;

        try {
            data =
                JSON.parse(
                    raw.toString()
                );
        } catch {
            return;
        }

        if (data.type === "find") {

            leavePartner(ws);
            findPartner(ws);

            return;
        }

        if (data.type === "next") {

            leavePartner(ws);
            findPartner(ws);

            return;
        }

        if (data.type === "chat") {

            if (!ws.partner) return;

            const message =
                String(
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

        if (data.type === "signal") {

            if (!ws.partner) return;

            send(ws.partner, {
                type: "signal",
                signal: data.signal
            });

            return;
        }

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
   HEALTH
========================= */

app.get("/api/health", (req, res) => {

    res.json({
        online: true,
        users: clients.size
    });
});

/* =========================
   SERVER
========================= */

module.exports = app;

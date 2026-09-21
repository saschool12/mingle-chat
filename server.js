const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

// Automatically load .env file if present
if (typeof process.loadEnvFile === "function") {
    try {
        process.loadEnvFile();
    } catch {}
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
let JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
        console.error("ERROR: JWT_SECRET is missing.");
        process.exit(1);
    } else {
        JWT_SECRET = "mingle_dev_jwt_secret_key_98486e16668960dd63f23f30472a94ec";
        console.warn("⚠️  JWT_SECRET was not provided. Using development secret key.");
    }
}

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY
    );
} else {
    console.warn("⚠️  SUPABASE_URL or SUPABASE_SECRET_KEY is not set.");
    console.warn("   Running in development mode. Set Supabase keys in .env for production database authentication.");
}

const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

function makeVerificationCode() {
    return String(
        crypto.randomInt(100000, 1000000)
    );
}

async function sendVerificationEmail(
    email,
    username,
    code
) {
    if (
        !process.env.SMTP_USER ||
        !process.env.SMTP_PASS
    ) {
        throw new Error(
            "SMTP_USER and SMTP_PASS are required."
        );
    }

    await mailer.sendMail({
        from:
            process.env.SMTP_FROM ||
            `John Mingle <${process.env.SMTP_USER}>`,

        to: email,

        subject:
            "Your John Mingle verification code",

        text:
            `Hi ${username},\n\n` +
            `Your verification code is: ${code}\n\n` +
            `This code expires in 10 minutes.`,

        html: `
            <div style="
                font-family:Arial;
                max-width:520px;
                margin:auto;
                padding:30px
            ">
                <h2>
                    Welcome to John Mingle 👋
                </h2>

                <p>
                    Your verification code is:
                </p>

                <div style="
                    font-size:32px;
                    font-weight:bold;
                    letter-spacing:8px;
                    padding:20px 0
                ">
                    ${code}
                </div>

                <p>
                    This code expires in
                    <b>10 minutes</b>.
                </p>

                <p>
                    If you did not create this
                    account, ignore this email.
                </p>
            </div>
        `
    });
}

app.use(cors());

app.use(express.json());

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

/* =========================
   SIGN UP
========================= */

app.post("/api/signup", async (req, res) => {
    try {
        const username =
            String(
                req.body.username || ""
            ).trim();

        const email =
            String(
                req.body.email || ""
            ).trim().toLowerCase();

        const password =
            String(
                req.body.password || ""
            );

        if (
            username.length < 3 ||
            username.length > 20
        ) {
            return res.status(400).json({
                error:
                    "Username must be 3-20 characters."
            });
        }

        if (
            !/^[^\s@]+@gmail\.com$/i.test(
                email
            )
        ) {
            return res.status(400).json({
                error:
                    "Please use a valid Gmail address."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error:
                    "Password must be at least 6 characters."
            });
        }

        if (!supabase) {
            const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
            return res.json({ token, username, success: true });
        }

        const {
            data: existingUsername,
            error: usernameError
        } = await supabase
            .from("users")
            .select("id")
            .ilike("username", username)
            .maybeSingle();

        if (usernameError) {
            console.error(usernameError);

            return res.status(500).json({
                error: "Database error."
            });
        }

        if (existingUsername) {
            return res.status(409).json({
                error:
                    "Username already exists."
            });
        }

        const {
            data: existingEmail,
            error: emailError
        } = await supabase
            .from("users")
            .select(
                "id,email,email_verified"
            )
            .ilike("email", email)
            .maybeSingle();

        if (emailError) {
            console.error(emailError);

            return res.status(500).json({
                error: "Database error."
            });
        }

        if (existingEmail) {
            return res.status(409).json({
                error:
                    existingEmail.email_verified
                        ? "That Gmail is already registered."
                        : "That Gmail is registered but not verified."
            });
        }

        const passwordHash =
            await bcrypt.hash(
                password,
                12
            );

        const code =
            makeVerificationCode();

        const expires =
            new Date(
                Date.now() +
                10 * 60 * 1000
            ).toISOString();

        const {
            data: createdUser,
            error: insertError
        } = await supabase
            .from("users")
            .insert({
                username,
                email,
                password_hash:
                    passwordHash,
                email_verified:
                    false,
                verification_code:
                    code,
                verification_expires:
                    expires
            })
            .select(
                "id,username,email"
            )
            .single();

        if (insertError) {
            console.error(
                "SUPABASE INSERT ERROR:",
                insertError
            );

            return res.status(500).json({
                error:
                    insertError.message
            });
        }

        try {
            await sendVerificationEmail(
                email,
                username,
                code
            );
        } catch (mailError) {
            console.error(
                "EMAIL ERROR:",
                mailError
            );

            await supabase
                .from("users")
                .delete()
                .eq(
                    "id",
                    createdUser.id
                );

            return res.status(500).json({
                error:
                    "Could not send verification email.",
                details:
                    mailError?.message || String(mailError)
            });
        }

        return res.json({
            success: true,
            requiresVerification: true,
            email
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Server error."
        });
    }
});

/* =========================
   VERIFY EMAIL
========================= */

app.post(
    "/api/verify-email",
    async (req, res) => {
        try {
            const email =
                String(
                    req.body.email || ""
                )
                .trim()
                .toLowerCase();

            const code =
                String(
                    req.body.code || ""
                ).trim();

            if (
                !email ||
                !/^\d{6}$/.test(code)
            ) {
                return res.status(400).json({
                    error:
                        "Enter the 6-digit verification code."
                });
            }

            const {
                data: user,
                error
            } = await supabase
                .from("users")
                .select(
                    "id,username,email,verification_code,verification_expires,email_verified"
                )
                .ilike(
                    "email",
                    email
                )
                .maybeSingle();

            if (error) {
                console.error(error);

                return res.status(500).json({
                    error:
                        "Database error."
                });
            }

            if (!user) {
                return res.status(404).json({
                    error:
                        "Account not found."
                });
            }

            if (user.email_verified) {
                return res.status(400).json({
                    error:
                        "Email is already verified."
                });
            }

            if (
                user.verification_code !==
                code
            ) {
                return res.status(400).json({
                    error:
                        "Incorrect verification code."
                });
            }

            if (
                !user.verification_expires ||
                new Date(
                    user.verification_expires
                ).getTime() < Date.now()
            ) {
                return res.status(400).json({
                    error:
                        "Code expired. Request a new one."
                });
            }

            const {
                error: updateError
            } = await supabase
                .from("users")
                .update({
                    email_verified:
                        true,
                    verification_code:
                        null,
                    verification_expires:
                        null
                })
                .eq(
                    "id",
                    user.id
                );

            if (updateError) {
                console.error(
                    updateError
                );

                return res.status(500).json({
                    error:
                        "Could not verify email."
                });
            }

            const token =
                jwt.sign(
                    {
                        username:
                            user.username
                    },
                    JWT_SECRET,
                    {
                        expiresIn:
                            "7d"
                    }
                );

            return res.json({
                success: true,
                token,
                username:
                    user.username
            });

        } catch (error) {
            console.error(error);

            return res.status(500).json({
                error:
                    "Server error."
            });
        }
    }
);

/* =========================
   RESEND CODE
========================= */

app.post(
    "/api/resend-verification",
    async (req, res) => {
        try {
            const email =
                String(
                    req.body.email || ""
                )
                .trim()
                .toLowerCase();

            if (!email) {
                return res.status(400).json({
                    error:
                        "Enter your Gmail address."
                });
            }

            const {
                data: user,
                error
            } = await supabase
                .from("users")
                .select(
                    "id,username,email,email_verified"
                )
                .ilike(
                    "email",
                    email
                )
                .maybeSingle();

            if (error) {
                console.error(error);

                return res.status(500).json({
                    error:
                        "Database error."
                });
            }

            if (!user) {
                return res.status(404).json({
                    error:
                        "No account found."
                });
            }

            if (user.email_verified) {
                return res.status(400).json({
                    error:
                        "Email already verified."
                });
            }

            const code =
                makeVerificationCode();

            const expires =
                new Date(
                    Date.now() +
                    10 * 60 * 1000
                ).toISOString();

            const {
                error: updateError
            } = await supabase
                .from("users")
                .update({
                    verification_code:
                        code,
                    verification_expires:
                        expires
                })
                .eq(
                    "id",
                    user.id
                );

            if (updateError) {
                console.error(
                    updateError
                );

                return res.status(500).json({
                    error:
                        "Could not create code."
                });
            }

            await sendVerificationEmail(
                user.email,
                user.username,
                code
            );

            return res.json({
                success: true,
                message:
                    "New verification code sent."
            });

        } catch (error) {
            console.error(error);

            return res.status(500).json({
                error:
                    "Could not send email."
            });
        }
    }
);

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {
    try {
        const username =
            String(
                req.body.username || ""
            ).trim();

        const password =
            String(
                req.body.password || ""
            );

        if (!supabase) {
            const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
            return res.json({ token, username });
        }

        const {
            data: user,
            error
        } = await supabase
            .from("users")
            .select(
                "username,email,password_hash,email_verified"
            )
            .ilike(
                "username",
                username
            )
            .maybeSingle();

        if (error) {
            console.error(error);

            return res.status(500).json({
                error:
                    "Database error."
            });
        }

        if (!user) {
            return res.status(401).json({
                error:
                    "Invalid username or password."
            });
        }

        const valid =
            await bcrypt.compare(
                password,
                user.password_hash
            );

        if (!valid) {
            return res.status(401).json({
                error:
                    "Invalid username or password."
            });
        }

        if (!user.email_verified) {
            return res.status(403).json({
                error:
                    "Please verify your Gmail first.",
                requiresVerification:
                    true,
                email:
                    user.email
            });
        }

        const token =
            jwt.sign(
                {
                    username:
                        user.username
                },
                JWT_SECRET,
                {
                    expiresIn:
                        "7d"
                }
            );

        return res.json({
            success: true,
            token,
            username:
                user.username
        });

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error:
                "Server error."
        });
    }
});

/* =========================
   WEBSOCKET
========================= */

const waiting = [];
const clients = new Set();

function broadcastOnlineCount() {
    const count = clients.size;
    for (const client of clients) {
        send(client, {
            type: "online_count",
            count
        });
    }
}

function send(ws, data) {
    if (
        ws &&
        ws.readyState ===
        WebSocket.OPEN
    ) {
        ws.send(
            JSON.stringify(data)
        );
    }
}

function removeWaiting(ws) {
    const index =
        waiting.indexOf(ws);

    if (index !== -1) {
        waiting.splice(
            index,
            1
        );
    }
}

function leavePartner(ws) {
    const partner =
        ws.partner;

    if (!partner) return;

    ws.partner = null;
    partner.partner = null;

    send(partner, {
        type:
            "partner_left"
    });
}

function findPartner(ws) {
    removeWaiting(ws);

    while (
        waiting.length > 0
    ) {
        const other =
            waiting.shift();

        if (
            other !== ws &&
            other.readyState ===
                WebSocket.OPEN &&
            !other.partner
        ) {
            ws.partner =
                other;

            other.partner =
                ws;

            send(ws, {
                type:
                    "matched",

                partner:
                    other.username,

                initiator:
                    true
            });

            send(other, {
                type:
                    "matched",

                partner:
                    ws.username,

                initiator:
                    false
            });

            console.log(
                `${ws.username} matched with ${other.username}`
            );

            return;
        }
    }

    waiting.push(ws);

    send(ws, {
        type:
            "waiting"
    });
}

wss.on(
    "connection",
    (ws, req) => {
        try {
            const url =
                new URL(
                    req.url,
                    "http://localhost"
                );

            const token =
                url.searchParams.get(
                    "token"
                );

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
                type:
                    "connected",

                username:
                    ws.username
            });

            broadcastOnlineCount();

        } catch (error) {
            console.log(
                "WebSocket authentication failed."
            );

            ws.close();

            return;
        }

        ws.on(
            "message",
            raw => {
                let data;

                try {
                    data =
                        JSON.parse(
                            raw.toString()
                        );
                } catch {
                    return;
                }

                if (
                    data.type ===
                    "find"
                ) {
                    leavePartner(
                        ws
                    );

                    findPartner(
                        ws
                    );

                    return;
                }

                if (
                    data.type ===
                    "next"
                ) {
                    leavePartner(
                        ws
                    );

                    findPartner(
                        ws
                    );

                    return;
                }

                if (
                    data.type ===
                    "chat"
                ) {
                    if (
                        !ws.partner
                    ) return;

                    const message =
                        String(
                            data.message ||
                            ""
                        ).slice(
                            0,
                            1000
                        );

                    if (
                        !message.trim()
                    ) return;

                    send(
                        ws.partner,
                        {
                            type:
                                "chat",

                            username:
                                ws.username,

                            message
                        }
                    );

                    return;
                }

                if (
                    data.type ===
                    "signal"
                ) {
                    if (
                        !ws.partner
                    ) return;

                    send(
                        ws.partner,
                        {
                            type:
                                "signal",

                            signal:
                                data.signal
                        }
                    );

                    return;
                }

                if (
                    data.type ===
                    "reaction"
                ) {
                    if (!ws.partner) return;

                    send(ws.partner, {
                        type: "reaction",
                        emoji: String(data.emoji || "🔥").slice(0, 10),
                        username: ws.username
                    });

                    return;
                }

                if (
                    data.type ===
                    "typing"
                ) {
                    if (!ws.partner) return;

                    send(ws.partner, {
                        type: "typing",
                        isTyping: Boolean(data.isTyping),
                        username: ws.username
                    });

                    return;
                }

                if (
                    data.type ===
                    "report"
                ) {
                    console.log(
                        `REPORT: ${ws.username} reported ${ws.partner?.username || "unknown"}`
                    );

                    send(ws, {
                        type:
                            "reported"
                    });

                    return;
                }
            }
        );

        ws.on(
            "close",
            () => {
                removeWaiting(
                    ws
                );

                leavePartner(
                    ws
                );

                clients.delete(
                    ws
                );

                broadcastOnlineCount();

                console.log(
                    `${ws.username} disconnected`
                );
            }
        );
    }
);

/* =========================
   HEALTH
========================= */

app.get(
    "/api/health",
    (req, res) => {
        res.json({
            online:
                true,

            users:
                clients.size
        });
    }
);

/* =========================
   SERVER
========================= */

server.listen(
    PORT,
    () => {
        console.log("");
        console.log(
            "================================"
        );
        console.log(
            " MINGLE SERVER"
        );
        console.log(
            "================================"
        );
        console.log(
            `Running on port ${PORT}`
        );
        console.log("");
    }
);

const fs = require("fs");
const path = require("path");

function loadEnvironmentFile() {
  // Optional local config file. Use this for machine-specific settings such as
  // MySQL credentials, Gmail OTP credentials, and SESSION_SECRET.
  const envCandidates = [
    path.join(__dirname, "3fa-ewallet.env"),
    path.join(__dirname, ".env"),
  ];

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    return envPath;
  }

  return null;
}

const loadedEnvironmentFile = loadEnvironmentFile();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const db = require("./db");
let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch (error) {
  nodemailer = null;
}

// ===========================
// APP / DATABASE SETUP
// ===========================
const app = express();
const dbPromise = db.promise();
const transactionTableCache = { value: undefined };
const linkedCardColumnsCache = { value: undefined };
const balanceSeedMigrationMarker = path.join(__dirname, ".seed-balance-reset.done");
let otpMailer = null;

if (loadedEnvironmentFile) {
  console.log("Loaded environment from " + path.basename(loadedEnvironmentFile));
}


// ===========================
// MIDDLEWARE
// ===========================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// ===========================
// SESSION CONFIG
// ===========================
app.use(
  session({
    // Change SESSION_SECRET in 3fa-ewallet.env or .env when running on another machine.
    secret: process.env.SESSION_SECRET || "3fa-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 1000 * 60 * 30,
    },
  }),
);

// ===========================
// AUTH CHECK
// ===========================
function isAuth(req, res, next) {
  if (!req.session.authenticated) {
    if (req.get("X-Requested-With") === "XMLHttpRequest") {
      return res.status(401).json({ message: "Unauthorized" });
    }
    return res.redirect("/login.html");
  }
  next();
}

// ===========================
// OTP GENERATION
// ===========================
function generateOTP(req, email, options = {}) {
  const now = Date.now();
  const forceNew = options.forceNew === true;
  const recentOtpExists =
    !forceNew &&
    req.session.user === email &&
    req.session.otp &&
    req.session.otpExpiry > now &&
    req.session.otpIssuedAt &&
    now - req.session.otpIssuedAt < 5000 &&
    req.session.otpDeliveryFailed !== true;

  if (recentOtpExists) {
    req.session.otpResendCooldown = now + 30 * 1000;
    return { otp: req.session.otp, reused: true };
  }

  const otp = Math.floor(100000 + Math.random() * 900000);

  req.session.otp = otp;
  req.session.otpExpiry = now + 2 * 60 * 1000;
  req.session.otpAttempts = 0;
  req.session.user = email;
  req.session.otpIssuedAt = now;
  req.session.otpResendCooldown = now + 30 * 1000;
  req.session.otpDeliveryFailed = false;

  return { otp, reused: false };
}

//function isOtpMailConfigured() {
// Gmail OTP sending needs OTP_EMAIL_USER and OTP_EMAIL_APP_PASSWORD.
// If these are not set, the app still works in demo mode by printing OTP in the terminal.
//return Boolean(process.env.OTP_EMAIL_USER && process.env.OTP_EMAIL_APP_PASSWORD);
//}

function isOtpMailConfigured() {
  // Demo mode: disable Gmail OTP and print OTP in the terminal.
  return false;
}

function getOtpMailer() {
  if (!nodemailer || !isOtpMailConfigured()) {
    return null;
  }

  if (!otpMailer) {
    otpMailer = nodemailer.createTransport({
      service: "gmail",
      auth: {
        // Use a Gmail App Password here, not the normal Gmail login password.
        user: process.env.OTP_EMAIL_USER,
        pass: process.env.OTP_EMAIL_APP_PASSWORD,
      },
    });
  }

  return otpMailer;
}

async function sendOtpEmail(email, otp) {
  const transporter = getOtpMailer();
  if (!transporter) {
    return {
      sent: false,
      reason: nodemailer ? "not_configured" : "missing_dependency",
    };
  }

  const fromAddress = process.env.OTP_EMAIL_FROM || process.env.OTP_EMAIL_USER;
  const otpString = String(otp);

  await transporter.sendMail({
    from: `"FortiWallet" <${fromAddress}>`,
    to: email,
    subject: "Your FortiWallet OTP Code",
    text: `Your FortiWallet OTP is ${otpString}. It expires in 2 minutes.`,
    html: `
      <div style="font-family: Inter, Arial, sans-serif; padding: 24px; background: #f5f8ff; color: #16203a;">
        <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 18px; padding: 28px; border: 1px solid #d8e2f5;">
          <div style="font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #2b67b3; font-weight: 700; margin-bottom: 12px;">FortiWallet</div>
          <h2 style="margin: 0 0 12px; font-size: 28px; color: #16203a;">Your OTP Code</h2>
          <p style="margin: 0 0 18px; font-size: 15px; line-height: 1.6; color: #51617f;">Use this code to continue signing in to your wallet.</p>
          <div style="font-size: 34px; letter-spacing: 0.28em; font-weight: 800; color: #1c5fab; padding: 18px 20px; background: #eef5ff; border-radius: 14px; text-align: center;">${otpString}</div>
          <p style="margin: 18px 0 0; font-size: 13px; color: #6f7f9f;">This OTP expires in 2 minutes.</p>
        </div>
      </div>
    `,
  });

  return { sent: true };
}

async function sendTopupOtpEmail(email, otp, amount, bankName, maskedCard) {
  const transporter = getOtpMailer();
  if (!transporter) {
    return {
      sent: false,
      reason: nodemailer ? "not_configured" : "missing_dependency",
    };
  }

  const fromAddress = process.env.OTP_EMAIL_FROM || process.env.OTP_EMAIL_USER;
  const otpString = String(otp);

  await transporter.sendMail({
    from: `"FortiWallet" <${fromAddress}>`,
    to: email,
    subject: "Your FortiWallet Top Up OTP",
    text: `Your top up OTP is ${otpString}. Use it to approve RM ${Number(amount || 0).toFixed(2)} from ${bankName} ${maskedCard}. It expires in 2 minutes.`,
    html: `
      <div style="font-family: Inter, Arial, sans-serif; padding: 24px; background: #f5f8ff; color: #16203a;">
        <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 18px; padding: 28px; border: 1px solid #d8e2f5;">
          <div style="font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #2b67b3; font-weight: 700; margin-bottom: 12px;">FortiWallet Top Up</div>
          <h2 style="margin: 0 0 12px; font-size: 28px; color: #16203a;">Approve your top up</h2>
          <p style="margin: 0 0 10px; font-size: 15px; line-height: 1.6; color: #51617f;">Use this OTP to approve RM ${Number(amount || 0).toFixed(2)} from ${bankName} ${maskedCard}.</p>
          <div style="font-size: 34px; letter-spacing: 0.28em; font-weight: 800; color: #1c5fab; padding: 18px 20px; background: #eef5ff; border-radius: 14px; text-align: center;">${otpString}</div>
          <p style="margin: 18px 0 0; font-size: 13px; color: #6f7f9f;">This OTP expires in 2 minutes.</p>
        </div>
      </div>
    `,
  });

  return { sent: true };
}

async function sendPasswordResetOtpEmail(email, otp) {
  const transporter = getOtpMailer();
  if (!transporter) {
    return {
      sent: false,
      reason: nodemailer ? "not_configured" : "missing_dependency",
    };
  }

  const fromAddress = process.env.OTP_EMAIL_FROM || process.env.OTP_EMAIL_USER;
  const otpString = String(otp);

  await transporter.sendMail({
    from: `"FortiWallet" <${fromAddress}>`,
    to: email,
    subject: "Your FortiWallet Password Reset OTP",
    text: `Your password reset OTP is ${otpString}. It expires in 2 minutes.`,
    html: `
      <div style="font-family: Inter, Arial, sans-serif; padding: 24px; background: #f5f8ff; color: #16203a;">
        <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 18px; padding: 28px; border: 1px solid #d8e2f5;">
          <div style="font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #2b67b3; font-weight: 700; margin-bottom: 12px;">FortiWallet</div>
          <h2 style="margin: 0 0 12px; font-size: 28px; color: #16203a;">Reset your password</h2>
          <p style="margin: 0 0 18px; font-size: 15px; line-height: 1.6; color: #51617f;">Use this OTP to continue setting a new wallet password.</p>
          <div style="font-size: 34px; letter-spacing: 0.28em; font-weight: 800; color: #1c5fab; padding: 18px 20px; background: #eef5ff; border-radius: 14px; text-align: center;">${otpString}</div>
          <p style="margin: 18px 0 0; font-size: 13px; color: #6f7f9f;">This OTP expires in 2 minutes.</p>
        </div>
      </div>
    `,
  });

  return { sent: true };
}

// ===========================
// HELPER: SQL SAFE IDENTIFIER
// ===========================
function escapeIdentifier(identifier) {
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

// ===========================
// HELPER: GET USER BY EMAIL
// ===========================
async function getUserByEmail(email) {
  const [rows] = await dbPromise.query("SELECT * FROM user WHERE email = ?", [email]);
  return rows[0] || null;
}

// ===========================
// HELPER: FAVOURITE RECIPIENTS
// ===========================
async function ensureFavouriteRecipientsTable() {
  await dbPromise.query(`
    CREATE TABLE IF NOT EXISTS favourite_recipients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      owner_email VARCHAR(255) NOT NULL,
      recipient_email VARCHAR(255) NOT NULL,
      nickname VARCHAR(50) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_favourite_recipient (owner_email, recipient_email)
    )
  `);

  const requiredColumns = [
    ["owner_email", "VARCHAR(255) NOT NULL"],
    ["recipient_email", "VARCHAR(255) NOT NULL"],
    ["nickname", "VARCHAR(50) NULL"],
    ["created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"],
  ];

  for (const [columnName, definition] of requiredColumns) {
    const [columns] = await dbPromise.query("SHOW COLUMNS FROM favourite_recipients LIKE ?", [columnName]);
    if (columns.length === 0) {
      await dbPromise.query(`ALTER TABLE favourite_recipients ADD COLUMN ${escapeIdentifier(columnName)} ${definition}`);
    }
  }
}

// ===========================
// HELPER: LINKED CARD SUPPORT
// ===========================
async function ensureLinkedCardColumns() {
  if (linkedCardColumnsCache.value !== undefined) {
    return linkedCardColumnsCache.value;
  }

  try {
    const [bankColumn] = await dbPromise.query("SHOW COLUMNS FROM user LIKE 'linked_card_bank'");
    const [numberColumn] = await dbPromise.query("SHOW COLUMNS FROM user LIKE 'linked_card_number'");
    const [validThruColumn] = await dbPromise.query("SHOW COLUMNS FROM user LIKE 'linked_card_valid_thru'");

    if (bankColumn.length === 0) {
      await dbPromise.query("ALTER TABLE user ADD COLUMN linked_card_bank VARCHAR(50) NULL");
    }

    if (numberColumn.length === 0) {
      await dbPromise.query("ALTER TABLE user ADD COLUMN linked_card_number VARCHAR(16) NULL");
    } else if (!String(numberColumn[0].Type || "").includes("varchar(16)")) {
      await dbPromise.query("ALTER TABLE user MODIFY COLUMN linked_card_number VARCHAR(16) NULL");
    }

    if (validThruColumn.length === 0) {
      await dbPromise.query("ALTER TABLE user ADD COLUMN linked_card_valid_thru VARCHAR(5) NULL");
    } else if (!String(validThruColumn[0].Type || "").includes("varchar(5)")) {
      await dbPromise.query("ALTER TABLE user MODIFY COLUMN linked_card_valid_thru VARCHAR(5) NULL");
    }

    linkedCardColumnsCache.value = true;
    return true;
  } catch (error) {
    console.error("Linked card schema error:", error.message);
    linkedCardColumnsCache.value = false;
    return false;
  }
}

function normalizeCardNumber(cardNumber) {
  return String(cardNumber || "").replace(/\D/g, "");
}

function isLikelyRealCardNumber(cardNumber) {
  const normalized = normalizeCardNumber(cardNumber);
  if (!/^\d{16}$/.test(normalized)) {
    return false;
  }

  if (/^(\d)\1{15}$/.test(normalized)) {
    return false;
  }

  if (
    normalized === "1234567890123456" ||
    normalized === "0123456789012345" ||
    normalized === "9876543210987654"
  ) {
    return false;
  }

  const fourBlocks = normalized.match(/.{1,4}/g) || [];
  if (
    fourBlocks.length === 4 &&
    fourBlocks.every((block) => /^(\d)\1{3}$/.test(block))
  ) {
    const digits = fourBlocks.map((block) => Number(block[0]));
    const isAscending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] + 1);
    const isDescending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] - 1);
    if (isAscending || isDescending) {
      return false;
    }
  }

  return true;
}

function isValidFutureCardDate(validThru) {
  const value = String(validThru || "");
  const match = value.match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
  if (!match) {
    return false;
  }

  const month = Number(match[1]);
  const year = Number(`20${match[2]}`);
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  if (year < currentYear) return false;
  if (year === currentYear && month < currentMonth) return false;
  if (year > currentYear + 12) return false;

  return true;
}

function maskLinkedCard(cardNumber) {
  const last4 = normalizeCardNumber(cardNumber).slice(-4).padStart(4, "0");
  return `xxxx xxxx xxxx ${last4}`;
}

async function getLinkedCardByEmail(email) {
  const schemaReady = await ensureLinkedCardColumns();
  if (!schemaReady) {
    return null;
  }

  const user = await getUserByEmail(email);
  if (!user || !user.linked_card_bank || !user.linked_card_number) {
    return null;
  }

  const cardNumber = normalizeCardNumber(user.linked_card_number);
  if (cardNumber.length !== 16) {
    return null;
  }

  return {
    bankName: user.linked_card_bank,
    cardNumber,
    maskedCard: maskLinkedCard(cardNumber),
    validThru: user.linked_card_valid_thru || "MM/YY",
  };
}

async function saveLinkedCard(email, bankName, cardNumber, validThru) {
  const schemaReady = await ensureLinkedCardColumns();
  if (!schemaReady) {
    throw new Error("Linked card storage unavailable");
  }

  await dbPromise.query(
    "UPDATE user SET linked_card_bank = ?, linked_card_number = ?, linked_card_valid_thru = ? WHERE email = ?",
    [bankName, normalizeCardNumber(cardNumber), validThru, email],
  );
}

async function normalizeSeedBalancesOnce() {
  if (fs.existsSync(balanceSeedMigrationMarker)) {
    return;
  }

  try {
    await dbPromise.query("UPDATE user SET balance = GREATEST(balance - 1000, 0)");
    fs.writeFileSync(balanceSeedMigrationMarker, new Date().toISOString(), "utf8");
  } catch (error) {
    console.error("Seed balance normalization error:", error.message);
  }
}

// ===========================
// HELPER: FIND TRANSACTION TABLE
// ===========================
async function resolveTransactionTable() {
  if (transactionTableCache.value !== undefined) {
    return transactionTableCache.value;
  }

  try {
    const [tables] = await dbPromise.query("SHOW TABLES");
    const tableNames = tables
      .map((row) => Object.values(row)[0])
      .filter((name) => /transaction|history/i.test(String(name)));

    for (const tableName of tableNames) {
      try {
        const [columns] = await dbPromise.query(`DESCRIBE ${escapeIdentifier(tableName)}`);
        const columnNames = columns.map((column) => String(column.Field).toLowerCase());

        const sender = columnNames.find((name) =>
          ["sender", "sender_email", "from_email", "from_user"].includes(name),
        );
        const receiver = columnNames.find((name) =>
          ["receiver", "receiver_email", "recipient", "to_email", "to_user"].includes(name),
        );
        const amount = columnNames.find((name) =>
          ["amount", "transfer_amount", "value"].includes(name),
        );
        const timestamp = columnNames.find((name) =>
          ["timestamp", "created_at", "transaction_time", "createdon", "date"].includes(name),
        );

        if (sender && receiver && amount && timestamp) {
          transactionTableCache.value = {
            tableName,
            sender,
            receiver,
            amount,
            timestamp,
          };
          return transactionTableCache.value;
        }
      } catch (error) {
        console.error(`Failed to inspect transaction table ${tableName}:`, error.message);
      }
    }
  } catch (error) {
    console.error("Failed to discover transaction table:", error.message);
  }

  transactionTableCache.value = null;
  return null;
}

// ===========================
// HELPER: GET TRANSACTION HISTORY
// ===========================
async function fetchTransactions(email) {
  const config = await resolveTransactionTable();
  if (!config) {
    return [];
  }

  const query = `
    SELECT
      ${escapeIdentifier(config.sender)} AS sender,
      ${escapeIdentifier(config.receiver)} AS receiver,
      ${escapeIdentifier(config.amount)} AS amount,
      ${escapeIdentifier(config.timestamp)} AS timestamp
    FROM ${escapeIdentifier(config.tableName)}
    WHERE ${escapeIdentifier(config.sender)} = ? OR ${escapeIdentifier(config.receiver)} = ?
    ORDER BY ${escapeIdentifier(config.timestamp)} DESC
  `;

  const [rows] = await dbPromise.query(query, [email, email]);
  return rows;
}

// ===========================
// HELPER: INSERT TRANSACTION RECORD
// ===========================
async function insertTransactionRecord(connection, senderEmail, receiverEmail, amount) {
  const config = await resolveTransactionTable();
  if (!config) {
    return;
  }

  const query = `
    INSERT INTO ${escapeIdentifier(config.tableName)}
      (${escapeIdentifier(config.sender)}, ${escapeIdentifier(config.receiver)}, ${escapeIdentifier(config.amount)}, ${escapeIdentifier(config.timestamp)})
    VALUES (?, ?, ?, NOW())
  `;

  await connection.query(query, [senderEmail, receiverEmail, amount]);
}

// ===========================
// HELPER: MOCK BANK LIST
// ===========================
function getMockBanks() {
  return [
    "Maybank",
    "CIMB Bank",
    "Public Bank",
    "RHB Bank",
    "Hong Leong Bank",
    "Bank Islam",
  ];
}

// ===========================
// DEFAULT ROUTE
// ===========================
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// ===========================
// PUBLIC PAGES
// ===========================
app.get("/login.html", (req, res) => {
  res.sendFile(__dirname + "/views/login.html");
});

app.get("/register.html", (req, res) => {
  res.sendFile(__dirname + "/views/register.html");
});

app.get("/otp.html", (req, res) => {
  res.sendFile(__dirname + "/views/otp.html");
});

app.get("/forgot-password.html", (req, res) => {
  res.sendFile(__dirname + "/views/forgot-password.html");
});

app.get("/reset-password.html", (req, res) => {
  res.sendFile(__dirname + "/views/reset-password.html");
});

app.get("/forgot-pin.html", (req, res) => {
  res.sendFile(__dirname + "/views/forgot-pin.html");
});

// ===========================
// REGISTER
// ===========================
function isValidEmailFormat(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) return false;

  const domain = normalized.split("@")[1];
  if (!domain || domain.includes("..")) return false;

  const allowedTlds = new Set([
    "com",
    "net",
    "org",
    "edu",
    "gov",
    "my",
    "com.my",
    "edu.my",
    "gov.my",
    "net.my",
    "org.my",
    "ac.my",
  ]);
  const parts = domain.split(".");
  const last = parts.at(-1);
  const lastTwo = parts.slice(-2).join(".");

  return allowedTlds.has(last) || allowedTlds.has(lastTwo);
}

app.post("/register", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const { password, pin } = req.body;

  if (!isValidEmailFormat(email)) {
    return res.json({ success: false, message: "Enter a valid email address, for example name@gmail.com." });
  }

  if (!/^\d{6}$/.test(pin)) {
    return res.json({ success: false, message: "PIN must be 6 digits" });
  }

  if (!password) {
    return res.json({ success: false, message: "Password is required" });
  }

  try {
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.json({ success: false, message: "This email is already registered." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const hashedPin = await bcrypt.hash(pin, 10);

    await dbPromise.query(
      "INSERT INTO user (email, password, pin, balance) VALUES (?, ?, ?, ?)",
      [email, hashedPassword, hashedPin, 0],
    );

    res.json({
      success: true,
      message: "Registration successful",
      redirect: "/login.html",
    });
  } catch (error) {
    console.error("Register error:", error.message);
    res.json({ success: false, message: "Register error" });
  }
});

// ===========================
// LOGIN
// ===========================
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await getUserByEmail(email);
    if (!user) {
      return res.json({ success: false, message: "This email has not been registered." });
    }

    const match = await bcrypt.compare(String(password || "").trim(), user.password);
    if (!match) {
      return res.json({ success: false, message: "Invalid password." });
    }

    const otpResult = generateOTP(req, email);
    const otp = otpResult.otp;
    let message = otpResult.reused ? "OTP already sent. Check your Gmail inbox." : "OTP sent";

    if (!otpResult.reused) {
      try {
        const mailResult = await sendOtpEmail(email, otp);
        if (!mailResult.sent) {
          req.session.otpDeliveryFailed = true;
          console.log("OTP (demo fallback):", otp);
          message =
            mailResult.reason === "missing_dependency"
              ? "OTP generated. Email package not installed yet."
              : "OTP generated. Gmail delivery is not configured yet.";
        }
      } catch (mailError) {
        req.session.otpDeliveryFailed = true;
        console.error("OTP email error:", mailError.message);
        message = "OTP generated. Email delivery failed, so use the demo OTP for now.";
      }
    }

    res.json({
      success: true,
      message,
      redirect: "/otp.html",
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.json({ success: false, message: "Database error" });
  }
});

// ===========================
// RESEND OTP
// ===========================
app.post("/resend-otp", async (req, res) => {
  if (!req.session.user) {
    return res.send("No active OTP session");
  }

  if (Date.now() < (req.session.otpResendCooldown || 0)) {
    return res.send("Please wait before requesting OTP again");
  }

  const { otp } = generateOTP(req, req.session.user, { forceNew: true });

  try {
    const mailResult = await sendOtpEmail(req.session.user, otp);
    if (!mailResult.sent) {
      console.log("OTP (demo fallback):", otp);
      return res.send("OTP regenerated. Gmail delivery is not configured yet");
    }
  } catch (mailError) {
    console.error("Resend OTP email error:", mailError.message);
    console.log("OTP (demo fallback):", otp);
    return res.send("OTP regenerated. Email delivery failed");
  }

  res.send("OTP resent");
});

// ===========================
// VERIFY OTP
// ===========================
app.post("/verify-otp", (req, res) => {
  const { otp } = req.body;

  if (!req.session.otp) {
    return res.redirect("/otp.html?error=No OTP session");
  }

  if (Date.now() > req.session.otpExpiry) {
    return res.redirect("/otp.html?error=OTP expired");
  }

  req.session.otpAttempts = (req.session.otpAttempts || 0) + 1;

  if (req.session.otpAttempts > 3) {
    req.session.otp = null;
    return res.redirect("/otp.html?error=Too many attempts");
  }

  if (String(otp) === String(req.session.otp)) {
    req.session.authenticated = true;
    req.session.otp = null;
    req.session.otpAttempts = 0;
    req.session.otpIssuedAt = null;
    req.session.otpResendCooldown = null;
    req.session.otpDeliveryFailed = false;
    return res.redirect("/dashboard");
  }

  return res.redirect("/otp.html?error=Invalid OTP");
});

// ===========================
// DASHBOARD PAGE
// ===========================
app.get("/dashboard", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/dashboard.html");
});

app.get("/history.html", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/history.html");
});

app.get("/editprofile.html", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/editprofile.html");
});

app.get("/linkedcard.html", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/linkedcard.html");
});

app.get("/linked-card.html", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/linkedcard.html");
});

app.get("/transfer.html", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/transfer.html");
});

app.get("/pin.html", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/pin.html");
});

// ===========================
// TOP UP PAGE
// ===========================
app.get("/topup.html", isAuth, (req, res) => {
  res.sendFile(__dirname + "/views/topup.html");
});

// ===========================
// DASHBOARD BALANCE API
// ===========================
app.get("/dashboard-balance", isAuth, async (req, res) => {
  try {
    const user = await getUserByEmail(req.session.user);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ balance: Number(user.balance || 0) });
  } catch (error) {
    console.error("Dashboard balance error:", error.message);
    res.status(500).json({ message: "Unable to load balance" });
  }
});

// ===========================
// CURRENT USER API (/me)
// ===========================
app.get("/me", isAuth, (req, res) => {
  res.json({ email: req.session.user });
});

app.get("/user-exists", isAuth, async (req, res) => {
  const email = String(req.query.email || "").trim();
  if (!email) {
    return res.json({ exists: false });
  }

  try {
    const user = await getUserByEmail(email);
    res.json({ exists: Boolean(user) });
  } catch (error) {
    console.error("User exists lookup error:", error.message);
    res.status(500).json({ exists: false });
  }
});

app.get("/favourite-recipients", isAuth, async (req, res) => {
  try {
    await ensureFavouriteRecipientsTable();
    const [rows] = await dbPromise.query(
      `SELECT recipient_email AS email, COALESCE(nickname, '') AS remark
       FROM favourite_recipients
       WHERE owner_email = ?
       ORDER BY id DESC`,
      [req.session.user],
    );
    res.json(rows);
  } catch (error) {
    console.error("Favourite recipients load error:", error.message);
    res.status(500).json({ success: false, message: "Unable to load favourite recipients" });
  }
});

app.post("/favourite-recipients", isAuth, async (req, res) => {
  const ownerEmail = req.session.user;
  const recipientEmail = String(req.body.recipientEmail || "").trim().toLowerCase();
  const nickname = String(req.body.nickname || "").trim().slice(0, 50);

  if (!isValidEmailFormat(recipientEmail)) {
    return res.json({ success: false, message: "Enter a valid recipient email address." });
  }

  if (recipientEmail === ownerEmail) {
    return res.json({ success: false, message: "You cannot save your own email here" });
  }

  try {
    await ensureFavouriteRecipientsTable();
    const recipient = await getUserByEmail(recipientEmail);
    if (!recipient) {
      return res.json({ success: false, message: "Recipient not found" });
    }

    const [existingRows] = await dbPromise.query(
      "SELECT id FROM favourite_recipients WHERE owner_email = ? AND recipient_email = ? LIMIT 1",
      [ownerEmail, recipientEmail],
    );

    if (existingRows.length) {
      await dbPromise.query(
        "UPDATE favourite_recipients SET nickname = ? WHERE id = ?",
        [nickname || null, existingRows[0].id],
      );
    } else {
      await dbPromise.query(
        "INSERT INTO favourite_recipients (owner_email, recipient_email, nickname) VALUES (?, ?, ?)",
        [ownerEmail, recipientEmail, nickname || null],
      );
    }

    res.json({ success: true, message: "Favourite account saved" });
  } catch (error) {
    console.error("Favourite recipients save error:", error.message);
    res.status(500).json({ success: false, message: "Unable to save favourite recipient" });
  }
});

app.put("/favourite-recipients", isAuth, async (req, res) => {
  const recipientEmail = String(req.body.recipientEmail || "").trim().toLowerCase();
  const nickname = String(req.body.nickname || "").trim().slice(0, 50);

  try {
    await ensureFavouriteRecipientsTable();
    const [result] = await dbPromise.query(
      "UPDATE favourite_recipients SET nickname = ? WHERE owner_email = ? AND recipient_email = ?",
      [nickname || null, req.session.user, recipientEmail],
    );

    if (result.affectedRows === 0) {
      return res.json({ success: false, message: "Favourite recipient not found" });
    }

    res.json({ success: true, message: "Nickname updated" });
  } catch (error) {
    console.error("Favourite recipients update error:", error.message);
    res.status(500).json({ success: false, message: "Unable to update nickname" });
  }
});

app.delete("/favourite-recipients", isAuth, async (req, res) => {
  const recipientEmail = String(req.body.recipientEmail || "").trim().toLowerCase();

  try {
    await ensureFavouriteRecipientsTable();
    const [result] = await dbPromise.query(
      "DELETE FROM favourite_recipients WHERE owner_email = ? AND recipient_email = ?",
      [req.session.user, recipientEmail],
    );

    if (result.affectedRows === 0) {
      return res.json({ success: false, message: "Favourite recipient not found" });
    }

    res.json({ success: true, message: "Favourite recipient deleted" });
  } catch (error) {
    console.error("Favourite recipients delete error:", error.message);
    res.status(500).json({ success: false, message: "Unable to delete favourite recipient" });
  }
});

app.get("/linked-card", isAuth, async (req, res) => {
  try {
    const linkedCard = await getLinkedCardByEmail(req.session.user);
    res.json({ linkedCard });
  } catch (error) {
    console.error("Linked card fetch error:", error.message);
    res.status(500).json({ linkedCard: null });
  }
});

// ===========================
// TRANSACTION HISTORY API
// ===========================
app.get("/transactions", isAuth, async (req, res) => {
  try {
    const rows = await fetchTransactions(req.session.user);
    res.json(rows);
  } catch (error) {
    console.error("Transactions error:", error.message);
    res.status(500).json([]);
  }
});

// ===========================
// VERIFY PIN
// ===========================
app.post("/verify-pin", isAuth, async (req, res) => {
  const { pin } = req.body;

  if (!/^\d{6}$/.test(pin)) {
    return res.json({ success: false, message: "Invalid PIN" });
  }

  req.session.pinAttempts = req.session.pinAttempts || 0;

  try {
    const user = await getUserByEmail(req.session.user);
    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    const match = await bcrypt.compare(pin, user.pin);
    if (!match) {
      req.session.pinAttempts += 1;

      if (req.session.pinAttempts >= 3) {
        return res.json({
          success: false,
          message: "Too many attempts",
          forgot: true,
        });
      }

      return res.json({ success: false, message: "Incorrect PIN" });
    }

    req.session.pinAttempts = 0;
    res.json({
      success: true,
      message: "PIN verified",
      redirect: "/dashboard",
    });
  } catch (error) {
    console.error("Verify PIN error:", error.message);
    res.json({ success: false, message: "Unable to verify PIN" });
  }
});

// ===========================
// CHANGE PIN
// ===========================
app.post("/change-pin", isAuth, async (req, res) => {
  const { newPin, confirmPin } = req.body;

  if (!/^\d{6}$/.test(newPin || "")) {
    return res.json({ success: false, message: "Invalid PIN" });
  }

  if (confirmPin && newPin !== confirmPin) {
    return res.json({ success: false, message: "PIN does not match" });
  }

  try {
    const hashedPin = await bcrypt.hash(newPin, 10);
    await dbPromise.query("UPDATE user SET pin = ? WHERE email = ?", [hashedPin, req.session.user]);
    res.json({ success: true, message: "PIN updated" });
  } catch (error) {
    console.error("Change PIN error:", error.message);
    res.json({ success: false, message: "Unable to update PIN" });
  }
});

// ===========================
// LINK BANK CARD
// ===========================
app.post("/linked-card", isAuth, async (req, res) => {
  const { bankName, cardNumber, validThru } = req.body;
  const normalizedCard = normalizeCardNumber(cardNumber);

  if (!getMockBanks().includes(bankName)) {
    return res.json({ success: false, message: "Please select a valid bank" });
  }

  if (!/^\d{16}$/.test(normalizedCard)) {
    return res.json({ success: false, message: "Card number must be 16 digits" });
  }

  if (!isLikelyRealCardNumber(normalizedCard)) {
    return res.json({ success: false, message: "Please enter a valid bank card number" });
  }

  if (!isValidFutureCardDate(validThru)) {
    return res.json({ success: false, message: "Please enter a valid future card date" });
  }

  try {
    await saveLinkedCard(req.session.user, bankName, normalizedCard, validThru);
    res.json({
      success: true,
      message: "Bank card linked successfully",
      linkedCard: {
        bankName,
        maskedCard: maskLinkedCard(normalizedCard),
        validThru,
      },
    });
  } catch (error) {
    console.error("Linked card save error:", error.message);
    res.json({ success: false, message: "Unable to save bank card" });
  }
});

// ===========================
// FORGOT PASSWORD
// ===========================
app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    const user = await getUserByEmail(email);
    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    const resetOtp = Math.floor(100000 + Math.random() * 900000);
    req.session.resetEmail = email;
    req.session.resetPasswordOtp = String(resetOtp);
    req.session.resetPasswordOtpExpiry = Date.now() + 2 * 60 * 1000;
    req.session.resetPasswordOtpAttempts = 0;

    const mailResult = await sendPasswordResetOtpEmail(email, resetOtp);
    if (!mailResult.sent) {
      console.log("Password reset OTP (demo fallback):", resetOtp);
    }

    res.json({
      success: true,
      message: mailResult.sent
        ? "OTP sent to your Gmail."
        : "OTP generated. Gmail delivery is not configured yet.",
      redirect: "/reset-password.html",
    });
  } catch (error) {
    console.error("Forgot password error:", error.message);
    res.json({ success: false, message: "Unable to start password reset" });
  }
});

// ===========================
// RESET PASSWORD
// ===========================
app.post("/reset-password", async (req, res) => {
  const { newPassword, confirmPassword, otp } = req.body;
  const targetEmail = req.session.authenticated ? req.session.user : req.session.resetEmail;

  if (!targetEmail) {
    return res.json({ success: false, message: "Reset session expired" });
  }

  if (!newPassword || newPassword.length < 1) {
    return res.json({ success: false, message: "Password is required" });
  }

  if (confirmPassword && newPassword !== confirmPassword) {
    return res.json({ success: false, message: "Passwords do not match" });
  }

  if (!req.session.authenticated) {
    if (!req.session.resetPasswordOtp) {
      return res.json({ success: false, message: "Reset OTP expired. Start again." });
    }

    if (Date.now() > Number(req.session.resetPasswordOtpExpiry || 0)) {
      return res.json({ success: false, message: "OTP expired" });
    }

    if (!/^\d{6}$/.test(String(otp || ""))) {
      return res.json({ success: false, message: "Invalid OTP" });
    }

    req.session.resetPasswordOtpAttempts = Number(req.session.resetPasswordOtpAttempts || 0) + 1;
    if (req.session.resetPasswordOtpAttempts > 3) {
      req.session.resetPasswordOtp = null;
      return res.json({ success: false, message: "Too many OTP attempts. Start again." });
    }

    if (String(otp) !== String(req.session.resetPasswordOtp)) {
      return res.json({ success: false, message: "Incorrect OTP" });
    }
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await dbPromise.query("UPDATE user SET password = ? WHERE email = ?", [hashedPassword, targetEmail]);

    if (!req.session.authenticated) {
      req.session.resetEmail = null;
      req.session.resetPasswordOtp = null;
      req.session.resetPasswordOtpExpiry = null;
      req.session.resetPasswordOtpAttempts = 0;
    }

    res.json({
      success: true,
      message: "Password updated successfully",
      redirect: req.session.authenticated ? null : "/login.html",
    });
  } catch (error) {
    console.error("Reset password error:", error.message);
    res.json({ success: false, message: "Unable to update password" });
  }
});

// ===========================
// RESET PIN
// ===========================
app.post("/reset-pin", async (req, res) => {
  const { email, newPin, confirmPin } = req.body;

  if (!/^\d{6}$/.test(newPin || "")) {
    return res.json({ success: false, message: "PIN must be 6 digits" });
  }

  if (newPin !== confirmPin) {
    return res.json({ success: false, message: "PIN does not match" });
  }

  try {
    const user = await getUserByEmail(email);
    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    const hashedPin = await bcrypt.hash(newPin, 10);
    await dbPromise.query("UPDATE user SET pin = ? WHERE email = ?", [hashedPin, email]);

    res.json({
      success: true,
      message: "PIN reset successfully",
      redirect: "/login.html",
    });
  } catch (error) {
    console.error("Reset PIN error:", error.message);
    res.json({ success: false, message: "Unable to reset PIN" });
  }
});

// ===========================
// PREPARE TRANSFER
// ===========================
app.post("/prepare-transfer", isAuth, async (req, res) => {
  const { receiverEmail, amount } = req.body;
  const senderEmail = req.session.user;
  const parsedAmount = Number(amount);

  if (senderEmail === receiverEmail) {
    return res.json({ success: false, message: "Cannot transfer to yourself" });
  }

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.json({ success: false, message: "Invalid amount" });
  }

  try {
    const receiver = await getUserByEmail(receiverEmail);
    if (!receiver) {
      return res.json({ success: false, message: "Receiver not found" });
    }

    req.session.transferData = {
      receiverEmail,
      amount: parsedAmount,
    };
    req.session.pinAttempts = 0;

    res.json({ success: true });
  } catch (error) {
    console.error("Prepare transfer error:", error.message);
    res.json({ success: false, message: "Unable to prepare transfer" });
  }
});

// ===========================
// PREPARE TOP UP
// ===========================
app.post("/prepare-topup", isAuth, async (req, res) => {
  const { amount, bankName, cardNumber, useSavedCard } = req.body;
  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.json({ success: false, message: "Invalid amount" });
  }

  try {
    let topupSource = null;

    if (String(useSavedCard || "") === "1") {
      const linkedCard = await getLinkedCardByEmail(req.session.user);
      if (!linkedCard) {
        return res.json({ success: false, message: "Saved card not found" });
      }

      topupSource = {
        bankName: linkedCard.bankName,
        maskedCard: linkedCard.maskedCard,
      };
    } else {
      const normalizedCard = normalizeCardNumber(cardNumber);

      if (!getMockBanks().includes(bankName)) {
        return res.json({ success: false, message: "Please select a valid bank" });
      }

      if (!/^\d{16}$/.test(normalizedCard)) {
        return res.json({ success: false, message: "Card number must be 16 digits" });
      }

      if (!isLikelyRealCardNumber(normalizedCard)) {
        return res.json({ success: false, message: "Please enter a valid bank card number" });
      }

      topupSource = {
        bankName,
        maskedCard: maskLinkedCard(normalizedCard),
      };
    }

    const topupOtp = Math.floor(100000 + Math.random() * 900000);
    req.session.topupData = {
      bankName: topupSource.bankName,
      amount: parsedAmount,
      maskedCard: topupSource.maskedCard,
      otp: String(topupOtp),
      otpExpiry: Date.now() + 2 * 60 * 1000,
      otpAttempts: 0,
      otpResendCooldown: Date.now() + 30 * 1000,
    };

    const mailResult = await sendTopupOtpEmail(
      req.session.user,
      topupOtp,
      parsedAmount,
      topupSource.bankName,
      topupSource.maskedCard,
    );
    if (!mailResult.sent) {
      console.log("Top up OTP (demo fallback):", topupOtp);
    }

    res.json({
      success: true,
      topupSource,
      message: mailResult.sent ? "Top up OTP sent to your Gmail" : "Top up OTP generated. Email delivery unavailable.",
    });
  } catch (error) {
    console.error("Prepare top up error:", error.message);
    res.json({ success: false, message: "Unable to prepare top up" });
  }
});

app.post("/resend-topup-otp", isAuth, async (req, res) => {
  if (!req.session.topupData) {
    return res.json({ success: false, message: "No top up session" });
  }

  if (Date.now() < (req.session.topupData.otpResendCooldown || 0)) {
    return res.json({ success: false, message: "Please wait before requesting another OTP" });
  }

  const nextOtp = Math.floor(100000 + Math.random() * 900000);
  req.session.topupData.otp = String(nextOtp);
  req.session.topupData.otpExpiry = Date.now() + 2 * 60 * 1000;
  req.session.topupData.otpAttempts = 0;
  req.session.topupData.otpResendCooldown = Date.now() + 30 * 1000;

  try {
    const mailResult = await sendTopupOtpEmail(
      req.session.user,
      nextOtp,
      req.session.topupData.amount,
      req.session.topupData.bankName,
      req.session.topupData.maskedCard,
    );
    if (!mailResult.sent) {
      console.log("Top up OTP (demo fallback):", nextOtp);
      return res.json({ success: true, message: "Top up OTP regenerated. Gmail delivery unavailable." });
    }

    res.json({ success: true, message: "Top up OTP resent" });
  } catch (error) {
    console.error("Resend top up OTP error:", error.message);
    console.log("Top up OTP (demo fallback):", nextOtp);
    res.json({ success: false, message: "Unable to resend top up OTP right now" });
  }
});

// ===========================
// CONFIRM TOP UP
// ===========================
app.post("/confirm-topup", isAuth, async (req, res) => {
  const { otp } = req.body;

  if (!req.session.topupData) {
    return res.json({ success: false, message: "No top up session" });
  }

  if (Date.now() > Number(req.session.topupData.otpExpiry || 0)) {
    return res.json({ success: false, message: "OTP expired" });
  }

  if (!/^\d{6}$/.test(String(otp || ""))) {
    return res.json({ success: false, message: "Invalid OTP" });
  }

  req.session.topupData.otpAttempts = Number(req.session.topupData.otpAttempts || 0) + 1;
  if (req.session.topupData.otpAttempts > 3) {
    req.session.topupData = null;
    return res.json({ success: false, message: "Too many attempts. Start the top up again." });
  }

  if (String(otp) !== String(req.session.topupData.otp)) {
    return res.json({ success: false, message: "Incorrect OTP" });
  }

  const { bankName, amount, maskedCard } = req.session.topupData;
  const receiverEmail = req.session.user;
  const bankSource = `${bankName} ${maskedCard}`;

  try {
    await dbPromise.beginTransaction();
    try {
      await dbPromise.query("UPDATE user SET balance = balance + ? WHERE email = ?", [
        amount,
        receiverEmail,
      ]);
      await insertTransactionRecord(dbPromise, bankSource, receiverEmail, amount);
      await dbPromise.commit();
    } catch (error) {
      await dbPromise.rollback();
      throw error;
    }

    req.session.topupData = null;

    res.json({
      success: true,
      message: "Top up successful",
      redirect: "/dashboard",
    });
  } catch (error) {
    console.error("Confirm top up error:", error.message);
    res.json({ success: false, message: "Unable to complete top up" });
  }
});

// ===========================
// CONFIRM TRANSFER
// ===========================
app.post("/confirm-transfer", isAuth, async (req, res) => {
  const { pin } = req.body;

  if (!req.session.transferData) {
    return res.json({ success: false, message: "No transfer session" });
  }

  const { receiverEmail, amount } = req.session.transferData;
  const senderEmail = req.session.user;
  req.session.pinAttempts = req.session.pinAttempts || 0;

  try {
    const sender = await getUserByEmail(senderEmail);
    if (!sender) {
      return res.json({ success: false, message: "Sender not found" });
    }

    if (Number(sender.balance) < Number(amount)) {
      return res.json({ success: false, message: "Insufficient balance" });
    }

    const match = await bcrypt.compare(pin, sender.pin);
    if (!match) {
      req.session.pinAttempts += 1;

      if (req.session.pinAttempts >= 3) {
        return res.json({ success: false, forgot: true, message: "Too many attempts" });
      }

      return res.json({ success: false, message: "Incorrect PIN" });
    }

    req.session.pinAttempts = 0;

    await dbPromise.beginTransaction();
    try {
      await dbPromise.query("UPDATE user SET balance = balance - ? WHERE email = ?", [amount, senderEmail]);
      await dbPromise.query("UPDATE user SET balance = balance + ? WHERE email = ?", [amount, receiverEmail]);
      await insertTransactionRecord(dbPromise, senderEmail, receiverEmail, amount);
      await dbPromise.commit();
    } catch (error) {
      await dbPromise.rollback();
      throw error;
    }

    console.log(`${senderEmail} sent RM${amount} to ${receiverEmail}`);
    req.session.transferData = null;

    res.json({
      success: true,
      message: "Transfer successful",
      redirect: "/dashboard",
    });
  } catch (error) {
    console.error("Confirm transfer error:", error.message);
    res.json({ success: false, message: "Unable to complete transfer" });
  }
});

// ===========================
// LOGOUT
// ===========================
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// ===========================
// START SERVER
// ===========================
normalizeSeedBalancesOnce().finally(() => {
  app.listen(3000, () => {
    console.log("Server running at http://localhost:3000");
  });
});




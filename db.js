const mysql = require("mysql2");

// Database configuration
// Other users can keep these defaults only if their MySQL setup matches:
// host = localhost, user = root, password = 1234, database = fyp_database.
// Otherwise, set DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME in 3fa-ewallet.env or .env.
const db = mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "1234",
  database: process.env.DB_NAME || "fyp_database",
});

db.connect((err) => {
  if (err) {
    console.error("MySQL connection failed:", err.message);
  } else {
    console.log("Connected to MySQL");
  }
});

module.exports = db;

require("dotenv").config(); // Load environment variables
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const AWS = require("aws-sdk");
const { sendMiddlemanEmail } = require("./sendEmail"); // Import email utility

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

// Update CORS configuration
const allowedOrigins = ["http://localhost:3000", "http://localhost:5173"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

// PostgreSQL database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: process.env.DB_PORT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false,
  },
});

// AWS S3 configuration
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

// WebSocket connection
io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("joinRoom", (roomId) => {
    socket.join(roomId);
    console.log(`User joined room: ${roomId}`);
  });

  socket.on("disconnect", () => {
    console.log("A user disconnected");
  });
});

// Save a new message and broadcast it
app.post("/api/sendMessage", async (req, res) => {
  const { requestId, email, message } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const userResult = await pool.query(
      `SELECT email FROM users WHERE email = $1`,
      [email]
    );

    // Allow middleman (admin) to send messages without checking user existence
    if (userResult.rowCount === 0 && email !== "middleman@service.com") {
      return res.status(403).json({ message: "Unauthorized user." });
    }

    let role = "middleman"; // Default role for admin messages

    if (email !== "middleman@service.com") {
      const roleResult = await pool.query(
        `SELECT role FROM confirmation_codes WHERE request_id = $1 AND email = $2`,
        [requestId, email]
      );
      role = roleResult.rowCount > 0 ? roleResult.rows[0].role : "unknown";
    }

    const result = await pool.query(
      `INSERT INTO chat_messages (request_id, email, message, timestamp)
       VALUES ($1, $2, $3, NOW()) RETURNING email, message, timestamp`,
      [requestId, email, message]
    );

    const row = result.rows[0];
    const newMessage = {
      email: row.email,
      text: row.message, // Use 'text' instead of 'message'
      timestamp: row.timestamp,
      role, // Include role in the emitted message
    };

    io.to(requestId).emit("newMessage", newMessage); // Emit to specific room

    res.status(201).json({ message: "Message sent successfully." });
  } catch (error) {
    console.error("Error saving message:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Retrieve messages for a specific request
app.get("/api/getMessages/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const { email } = req.query; // Fetch email from query params

  try {
    const result = await pool.query(
      `SELECT cm.email, 
              COALESCE(cm.message, NULL) AS text, 
              cm.file_url AS "fileUrl", 
              cm.timestamp, 
              cc.role
       FROM chat_messages cm
       LEFT JOIN confirmation_codes cc
       ON CAST(cm.request_id AS VARCHAR) = CAST(cc.request_id AS VARCHAR) AND cm.email = cc.email
       WHERE CAST(cm.request_id AS VARCHAR) = $1
       ORDER BY cm.timestamp ASC`,
      [requestId]
    );

    console.log("Fetched messages:", result.rows); // Log fetched messages

    // Fetch the role of the user (buyer/seller)
    const roleResult = await pool.query(
      `SELECT role FROM confirmation_codes WHERE request_id = $1 AND email = $2`,
      [requestId, email]
    );

    let role = roleResult.rowCount > 0 ? roleResult.rows[0].role : null;

    // Add predefined note based on the role
    const predefinedNote =
      role === "buyer"
        ? {
            email: "system",
            text: "Buyer: Please proceed with the payment. Kindly refrain from sharing any sensitive or personal information in this chat for security reasons.",
            timestamp: null,
            role: "system",
          }
        : role === "seller"
        ? {
            email: "system",
            text: "Seller: Please wait until the buyer has completed the payment. Once payment is confirmed, you may proceed to send the required file or transaction proof. Acceptable formats include PDF, JPEG, JPG, and PNG.",
            timestamp: null,
            role: "system",
          }
        : null;

    const messages = predefinedNote ? [predefinedNote, ...result.rows] : result.rows;

    res.status(200).json(messages);
  } catch (error) {
    console.error("Error retrieving messages:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Retrieve all chats for admin
app.get("/api/getAllChats", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT request_id AS "requestId",
              MAX(CASE WHEN role = 'buyer' THEN email END) AS "buyerEmail",
              MAX(CASE WHEN role = 'seller' THEN email END) AS "sellerEmail"
       FROM confirmation_codes
       GROUP BY request_id`
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error retrieving chats:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Get user role for a specific request
app.get("/api/getUserRole/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const { email } = req.query;

  try {
    const result = await pool.query(
      `SELECT role FROM confirmation_codes WHERE request_id = $1 AND email = $2`,
      [requestId, email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Role not found." });
    }

    res.status(200).json({ role: result.rows[0].role });
  } catch (error) {
    console.error("Error fetching user role:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// File upload endpoint
app.post("/api/uploadFiles", upload.array("files"), async (req, res) => {
  const { requestId, email } = req.body;
  const files = req.files;

  console.log("Request received:", { requestId, email, files }); // Log request details

  if (!files || !requestId || !email) {
    console.error("Missing required fields:", { requestId, email, files });
    return res.status(400).json({ message: "Missing required fields." });
  }

  try {
    for (const file of files) {
      console.log("Uploading file to S3:", file.originalname); // Log file details

      const s3Key = `chat_uploads/${requestId}/${Date.now()}-${file.originalname}`;
      const params = {
        Bucket: "middleman-uploads",
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      };

      const s3Result = await s3.upload(params).promise();
      console.log("File uploaded to S3:", s3Result.Location); // Log S3 URL

      const dbResult = await pool.query(
        `INSERT INTO chat_messages (request_id, email, file_url, timestamp)
         VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [requestId, email, s3Result.Location]
      );
      console.log("File URL saved to database:", dbResult.rows[0]); // Log database save

      // Emit to chat
      io.to(requestId).emit("newMessage", {
        email,
        fileUrl: s3Result.Location,
        timestamp: new Date(),
        role: "seller",
      });
    }

    res.status(201).json({ message: "Files uploaded successfully." });
  } catch (error) {
    console.error("Error uploading to S3 or saving to database:", error);
    res.status(500).json({ message: "Upload failed", error: error.message });
  }
});

// Fetch the other party's details based on request ID and role
app.get("/api/getUserDetails/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const { role } = req.query;

  if (!role || !["buyer", "seller"].includes(role)) {
    return res.status(400).json({ message: "Invalid role provided." });
  }

  try {
    const result = await pool.query(
      `SELECT u.first_name AS "firstName", u.last_name AS "lastName", u.profile_photo AS "profilePhoto",
              EXTRACT(YEAR FROM u.created_at) AS "registeredYear"
       FROM users u
       INNER JOIN confirmation_codes cc ON u.email = cc.email
       WHERE cc.request_id = $1 AND cc.role = $2`,
      [requestId, role]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User details not found." });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching user details:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// New endpoint to fetch the count of unread messages for each middleman request
app.get("/api/getUnreadMessageCount", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const result = await pool.query(
      `SELECT request_id AS "requestId", COUNT(*) AS "unreadCount"
       FROM chat_messages
       WHERE email != $1 AND request_id IN (
         SELECT id FROM middleman_services WHERE email = $1 OR counterparty_email = $1
       )
       AND is_read = FALSE
       GROUP BY request_id`,
      [email]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching unread message count:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// New endpoint to validate access based on requestId and email
app.get("/api/validateAccess/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const result = await pool.query(
      `SELECT email FROM confirmation_codes WHERE request_id = $1
       UNION
       SELECT 'support@legitprove.com' AS email`,
      [requestId]
    );

    const allowedEmails = result.rows.map((row) => row.email);

    if (allowedEmails.includes(email)) {
      return res.status(200).json({ isAuthorized: true });
    } else {
      return res.status(403).json({ isAuthorized: false });
    }
  } catch (error) {
    console.error("Error validating access:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// New endpoint to check if there are file messages in the chat
app.get("/api/hasFileMessages/:requestId", async (req, res) => {
  const { requestId } = req.params;

  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS fileCount
       FROM chat_messages
       WHERE request_id = $1 AND file_url IS NOT NULL`,
      [requestId]
    );

    const hasFiles = parseInt(result.rows[0].fileCount, 10) > 0;
    res.status(200).json({ hasFiles });
  } catch (error) {
    console.error("Error checking for file messages:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Endpoint to handle user reports
app.post("/api/reportUser", async (req, res) => {
  const { reason, remarks, requestId } = req.body;
  const { email } = req.query; // Fetch the reporting user's email from query params

  if (!reason || !remarks || !requestId || !email) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    // Fetch the reported user's email based on the requestId and reporting user's role
    const result = await pool.query(
      `SELECT 
         CASE 
           WHEN email = $1 THEN counterparty_email
           WHEN counterparty_email = $1 THEN email
           ELSE NULL
         END AS reportedEmail
       FROM middleman_services
       WHERE id = $2`,
      [email, requestId]
    );

    if (result.rows.length === 0 || !result.rows[0].reportedemail) {
      return res.status(404).json({ message: "Reported user not found." });
    }

    const reportedEmail = result.rows[0].reportedemail;

    // Insert the report into the database
    const reportResult = await pool.query(
      `INSERT INTO user_reports (reported_email, reason, remarks, request_id, timestamp, submitted_by)
       VALUES ($1, $2, $3, $4, NOW(), $5) RETURNING *`,
      [reportedEmail, reason, remarks, requestId, email]
    );

    res.status(201).json({ message: "Report submitted successfully.", report: reportResult.rows[0] });
  } catch (error) {
    console.error("Error submitting report:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// New endpoint to fetch user reports based on the logged-in user's email
app.get("/api/getUserReports", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const result = await pool.query(
      `SELECT ur.id, 
              ur.reason, 
              ur.remarks, 
              ur.timestamp, 
              ur.status, -- Include the status column
              ru.first_name AS "reportedFirstName", 
              ru.last_name AS "reportedLastName", 
              su.first_name AS "submittedFirstName", 
              su.last_name AS "submittedLastName"
       FROM user_reports ur
       LEFT JOIN users ru ON ur.reported_email = ru.email
       LEFT JOIN users su ON ur.submitted_by = su.email
       WHERE ur.reported_email = $1 OR ur.submitted_by = $1
       ORDER BY ur.timestamp DESC`,
      [email]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching user reports:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// New endpoint to fetch all reports for the admin panel
app.get("/api/getAllUserReports", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ur.id, 
              ur.reason, 
              ur.remarks, 
              ur.timestamp, 
              ur.status, 
              ru.first_name AS "reportedFirstName", 
              ru.last_name AS "reportedLastName", 
              su.first_name AS "submittedFirstName", 
              su.last_name AS "submittedLastName"
       FROM user_reports ur
       LEFT JOIN users ru ON ur.reported_email = ru.email
       LEFT JOIN users su ON ur.submitted_by = su.email
       ORDER BY ur.timestamp DESC`
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching all user reports:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Endpoint to update report status and send emails
app.post("/api/updateReportStatus", async (req, res) => {
  const { reportId, newStatus, emailContent } = req.body;

  if (!reportId || !newStatus || !emailContent) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    // Fetch report details
    const reportResult = await pool.query(
      `SELECT ur.reported_email, ur.submitted_by, 
              ru.first_name AS "reportedFirstName", ru.last_name AS "reportedLastName", 
              su.first_name AS "submittedFirstName", su.last_name AS "submittedLastName"
       FROM user_reports ur
       LEFT JOIN users ru ON ur.reported_email = ru.email
       LEFT JOIN users su ON ur.submitted_by = su.email
       WHERE ur.id = $1`,
      [reportId]
    );

    if (reportResult.rows.length === 0) {
      return res.status(404).json({ message: "Report not found." });
    }

    const report = reportResult.rows[0];

    // Update report status
    await pool.query(
      `UPDATE user_reports SET status = $1 WHERE id = $2`,
      [newStatus, reportId]
    );

    // Send emails to both parties
    const reportedEmail = report.reported_email;
    const submittedEmail = report.submitted_by;

    await sendMiddlemanEmail(
      reportedEmail,
      "Reported User",
      "Report Status Update",
      "",
      "",
      "",
      emailContent
    );

    await sendMiddlemanEmail(
      submittedEmail,
      "Reporting User",
      "Report Status Update",
      "",
      "",
      "",
      emailContent
    );

    res.status(200).json({ message: "Report status updated and emails sent successfully." });
  } catch (error) {
    console.error("Error updating report status:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

const PORT = 5020;
server.listen(PORT, () => {
  console.log(`🚀 Chat server running on http://localhost:${PORT}`);
});

require("dotenv").config(); // Load environment variables from .env file

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const AWS = require("aws-sdk");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { sendSignupEmail, sendMiddlemanEmail, sendResetPasswordEmail } = require("./sendEmail");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = 5001;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
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

// Multer file upload config
const storage = multer.memoryStorage();
const upload = multer({ storage });

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET;

// OpenAI API Configuration
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// Utility functions
const uploadToS3 = async (file) => {
  const fileName = `profilePhotos/${Date.now()}_${file.originalname}`;
  const params = {
    Bucket: "user-profile-pic-legitprove",
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: "public-read",
    CacheControl: "max-age=31536000", // Cache for 1 year
  };

  const data = await s3.upload(params).promise();
  return data.Location;
};

const uploadImageUrlToS3 = async (imageUrl, originalName = "ai-generated.jpg") => {
  const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const fileBuffer = Buffer.from(response.data, "binary");
  const file = {
    originalname: originalName,
    mimetype: "image/jpeg",
    buffer: fileBuffer,
  };

  return await uploadToS3(file);
};

// Routes from signup.js
app.post("/api/signup", upload.single("profilePhoto"), async (req, res) => {
  try {
    const { email, password, username } = req.body;

    // Validate request body
    if (!email || !password || !username) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Check if the user already exists
    const existingUser = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: "User with this email already exists" });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create the user in the database
    const newUser = await pool.query(
      `INSERT INTO users (email, password, username) VALUES ($1, $2, $3) RETURNING id`,
      [email, hashedPassword, username]
    );

    // Send verification email
    const verificationToken = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO email_verifications (user_id, token) VALUES ($1, $2)`,
      [newUser.rows[0].id, verificationToken]
    );
    const verificationLink = `${req.protocol}://${req.get("host")}/api/verify-email?token=${verificationToken}`;
    await sendSignupEmail(email, verificationLink);

    res.status(201).json({ success: true, userId: newUser.rows[0].id });
  } catch (error) {
    console.error("Error during signup:", error);
    res.status(500).json({ error: "Server error during signup" });
  }
});

app.post("/api/verify-email", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "Token is required" });
  }

  try {
    // Verify the token and get the associated user
    const result = await pool.query(
      `SELECT user_id FROM email_verifications WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const userId = result.rows[0].user_id;

    // Update the user's email verified status
    await pool.query(
      `UPDATE users SET email_verified = true WHERE id = $1`,
      [userId]
    );

    // Delete the used token
    await pool.query(
      `DELETE FROM email_verifications WHERE token = $1`,
      [token]
    );

    res.status(200).json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    console.error("Error verifying email:", error);
    res.status(500).json({ error: "Server error during email verification" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  console.log("Login request received:", { email }); // Debug log

  if (!email || !password) {
    console.error("Missing email or password in request body");
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    // Check if the user exists
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    console.log("User query result:", userResult.rows); // Debug log

    if (userResult.rows.length === 0) {
      console.error("User not found for email:", email);
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = userResult.rows[0];

    // Check if the password matches
    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log("Password validation result:", isPasswordValid); // Debug log

    if (!isPasswordValid) {
      console.error("Invalid password for email:", email);
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Generate a JWT token
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "1d" });
    console.log("JWT generated successfully for user ID:", user.id); // Debug log

    res.status(200).json({ success: true, token, user: { id: user.id, email: user.email, username: user.username } });
  } catch (error) {
    console.error("Error during login:", error); // Debug log
    res.status(500).json({ error: "Server error during login" });
  }
});

app.post("/api/resend-code", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    // Check if the user exists
    const userResult = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;

    // Generate a new verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");

    // Update or insert the verification token in the database
    await pool.query(
      `INSERT INTO email_verifications (user_id, token) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token`,
      [userId, verificationToken]
    );

    // Send the verification email
    const verificationLink = `${req.protocol}://${req.get("host")}/api/verify-email?token=${verificationToken}`;
    await sendSignupEmail(email, verificationLink);

    res.status(200).json({ success: true, message: "Verification code resent" });
  } catch (error) {
    console.error("Error resending verification code:", error);
    res.status(500).json({ error: "Server error while resending verification code" });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    // Check if the user exists
    const userResult = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;

    // Generate a password reset token
    const resetToken = crypto.randomBytes(32).toString("hex");

    // Save the token to the database
    await pool.query(
      `INSERT INTO password_resets (user_id, token) VALUES ($1, $2)`,
      [userId, resetToken]
    );

    // Send the password reset email
    const resetLink = `${req.protocol}://${req.get("host")}/api/reset-password?token=${resetToken}`;
    await sendResetPasswordEmail(email, resetLink);

    res.status(200).json({ success: true, message: "Password reset link sent" });
  } catch (error) {
    console.error("Error in forgot password:", error);
    res.status(500).json({ error: "Server error in forgot password" });
  }
});

app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token and new password are required" });
  }

  try {
    // Get the user ID associated with the token
    const result = await pool.query(
      `SELECT user_id FROM password_resets WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const userId = result.rows[0].user_id;

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update the user's password
    await pool.query(
      `UPDATE users SET password = $1 WHERE id = $2`,
      [hashedPassword, userId]
    );

    // Delete the used token
    await pool.query(
      `DELETE FROM password_resets WHERE token = $1`,
      [token]
    );

    res.status(200).json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    console.error("Error resetting password:", error);
    res.status(500).json({ error: "Server error while resetting password" });
  }
});

app.post("/api/generate-profile-pics", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    // Generate image using OpenAI
    const response = await openai.images.generate({
      prompt,
      n: 1,
      size: "1024x1024",
    });

    const imageUrl = response.data[0].url;

    // Upload the image to S3
    const s3Url = await uploadImageUrlToS3(imageUrl);

    res.status(200).json({ success: true, imageUrl: s3Url });
  } catch (error) {
    console.error("Error generating profile picture:", error);
    res.status(500).json({ error: "Server error while generating profile picture" });
  }
});

app.post("/api/middleman-service", async (req, res) => {
  const { userId, action, requestId } = req.body;

  if (!userId || !action || !requestId) {
    return res.status(400).json({ error: "User ID, action, and request ID are required" });
  }

  try {
    // Perform the action (accept, reject, complete) for the middleman service
    let query, params;

    if (action === "accept") {
      query = `UPDATE middleman_requests SET status = 'accepted' WHERE id = $1 AND user_id = $2`;
      params = [requestId, userId];
    } else if (action === "reject") {
      query = `UPDATE middleman_requests SET status = 'rejected' WHERE id = $1 AND user_id = $2`;
      params = [requestId, userId];
    } else if (action === "complete") {
      query = `UPDATE middleman_requests SET status = 'completed' WHERE id = $1 AND user_id = $2`;
      params = [requestId, userId];
    } else {
      return res.status(400).json({ error: "Invalid action" });
    }

    await pool.query(query, params);

    res.status(200).json({ success: true, message: `Request ${action}ed successfully` });
  } catch (error) {
    console.error("Error in middleman service:", error);
    res.status(500).json({ error: "Server error in middleman service" });
  }
});

app.post("/api/send-confirmation-code", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    // Generate a confirmation code
    const confirmationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save the confirmation code to the database
    await pool.query(
      `INSERT INTO email_confirmations (email, code) VALUES ($1, $2)`,
      [email, confirmationCode]
    );

    // Send the confirmation code via email
    await sendMiddlemanEmail(email, confirmationCode);

    res.status(200).json({ success: true, message: "Confirmation code sent" });
  } catch (error) {
    console.error("Error sending confirmation code:", error);
    res.status(500).json({ error: "Server error while sending confirmation code" });
  }
});

app.post("/api/validate-confirmation-code", async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: "Email and code are required" });
  }

  try {
    // Check if the code matches the one in the database
    const result = await pool.query(
      `SELECT * FROM email_confirmations WHERE email = $1 AND code = $2`,
      [email, code]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid confirmation code" });
    }

    // Delete the used confirmation code
    await pool.query(
      `DELETE FROM email_confirmations WHERE email = $1`,
      [email]
    );

    res.status(200).json({ success: true, message: "Confirmation code validated" });
  } catch (error) {
    console.error("Error validating confirmation code:", error);
    res.status(500).json({ error: "Server error while validating confirmation code" });
  }
});

app.get("/api/middleman-requests", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM middleman_requests WHERE user_id = $1`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching middleman requests:", error);
    res.status(500).json({ error: "Server error while fetching middleman requests" });
  }
});

app.post("/api/middleman-accept", async (req, res) => {
  const { requestId, userId } = req.body;

  if (!requestId || !userId) {
    return res.status(400).json({ error: "Request ID and User ID are required" });
  }

  try {
    // Update the request status to accepted
    await pool.query(
      `UPDATE middleman_requests SET status = 'accepted' WHERE id = $1 AND user_id = $2`,
      [requestId, userId]
    );

    res.status(200).json({ success: true, message: "Request accepted" });
  } catch (error) {
    console.error("Error accepting middleman request:", error);
    res.status(500).json({ error: "Server error while accepting middleman request" });
  }
});

app.get("/api/middleman-status", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT status FROM middleman_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No middleman request found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching middleman status:", error);
    res.status(500).json({ error: "Server error while fetching middleman status" });
  }
});

app.get("/api/middleman-confirmation-status", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT confirmed, payment_status FROM middleman_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No middleman request found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching middleman confirmation status:", error);
    res.status(500).json({ error: "Server error while fetching middleman confirmation status" });
  }
});

app.post("/api/markPaymentAsPaid", async (req, res) => {
  const { requestId, userId } = req.body;

  if (!requestId || !userId) {
    return res.status(400).json({ error: "Request ID and User ID are required" });
  }

  try {
    // Update the payment status to paid
    await pool.query(
      `UPDATE middleman_requests SET payment_status = 'paid' WHERE id = $1 AND user_id = $2`,
      [requestId, userId]
    );

    res.status(200).json({ success: true, message: "Payment marked as paid" });
  } catch (error) {
    console.error("Error marking payment as paid:", error);
    res.status(500).json({ error: "Server error while marking payment as paid" });
  }
});

app.get("/api/getPaymentStatus", async (req, res) => {
  const { requestId } = req.query;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT payment_status FROM middleman_requests WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Request not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching payment status:", error);
    res.status(500).json({ error: "Server error while fetching payment status" });
  }
});

app.post("/api/upload-profile-photo", upload.single("profilePhoto"), async (req, res) => {
  const { userId } = req.body;

  if (!userId || !req.file) {
    return res.status(400).json({ error: "User ID and profile photo are required" });
  }

  try {
    // Upload the file to S3
    const fileContent = req.file.buffer;
    const fileName = `${Date.now()}-${req.file.originalname}`;

    const params = {
      Bucket: "user-profile-pic-legitprove",
      Key: fileName,
      Body: fileContent,
      ContentType: req.file.mimetype,
      ACL: "public-read",
    };

    const uploadResult = await s3.upload(params).promise();
    const photoUrl = uploadResult.Location;

    // Update the user's profile photo URL in the database
    await pool.query(
      `UPDATE users SET profile_photo = $1 WHERE id = $2`,
      [photoUrl, userId]
    );

    res.status(200).json({ success: true, photoUrl });
  } catch (error) {
    console.error("Error uploading profile photo:", error);
    res.status(500).json({ error: "Server error while uploading profile photo" });
  }
});

app.get("/api/getCategoryAndPrice/:requestId", async (req, res) => {
  const { requestId } = req.params;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT category, price FROM service_requests WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Request not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching category and price:", error);
    res.status(500).json({ error: "Server error while fetching category and price" });
  }
});

app.post("/api/confirmTransaction", async (req, res) => {
  const { requestId, userId, transactionId } = req.body;

  if (!requestId || !userId || !transactionId) {
    return res.status(400).json({ error: "Request ID, User ID, and Transaction ID are required" });
  }

  try {
    // Update the transaction status to confirmed
    await pool.query(
      `UPDATE transactions SET status = 'confirmed' WHERE id = $1 AND user_id = $2`,
      [transactionId, userId]
    );

    // Update the service request status to completed
    await pool.query(
      `UPDATE service_requests SET status = 'completed' WHERE id = $1`,
      [requestId]
    );

    res.status(200).json({ success: true, message: "Transaction confirmed" });
  } catch (error) {
    console.error("Error confirming transaction:", error);
    res.status(500).json({ error: "Server error while confirming transaction" });
  }
});

app.get("/api/getTransactionStatus", async (req, res) => {
  const { transactionId } = req.query;

  if (!transactionId) {
    return res.status(400).json({ error: "Transaction ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT status FROM transactions WHERE id = $1`,
      [transactionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching transaction status:", error);
    res.status(500).json({ error: "Server error while fetching transaction status" });
  }
});

app.get("/api/getCompletedAmount", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT SUM(amount) as totalCompletedAmount FROM transactions WHERE user_id = $1 AND status = 'completed'`,
      [userId]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching completed amount:", error);
    res.status(500).json({ error: "Server error while fetching completed amount" });
  }
});

app.post("/api/withdrawAmount", async (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount) {
    return res.status(400).json({ error: "User ID and amount are required" });
  }

  try {
    // Create a withdraw request
    await pool.query(
      `INSERT INTO withdraw_requests (user_id, amount, status) VALUES ($1, $2, 'pending')`,
      [userId, amount]
    );

    res.status(201).json({ success: true, message: "Withdraw request created" });
  } catch (error) {
    console.error("Error creating withdraw request:", error);
    res.status(500).json({ error: "Server error while creating withdraw request" });
  }
});

app.get("/api/getSellerAmount", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT amount FROM sellers WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Seller not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching seller amount:", error);
    res.status(500).json({ error: "Server error while fetching seller amount" });
  }
});

app.post("/api/createWithdrawRequest", async (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount) {
    return res.status(400).json({ error: "User ID and amount are required" });
  }

  try {
    // Create a withdraw request
    await pool.query(
      `INSERT INTO withdraw_requests (user_id, amount, status) VALUES ($1, $2, 'pending')`,
      [userId, amount]
    );

    res.status(201).json({ success: true, message: "Withdraw request created" });
  } catch (error) {
    console.error("Error creating withdraw request:", error);
    res.status(500).json({ error: "Server error while creating withdraw request" });
  }
});

app.get("/api/getCryptoCurrencies", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM cryptocurrencies`
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching cryptocurrencies:", error);
    res.status(500).json({ error: "Server error while fetching cryptocurrencies" });
  }
});

app.post("/api/verify-id", upload.single("document"), async (req, res) => {
  const { userId } = req.body;

  if (!userId || !req.file) {
    return res.status(400).json({ error: "User ID and document are required" });
  }

  try {
    // Upload the document to S3
    const fileContent = req.file.buffer;
    const fileName = `${Date.now()}-${req.file.originalname}`;

    const params = {
      Bucket: "id-verification-docs-legitprove",
      Key: fileName,
      Body: fileContent,
      ContentType: req.file.mimetype,
      ACL: "public-read",
    };

    const uploadResult = await s3.upload(params).promise();
    const documentUrl = uploadResult.Location;

    // Save the verification request to the database
    await pool.query(
      `INSERT INTO id_verification_requests (user_id, document_url, status) VALUES ($1, $2, 'pending')`,
      [userId, documentUrl]
    );

    res.status(200).json({ success: true, message: "Verification request submitted" });
  } catch (error) {
    console.error("Error verifying ID:", error);
    res.status(500).json({ error: "Server error while verifying ID" });
  }
});

app.post("/api/confirmVerification", async (req, res) => {
  const { requestId, action } = req.body;

  if (!requestId || !action) {
    return res.status(400).json({ error: "Request ID and action are required" });
  }

  try {
    // Update the verification request status
    await pool.query(
      `UPDATE id_verification_requests SET status = $1 WHERE id = $2`,
      [action, requestId]
    );

    res.status(200).json({ success: true, message: `Verification request ${action}ed` });
  } catch (error) {
    console.error("Error confirming verification:", error);
    res.status(500).json({ error: "Server error while confirming verification" });
  }
});

app.get("/api/getVerificationStatus", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT status FROM id_verification_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No verification request found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching verification status:", error);
    res.status(500).json({ error: "Server error while fetching verification status" });
  }
});

// Routes from chatting.js
app.post("/api/sendMessage", async (req, res) => {
  const { requestId, userId, message } = req.body;

  if (!requestId || !userId || !message) {
    return res.status(400).json({ error: "Request ID, User ID, and message are required" });
  }

  try {
    // Save the message to the database
    await pool.query(
      `INSERT INTO messages (request_id, user_id, message) VALUES ($1, $2, $3)`,
      [requestId, userId, message]
    );

    // Emit the message to all users in the room
    io.to(requestId).emit("newMessage", { requestId, userId, message });

    res.status(200).json({ success: true, message: "Message sent" });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Server error while sending message" });
  }
});

app.get("/api/getMessages/:requestId", async (req, res) => {
  const { requestId } = req.params;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM messages WHERE request_id = $1 ORDER BY created_at ASC`,
      [requestId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ error: "Server error while fetching messages" });
  }
});

app.get("/api/getAllChats", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (request_id) * FROM messages WHERE user_id = $1 ORDER BY request_id, created_at DESC`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching all chats:", error);
    res.status(500).json({ error: "Server error while fetching all chats" });
  }
});

app.get("/api/getUserRole/:requestId", async (req, res) => {
  const { requestId } = req.params;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT user_id, role FROM request_participants WHERE request_id = $1`,
      [requestId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching user role:", error);
    res.status(500).json({ error: "Server error while fetching user role" });
  }
});

app.post("/api/uploadFiles", upload.array("files"), async (req, res) => {
  const { requestId } = req.body;

  if (!requestId || !req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Request ID and files are required" });
  }

  try {
    // Upload each file to S3 and save the file URLs to the database
    for (const file of req.files) {
      const fileContent = file.buffer;
      const fileName = `${Date.now()}-${file.originalname}`;

      const params = {
        Bucket: "chat-file-uploads-legitprove",
        Key: fileName,
        Body: fileContent,
        ContentType: file.mimetype,
        ACL: "public-read",
      };

      const uploadResult = await s3.upload(params).promise();
      const fileUrl = uploadResult.Location;

      // Save the file URL to the database
      await pool.query(
        `INSERT INTO files (request_id, url) VALUES ($1, $2)`,
        [requestId, fileUrl]
      );
    }

    res.status(200).json({ success: true, message: "Files uploaded successfully" });
  } catch (error) {
    console.error("Error uploading files:", error);
    res.status(500).json({ error: "Server error while uploading files" });
  }
});

app.get("/api/getUserDetails/:requestId", async (req, res) => {
  const { requestId } = req.params;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.profile_photo, rp.role
       FROM users u
       JOIN request_participants rp ON u.id = rp.user_id
       WHERE rp.request_id = $1`,
      [requestId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching user details:", error);
    res.status(500).json({ error: "Server error while fetching user details" });
  }
});

app.get("/api/getUnreadMessageCount", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT COUNT(*) as unreadCount FROM messages WHERE request_id IN (
         SELECT request_id FROM request_participants WHERE user_id = $1
       ) AND is_read = false`,
      [userId]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching unread message count:", error);
    res.status(500).json({ error: "Server error while fetching unread message count" });
  }
});

app.get("/api/validateAccess/:requestId", async (req, res) => {
  const { requestId } = req.params;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM request_participants WHERE request_id = $1 AND user_id = $2
       ) AS has_access`,
      [requestId, userId]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error validating access:", error);
    res.status(500).json({ error: "Server error while validating access" });
  }
});

app.get("/api/hasFileMessages/:requestId", async (req, res) => {
  const { requestId } = req.params;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM files WHERE request_id = $1
       ) AS has_files`,
      [requestId]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error checking file messages:", error);
    res.status(500).json({ error: "Server error while checking file messages" });
  }
});

app.post("/api/reportUser", async (req, res) => {
  const { reporterId, reportedId, reason } = req.body;

  if (!reporterId || !reportedId || !reason) {
    return res.status(400).json({ error: "Reporter ID, Reported ID, and reason are required" });
  }

  try {
    // Create a new report
    await pool.query(
      `INSERT INTO user_reports (reporter_id, reported_id, reason) VALUES ($1, $2, $3)`,
      [reporterId, reportedId, reason]
    );

    res.status(201).json({ success: true, message: "User reported successfully" });
  } catch (error) {
    console.error("Error reporting user:", error);
    res.status(500).json({ error: "Server error while reporting user" });
  }
});

app.get("/api/getUserReports", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM user_reports WHERE reporter_id = $1`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching user reports:", error);
    res.status(500).json({ error: "Server error while fetching user reports" });
  }
});

app.get("/api/getAllUserReports", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM user_reports`
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching all user reports:", error);
    res.status(500).json({ error: "Server error while fetching all user reports" });
  }
});

app.post("/api/updateReportStatus", async (req, res) => {
  const { reportId, status } = req.body;

  if (!reportId || !status) {
    return res.status(400).json({ error: "Report ID and status are required" });
  }

  try {
    // Update the report status
    await pool.query(
      `UPDATE user_reports SET status = $1 WHERE id = $2`,
      [status, reportId]
    );

    res.status(200).json({ success: true, message: "Report status updated" });
  } catch (error) {
    console.error("Error updating report status:", error);
    res.status(500).json({ error: "Server error while updating report status" });
  }
});


app.get('/', (req, res) => {
  res.send('Server is working');
});

// Start the server
server.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
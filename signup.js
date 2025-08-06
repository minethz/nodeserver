const express = require("express");
const router = express.Router();
const { sendSignupEmail, sendMiddlemanEmail } = require('./sendEmail');
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcrypt");
const multer = require("multer");
const AWS = require("aws-sdk");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");
const axios = require("axios");


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

// AWS S3 Configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Secret key for JWT
const JWT_SECRET = process.env.JWT_SECRET;

// OpenAI API Configuration
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Multer config
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Upload to S3
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

// Utility to download an image from a URL and re-upload it to S3
const uploadImageUrlToS3 = async (imageUrl, originalName = "ai-generated.jpg") => {
  const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
  
  const fileBuffer = Buffer.from(response.data, "binary");
  const file = {
    originalname: originalName,
    mimetype: "image/jpeg", // Adjust if needed
    buffer: fileBuffer
  };

  return await uploadToS3(file);
};

// Signup API
router.post("/api/signup", upload.single("profilePhoto"), async (req, res) => {
  const { firstName, lastName, email, password, profilePhotoUrl } = req.body; // Added profilePhotoUrl
  const profilePhoto = req.file;

  try {
    const existingUser = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    let profilePhotoUrlToSave = null;

    if (profilePhoto) {
      profilePhotoUrlToSave = await uploadToS3(profilePhoto);
    } else if (profilePhotoUrl) {
      // Re-upload AI-generated profile pic to S3 to avoid expiry
      profilePhotoUrlToSave = await uploadImageUrlToS3(profilePhotoUrl);
    }

    if (!profilePhotoUrlToSave) {
      return res.status(400).json({ message: "Profile photo is required." });
    }

    // Generate a 6-digit verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save user data temporarily in the verification table
    await pool.query(
      `INSERT INTO email_verifications (first_name, last_name, email, password, profile_photo, verification_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (email)
       DO UPDATE SET first_name = $1, last_name = $2, password = $4, profile_photo = $5, verification_code = $6, created_at = NOW()`,
      [firstName, lastName, email, hashedPassword, profilePhotoUrlToSave, verificationCode]
    );

    // Send verification email
    await sendSignupEmail(email, `${firstName} ${lastName}`, verificationCode);

    return res.status(201).json({
      message: "Verification email sent. Please verify your email to complete the signup process.",
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
});

router.post("/api/verify-email", async (req, res) => {
  const { email, code } = req.body;

  try {
    // Check if the verification code is valid and not expired (e.g., within 1 minute)
    const result = await pool.query(
      "SELECT * FROM email_verifications WHERE email = $1 AND verification_code = $2 AND NOW() - created_at <= INTERVAL '1 minute'",
      [email, code]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired verification code." });
    }

    const { first_name, last_name, password, profile_photo } = result.rows[0];

    // Move user data from the verification table to the users table
    const userResult = await pool.query(
      "INSERT INTO users (first_name, last_name, email, password, profile_photo, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, email",
      [first_name, last_name, email, password, profile_photo]
    );

    // Delete the verification entry
    await pool.query("DELETE FROM email_verifications WHERE email = $1", [email]);

    return res.status(200).json({
      message: "Email verified successfully. Account created.",
      user: {
        id: userResult.rows[0].id,
        email: userResult.rows[0].email,
      },
    });
  } catch (error) {
    console.error("Email verification error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
});


// Login API
router.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // Check if the user exists
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = userResult.rows[0];

    // Compare the provided password with the hashed password in DB
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "1h" } // Token expires in 1 hour
    );

    // On success, return user data and token
    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        profilePhoto: user.profile_photo, // Ensure profile photo is returned
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Resend verification code API
router.post("/api/resend-code", async (req, res) => {
  const { email } = req.body;

  try {
    // Check if the email exists in the email_verifications table
    const result = await pool.query("SELECT * FROM email_verifications WHERE email = $1", [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Email not found or already verified." });
    }

    // Generate a new 6-digit verification code
    const newVerificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Update the verification code and timestamp
    await pool.query(
      "UPDATE email_verifications SET verification_code = $1, created_at = NOW() WHERE email = $2",
      [newVerificationCode, email]
    );

    // Send the new verification code via email
    const { first_name, last_name } = result.rows[0];
    await sendSignupEmail(email, `${first_name} ${last_name}`, newVerificationCode);

    return res.status(200).json({ message: "Verification code resent successfully." });
  } catch (error) {
    console.error("Resend code error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
});

const { sendResetPasswordEmail } = require('./sendEmail'); // Adjust path if needed

const crypto = require("crypto");

router.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    // Check if the user exists
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: "Email not found" });
    }

    const user = userResult.rows[0];

    // Generate a secure token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    // Set token expiration time (e.g., 15 minutes)
    const expiration = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now

    // Store the token and expiration in a separate table or user record
    await pool.query(
      `INSERT INTO password_resets (email, token_hash, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email)
       DO UPDATE SET token_hash = $2, expires_at = $3`,
      [email, hashedToken, expiration]
    );

    // Construct reset link (adjust frontend URL)
    const resetLink = `https://nodeserver-production-982a.up.railway.app/reset-password?token=${resetToken}&email=${email}`;

    // Send email
    await sendResetPasswordEmail(email, user.first_name, resetLink);

    return res.status(200).json({
      message: "Password reset link sent. Please check your email.",
    });

  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

router.post("/api/reset-password", async (req, res) => {
  const { email, token, newPassword } = req.body;

  try {
    // Hash the provided token for comparison
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Check if the token is valid and not expired
    const result = await pool.query(
      `SELECT * FROM password_resets 
       WHERE email = $1 AND token_hash = $2 AND expires_at > NOW()`,
      [email, hashedToken]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update the user's password
    await pool.query(
      `UPDATE users SET password = $1 WHERE email = $2`,
      [hashedPassword, email]
    );

    // Delete the password reset token from the database
    await pool.query(
      `DELETE FROM password_resets WHERE email = $1`,
      [email]
    );

    return res.status(200).json({ message: "Password reset successful." });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// AI Profile Picture Generation API
router.post("/api/generate-profile-pics", async (req, res) => {
  try {
    const response = await openai.images.generate({
      prompt: "A Pixar-style animated avatar of a pleasant character with a beautiful background, high quality, vibrant colors",
      n: 3, // Generate 3 images
      size: "512x512", // Increased resolution for better quality
    });

    const photos = response.data.map((image) => image.url);
    res.status(200).json({ photos });
  } catch (error) {
    console.error("Error generating AI profile pictures:", error);
    res.status(500).json({ message: "Failed to generate profile pictures." });
  }
});

// Middleman Service API
router.post("/api/middleman-service", async (req, res) => {
  const { role, firstName, lastName, email, counterpartyEmail, category, price, currency } = req.body;

  try {
    // Check if the user is verified
    const userResult = await pool.query(
      `SELECT is_verified FROM users WHERE email = $1`,
      [email]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].is_verified) {
      return res.status(403).json({ message: "You must verify your account to use the Middleman feature." });
    }

    // Save middleman service details to the database with 'pending' status
    const result = await pool.query(
      `INSERT INTO middleman_services (role, first_name, last_name, email, counterparty_email, category, price, currency, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
       RETURNING id`,
      [role, firstName, lastName, email, counterpartyEmail, category, price, currency]
    );

    const requestId = result.rows[0].id;

    // Generate 6-digit confirmation codes for both buyer and seller
    const buyerCode = Math.floor(100000 + Math.random() * 900000).toString();
    const sellerCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save confirmation codes in the database
    await pool.query(
      `INSERT INTO confirmation_codes (request_id, email, role, code, created_at)
       VALUES ($1, $2, 'buyer', $3, NOW()), ($1, $4, 'seller', $5, NOW())`,
      [requestId, role === "buyer" ? email : counterpartyEmail, buyerCode, role === "seller" ? email : counterpartyEmail, sellerCode]
    );

    // Generate links for buyer and seller
    const buyerLink = `https://nodeserver-production-982a.up.railway.app/waiting?requestId=${requestId}&role=buyer`;
    const sellerLink = `https://nodeserver-production-982a.up.railway.app/waiting?requestId=${requestId}&role=seller`;

    // Send emails to both buyer and seller with their respective confirmation codes
    const buyerEmail = role === "buyer" ? email : counterpartyEmail;
    const sellerEmail = role === "seller" ? email : counterpartyEmail;

    await sendMiddlemanEmail(buyerEmail, "Buyer", category, price, currency, buyerLink, buyerCode);
    await sendMiddlemanEmail(sellerEmail, "Seller", category, price, currency, sellerLink, sellerCode);

    return res.status(200).json({ message: "Middleman service details saved and emails sent successfully.", requestId });
  } catch (error) {
    console.error("Middleman service error:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Generate and send 6-digit confirmation codes
router.post("/api/send-confirmation-code", async (req, res) => {
  const { requestId, email, role } = req.body;

  try {
    const confirmationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save the confirmation code in the database
    await pool.query(
      `INSERT INTO confirmation_codes (request_id, email, role, code, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (request_id, email)
       DO UPDATE SET code = $4, created_at = NOW()`,
      [requestId, email, role, confirmationCode]
    );

    // Send the confirmation code via email
    const actionLink = `https://nodeserver-production-982a.up.railway.app/waiting?requestId=${requestId}`;
    await sendMiddlemanEmail(email, role, "Confirmation Code", "", "", actionLink, confirmationCode);

    return res.status(200).json({ message: "Confirmation code sent successfully." });
  } catch (error) {
    console.error("Error sending confirmation code:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Validate the 6-digit confirmation code
router.post("/api/validate-confirmation-code", async (req, res) => {
  const { requestId, email, code, role } = req.body;

  try {
    // Fetch the confirmation code from the database
    const result = await pool.query(
      `SELECT * FROM confirmation_codes
       WHERE request_id = $1 AND email = $2 AND role = $3 AND NOW() - created_at <= INTERVAL '10 minutes'`,
      [requestId, email, role]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired confirmation code." });
    }

    const { code: storedCode, confirmed } = result.rows[0];

    // Check if the code has already been confirmed
    if (confirmed) {
      return res.status(400).json({ message: "This code has already been used." });
    }

    // Validate the provided code
    if (storedCode !== code) {
      return res.status(400).json({ message: "Invalid confirmation code." });
    }

    // Mark the code as confirmed
    await pool.query(
      `UPDATE confirmation_codes SET confirmed = TRUE WHERE request_id = $1 AND email = $2 AND role = $3`,
      [requestId, email, role]
    );

    // Update the confirmation status for the role
    const statusColumn = role === "buyer" ? "buyer_confirmed" : "seller_confirmed";
    await pool.query(
      `UPDATE middleman_services SET ${statusColumn} = TRUE WHERE id = $1`,
      [requestId]
    );

    // Check if both parties have confirmed
    const serviceStatus = await pool.query(
      `SELECT buyer_confirmed, seller_confirmed FROM middleman_services WHERE id = $1`,
      [requestId]
    );

    const { buyer_confirmed, seller_confirmed } = serviceStatus.rows[0];
    if (buyer_confirmed && seller_confirmed) {
      await pool.query(
        `UPDATE middleman_services SET status = 'confirmed' WHERE id = $1`,
        [requestId]
      );
    }

    return res.status(200).json({
      message: "Confirmation successful.",
      buyer_confirmed,
      seller_confirmed,
    });
  } catch (error) {
    console.error("Error validating confirmation code:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Fetch user's middleman requests grouped by status
router.get("/api/middleman-requests", async (req, res) => {
  const { email } = req.query;

  try {
    // Move unpaid requests older than 7 days to "incompleted"
    await pool.query(
      `UPDATE middleman_services
       SET status = 'incompleted'
       WHERE status = 'pending' AND is_paid = FALSE AND NOW() - created_at > INTERVAL '7 days'`
    );

    // Keep paid requests older than 7 days in "pending" status
    await pool.query(
      `UPDATE middleman_services
       SET status = 'pending'
       WHERE status = 'pending' AND is_paid = TRUE AND NOW() - created_at > INTERVAL '7 days'`
    );

    // Fetch updated requests grouped by status
    const result = await pool.query(
      `SELECT id, role, category, price, currency, status, created_at
       FROM middleman_services
       WHERE email = $1 OR counterparty_email = $1
       ORDER BY created_at DESC`,
      [email]
    );

    const groupedRequests = result.rows.reduce((acc, request) => {
      acc[request.status] = acc[request.status] || [];
      acc[request.status].push(request);
      return acc;
    }, {});

    return res.status(200).json(groupedRequests);
  } catch (error) {
    console.error("Fetch middleman requests error:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Accept middleman request (seller action)
router.post("/api/middleman-accept", async (req, res) => {
  const { requestId } = req.body;

  try {
    // Update the status to 'accepted' by the seller
    await pool.query(
      `UPDATE middleman_services SET status = 'accepted' WHERE id = $1 AND status = 'pending'`,
      [requestId]
    );

    return res.status(200).json({ message: "Request accepted successfully." });
  } catch (error) {
    console.error("Error accepting middleman request:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Get middleman request status
router.get("/api/middleman-status", async (req, res) => {
  const { requestId } = req.query;

  try {
    const result = await pool.query(
      `SELECT status FROM middleman_services WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Request not found." });
    }

    return res.status(200).json({ status: result.rows[0].status });
  } catch (error) {
    console.error("Error fetching middleman status:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

router.get("/api/middleman-confirmation-status", async (req, res) => {
  const { requestId } = req.query;

  try {
    const result = await pool.query(
      `SELECT buyer_confirmed, seller_confirmed FROM middleman_services WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Request not found." });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching confirmation status:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Mark payment as paid
router.post("/api/markPaymentAsPaid", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    await pool.query(
      `UPDATE middleman_services SET is_paid = TRUE WHERE id = $1`,
      [requestId]
    );
    res.status(200).json({ success: true, message: "Payment marked as paid successfully." });
  } catch (error) {
    console.error("Error marking payment as paid:", error.message);
    res.status(500).json({ error: "Failed to mark payment as paid in the database." });
  }
});

// Get payment status
router.get("/api/getPaymentStatus", async (req, res) => {
  const { requestId } = req.query;

  if (!requestId) {
    return res.status(400).json({ error: "Request ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT is_paid FROM middleman_services WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Request not found." });
    }

    res.status(200).json({ is_paid: result.rows[0].is_paid });
  } catch (error) {
    console.error("Error fetching payment status:", error.message);
    res.status(500).json({ error: "Failed to fetch payment status." });
  }
});

// Removed chatting-related functions. These have been moved to chatting.js.

// Profile Photo Upload API
router.post("/api/upload-profile-photo", upload.single("profilePhoto"), async (req, res) => {
  const profilePhoto = req.file;
  const { userId } = req.body; // Get user ID from the request

  if (!profilePhoto || !userId) {
    return res.status(400).json({ message: "File and user ID are required" });
  }

  try {
    const profilePhotoUrl = await uploadToS3(profilePhoto);

    // Update the user's profile photo URL in the database
    await pool.query(
      `UPDATE users SET profile_photo = $1 WHERE id = $2`,
      [profilePhotoUrl, userId]
    );

    return res.status(200).json({ profilePhotoUrl });
  } catch (error) {
    console.error("Error uploading profile photo:", error);
    return res.status(500).json({ message: "Failed to upload profile photo" });
  }
});

// Fetch category and price for a specific request
router.get("/api/getCategoryAndPrice/:requestId", async (req, res) => {
  const { requestId } = req.params;

  try {
    const result = await pool.query(
      `SELECT category, price, currency FROM middleman_services WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Request not found." });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching category and price:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Mark the transaction as completed
router.post("/api/confirmTransaction", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ message: "Request ID is required." });
  }

  try {
    // Update the middleman_services table to mark the transaction as completed
    await pool.query(
      `UPDATE middleman_services SET status = 'completed' WHERE id = $1 AND is_paid = TRUE`,
      [requestId]
    );

    return res.status(200).json({ message: "Transaction marked as completed." });
  } catch (error) {
    console.error("Error marking transaction as completed:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Check if transaction is completed
router.get("/api/getTransactionStatus", async (req, res) => {
  const { requestId } = req.query;

  if (!requestId) {
    return res.status(400).json({ message: "Request ID is required." });
  }

  try {
    const result = await pool.query(
      `SELECT status FROM middleman_services WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Transaction not found." });
    }

    res.status(200).json({ status: result.rows[0].status });
  } catch (error) {
    console.error("Error fetching transaction status:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Fetch the total amount for completed transactions for a seller
router.get("/api/getCompletedAmount", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    console.log("Fetching completed amount for email:", email); // Debugging log
    const result = await pool.query(
      `SELECT COALESCE(SUM(price), 0) AS totalAmount
       FROM middleman_services
       WHERE counterparty_email = $1 AND status = 'completed'`,
      [email]
    );

    console.log("Completed amount query result:", result.rows[0]); // Debugging log
    res.status(200).json({ totalAmount: result.rows[0].totalamount });
  } catch (error) {
    console.error("Error fetching completed amount:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Withdraw amount API
router.post("/api/withdrawAmount", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    // Fetch the total amount for completed transactions
    const result = await pool.query(
      `SELECT COALESCE(SUM(price), 0) AS totalAmount
       FROM middleman_services
       WHERE counterparty_email = $1 AND status = 'completed'`,
      [email]
    );

    const totalAmount = result.rows[0].totalamount;

    if (totalAmount === 0) {
      return res.status(400).json({ message: "No amount available for withdrawal." });
    }

    // Process the withdrawal (e.g., integrate with payment gateway)
    // For now, we assume the withdrawal is successful

    // Reset the completed transactions to prevent duplicate withdrawals
    await pool.query(
      `UPDATE middleman_services
       SET status = 'withdrawn'
       WHERE counterparty_email = $1 AND status = 'completed'`,
      [email]
    );

    res.status(200).json({ message: "Withdrawal successful." });
  } catch (error) {
    console.error("Error processing withdrawal:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Fetch the seller's amount for completed transactions
router.get("/api/getSellerAmount", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    console.log("Fetching seller amount for email:", email); // Debugging log

    // Calculate total amount for completed transactions excluding withdrawn ones
    const result = await pool.query(
      `SELECT COALESCE(SUM(price), 0) AS totalAmount
       FROM middleman_services
       WHERE ((counterparty_email = $1 AND role = 'buyer' AND status = 'completed')
          OR (email = $1 AND role = 'seller' AND status = 'completed'))
          AND withdraw = FALSE`,
      [email]
    );

    console.log("Seller amount query result:", result.rows[0]); // Debugging log
    res.status(200).json({ totalAmount: result.rows[0].totalamount });
  } catch (error) {
    console.error("Error fetching seller amount:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Create Withdraw Request API
router.post("/api/createWithdrawRequest", async (req, res) => {
  const { userId, email, amount, cryptoCurrency, walletAddress } = req.body;

  if (!userId || !email || !amount || !cryptoCurrency || !walletAddress) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    // Create a withdraw request
    await pool.query(
      `INSERT INTO withdraw_requests (user_id, email, amount, crypto_currency, wallet_address, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, email, amount, cryptoCurrency, walletAddress]
    );

    // Mark relevant transactions as withdrawn
    await pool.query(
      `UPDATE middleman_services
       SET withdraw = TRUE
       WHERE (counterparty_email = $1 AND role = 'buyer' AND status = 'completed')
          OR (email = $1 AND role = 'seller' AND status = 'completed')`,
      [email]
    );

    return res.status(200).json({ message: "Withdraw request created successfully." });
  } catch (error) {
    console.error("Error creating withdraw request:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Fetch Crypto Currencies API
router.get("/api/getCryptoCurrencies", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/coins/markets",
      {
        params: {
          vs_currency: "usd",
          order: "market_cap_desc",
          per_page: 10,
          page: 1,
        },
      }
    );

    if (!response.data || response.data.length === 0) {
      return res.status(200).json([]); // Return an empty array if no data is available
    }

    const cryptoCurrencies = response.data.map((coin) => ({
      name: coin.name,
      symbol: coin.symbol,
      logo: coin.image, // Include logo URL
    }));

    res.status(200).json(cryptoCurrencies);
  } catch (error) {
    console.error("Error fetching crypto currencies:", error.message);
    res.status(500).json({ message: "Failed to fetch crypto currencies", error: error.message });
  }
});

// ID Analyzer API Key and Endpoint
const ID_ANALYZER_API_KEY = "cHQAJmQsZf3KRDT2KoC2qenfRBJT6UoC";
const ID_ANALYZER_API_URL = "https://api2.idanalyzer.com/scan";

// Validate and extract document details
router.post("/api/verify-id", upload.single("document"), async (req, res) => {
  console.log("Headers:", req.headers);
  console.log("File:", req.file);
  console.log("Body:", req.body);

  if (!req.file) {
    return res.status(400).json({ message: "No document uploaded. Please upload a valid file." });
  }

  const document = req.file;

  try {
    // Fetch userId from the session (assuming session contains the user's email)
    const sessionEmail = req.headers["x-user-email"]; // Replace with your session mechanism
    if (!sessionEmail) {
      return res.status(401).json({ message: "Unauthorized. User session not found." });
    }

    const userResult = await pool.query("SELECT id FROM users WHERE email = $1", [sessionEmail]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const userId = userResult.rows[0].id;

    // Encode the document to Base64
    const documentBase64 = document.buffer.toString("base64");

    // Prepare payload for ID Analyzer API
    const payload = {
      profile: "c1ceb1796b26433796a865f7c5edea47", // Replace with your KYC profile ID
      document: documentBase64,
    };

    // Send request to ID Analyzer
    const response = await axios.post(ID_ANALYZER_API_URL, payload, {
      headers: {
        "X-API-KEY": ID_ANALYZER_API_KEY,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });

    const { data } = response;

    if (data.success) {
      // Extract details from the response
      const extractedDetails = {
        documentNumber: data.data.documentNumber || "N/A",
        fullName: data.data.name || "N/A",
        dob: data.data.dob || "N/A",
        country: data.data.country || "N/A",
      };

      // Check for matches in the database
      const matchResult = await pool.query(
        `SELECT id, verified_data FROM users 
         WHERE verified_data->>'documentNumber' = $1 
         OR verified_data->>'country' = $2 
         OR (verified_data->>'documentNumber' = $1 AND verified_data->>'dob' = $3)`,
        [extractedDetails.documentNumber, extractedDetails.country, extractedDetails.dob]
      );

      let matchMessage = null;

      if (matchResult.rows.length > 0) {
        const matchedUser = matchResult.rows[0];
        const matchedData = JSON.parse(matchedUser.verified_data);

        if (
          matchedData.documentNumber === extractedDetails.documentNumber &&
          matchedData.dob === extractedDetails.dob
        ) {
          matchMessage = "Another user is already verified with the same document number and date of birth.";
        } else if (
          matchedData.documentNumber === extractedDetails.documentNumber &&
          matchedData.country === extractedDetails.country &&
          matchedData.dob === extractedDetails.dob &&
          matchedData.fullName === extractedDetails.fullName
        ) {
          matchMessage = "Another user is already verified with the same details.";
        } else {
          matchMessage = "Another user is verified with matching document number or country.";
        }
      }

      return res.status(200).json({
        message: "Document validated successfully.",
        details: extractedDetails,
        matchMessage,
      });
    } else {
      return res.status(400).json({ message: "ID verification failed.", errors: data.warning });
    }
  } catch (error) {
    console.error("Error during ID verification:", error.message);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Confirm and save verification details
router.post("/api/confirmVerification", async (req, res) => {
  const { documentNumber, fullName, dob } = req.body;

  try {
    // Fetch userId from the session (assuming session contains the user's email)
    const sessionEmail = req.headers["x-user-email"]; // Replace with your session mechanism
    if (!sessionEmail) {
      return res.status(401).json({ message: "Unauthorized. User session not found." });
    }

    const userResult = await pool.query("SELECT id FROM users WHERE email = $1", [sessionEmail]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const userId = userResult.rows[0].id;

    // Check for duplicate document in the verified_data column
    const duplicateCheck = await pool.query(
      `SELECT id FROM users 
       WHERE verified_data->>'documentNumber' = $1 
       AND verified_data->>'dob' = $2 
       AND id != $3`,
      [documentNumber, dob, userId]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        message: "This document is already associated with another account.",
      });
    }

    // Save verification details to the database
    const verifiedData = { documentNumber, fullName, dob };
    await pool.query(
      `UPDATE users SET is_verified = TRUE, verified_data = $1 WHERE id = $2`,
      [JSON.stringify(verifiedData), userId]
    );

    return res.status(200).json({ message: "Verification confirmed and saved successfully." });
  } catch (error) {
    console.error("Error during verification confirmation:", error.message);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Fetch verification status
router.get("/api/getVerificationStatus", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ message: "User ID is required." });
  }

  try {
    const result = await pool.query(
      `SELECT is_verified FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    res.status(200).json({ is_verified: result.rows[0].is_verified });
  } catch (error) {
    console.error("Error fetching verification status:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

// Move all routes from signup.js to server.js and export the router
module.exports = router;

// Update CORS configuration
const allowedOrigins = ["https://nodeserver-production-982a.up.railway.app", "http://localhost:3000", "http://localhost:5173"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
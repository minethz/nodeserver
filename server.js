require("dotenv").config(); // Load environment variables from .env file

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const AWS = require("aws-sdk");
const paymentsRoutes = require("./payments"); // Import payments.js
const profileRoutes = require("./profile"); // Import profile routes
const signupRoutes = require("./signup"); // Import all signup API routes
const { exec } = require("child_process");

const app = express();
const port = process.env.PORT || 5001;


// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  user: process.env.USER_DB_USER,
  host: process.env.USER_DB_HOST,
  database: process.env.USER_DB_NAME,
  password: process.env.USER_DB_PASSWORD,
  port: process.env.USER_DB_PORT,
  ssl: {
    rejectUnauthorized: false
  }
});

// PostgreSQL connection for user database
const userPool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: process.env.DB_PORT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false,
  },
});

// AWS S3 configuration directly in code
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

// Multer file upload config for AWS S3
const storage = multer.memoryStorage(); // Store files in memory temporarily
const upload = multer({ storage });

// Platform list
const platforms = [
  { id: 1, name: "Telegram" },
  { id: 2, name: "Facebook" },
  { id: 3, name: "Instagram" },
  { id: 4, name: "Twitter" },
  { id: 5, name: "WhatsApp" },
  { id: 6, name: "Snapchat" },
  { id: 7, name: "TikTok" },
  { id: 8, name: "LinkedIn" },
  { id: 9, name: "Reddit" },
  { id: 10, name: "YouTube" },
  { id: 11, name: "Pinterest" },
  { id: 12, name: "WeChat" },
  { id: 13, name: "Discord" },
  { id: 14, name: "Twitch" },
  { id: 15, name: "Clubhouse" },
  { id: 16, name: "Signal" },
  { id: 17, name: "Viber" },
  { id: 18, name: "Skype" },
  { id: 19, name: "Tumblr" },
  { id: 20, name: "Quora" },
  { id: 21, name: "Medium" },
  { id: 22, name: "Threads" },
  { id: 23, name: "Kik" },
  { id: 24, name: "LINE" },
  { id: 25, name: "Flickr" },
  { id: 26, name: "MeetMe" },
  { id: 27, name: "Tagged" },
  { id: 28, name: "Badoo" },
  { id: 29, name: "Tinder" },
  { id: 30, name: "Grindr" },
  { id: 31, name: "Hinge" },
  { id: 32, name: "OKCupid" },
  { id: 33, name: "Zoosk" },
  { id: 34, name: "Match.com" },
  { id: 35, name: "Plenty of Fish" },
  { id: 36, name: "eHarmony" },
  { id: 37, name: "Weibo" },
  { id: 38, name: "Douyin" },
  { id: 39, name: "QQ" },
  { id: 40, name: "Xing" },
  { id: 41, name: "Nextdoor" },
  { id: 42, name: "Myspace" },
  { id: 43, name: "Periscope" },
  { id: 44, name: "Houseparty" },
  { id: 45, name: "Gab" },
  { id: 46, name: "Parler" },
  { id: 47, name: "Truth Social" },
  { id: 48, name: "Mastodon" },
  { id: 49, name: "Ello" },
  { id: 50, name: "Vero" },
  { id: 51, name: "Steemit" },
  { id: 52, name: "BitClout" },
  { id: 53, name: "Minds" },
  { id: 54, name: "MeWe" },
  { id: 55, name: "Hive" },
  { id: 56, name: "Rumble" },
  { id: 57, name: "Omegle" },
  { id: 58, name: "Chatroulette" },
  { id: 59, name: "Habbo" },
  { id: 60, name: "IMVU" },
  { id: 61, name: "Roblox" },
  { id: 62, name: "Fortnite" },
  { id: 63, name: "Minecraft" },
  { id: 64, name: "Club Penguin" },
  { id: 65, name: "Second Life" },
  { id: 66, name: "VRChat" },
  { id: 67, name: "DeviantArt" },
  { id: 68, name: "ArtStation" },
  { id: 69, name: "Behance" },
  { id: 70, name: "Dribbble" },
  { id: 71, name: "GitHub" },
  { id: 72, name: "GitLab" },
  { id: 73, name: "Stack Overflow" },
  { id: 74, name: "BitBucket" },
  { id: 75, name: "Trello" },
  { id: 76, name: "Asana" },
  { id: 77, name: "Slack" },
  { id: 78, name: "Microsoft Teams" },
  { id: 79, name: "Zoom" },
  { id: 80, name: "Google Meet" },
  { id: 81, name: "BlueJeans" },
  { id: 82, name: "Webex" },
  { id: 83, name: "GoToMeeting" },
  { id: 84, name: "Hopin" },
  { id: 85, name: "Eventbrite" },
  { id: 86, name: "Meetup" },
  { id: 87, name: "Kickstarter" },
  { id: 88, name: "Indiegogo" },
  { id: 89, name: "Patreon" },
  { id: 90, name: "Buy Me a Coffee" },
  { id: 91, name: "Ko-fi" },
  { id: 92, name: "Substack" },
  { id: 93, name: "Locals" },
  { id: 94, name: "OnlyFans" },
  { id: 95, name: "Fanbase" },
  { id: 96, name: "Cameo" },
  { id: 97, name: "TeeSpring" },
  { id: 98, name: "Etsy" },
  { id: 99, name: "Amazon" },
  { id: 100, name: "eBay" }
];

// Routes
app.get("/platforms", (req, res) => {
  res.json(platforms);
});

app.post("/report", upload.single("screenshot"), async (req, res) => {
  try {
    const {
      platform,
      username,
      contactInfo,
      incidentType,
      description,
      dateTime,
      paymentDetails,
      victimEmail,
      userId, // Add userId to the request body
    } = req.body;

    if (!platform || !username || !incidentType || !description || !userId) {
      return res.status(400).json({ error: "Required fields are missing" });
    }

    // Check if the user has already reported this username or contact info
    const existingReport = await pool.query(
      `SELECT id FROM scam_reports 
       WHERE user_id = $1 AND (username = $2 OR contact_info = $3)`,
      [userId, username, contactInfo]
    );

    if (existingReport.rows.length > 0) {
      return res.status(400).json({ error: "You can only report this user one time only" });
    }

    // Upload the file to S3
    const fileContent = req.file?.buffer; // Get file content from memory
    const fileName = req.file ? `${Date.now()}-${req.file.originalname}` : null;
    let screenshotUrl = null;

    if (fileContent && fileName) {
      const params = {
        Bucket: "legitprove-scam-uploads", // S3 bucket name
        Key: fileName, // File name to save in S3
        Body: fileContent,
        ContentType: req.file.mimetype, // Set the MIME type of the file
      };

      const uploadResult = await s3.upload(params).promise();
      screenshotUrl = uploadResult.Location; // S3 URL of the uploaded file
    }

    // Save the report to PostgreSQL
    const result = await pool.query(
      `INSERT INTO scam_reports 
        (platform, username, contact_info, incident_type, description, date_time, payment_details, victim_email, screenshot_path, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        platform,
        username,
        contactInfo,
        incidentType,
        description,
        dateTime,
        paymentDetails,
        victimEmail,
        screenshotUrl, // Save the S3 URL to DB
        userId, // Associate the report with the user
      ]
    );

    res.status(201).json({ success: true, reportId: result.rows[0].id });
  } catch (error) {
    console.error("Error inserting report:", error);
    res.status(500).json({ error: "Server error while submitting report" });
  }
});

app.get("/reports", async (req, res) => {
  const { userId } = req.query; // Extract userId from query parameters

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT username, platform, incident_type, description, date_time 
       FROM scam_reports 
       WHERE user_id = $1 
       ORDER BY date_time DESC`,
      [userId] // Filter reports by userId
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching scam reports:", error);
    res.status(500).json({ error: "Server error while fetching scam reports" });
  }
});

// Search reports by username
app.get("/reports/search", async (req, res) => {
  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: "Username query parameter is required" });
  }

  try {
    const result = await pool.query(
      "SELECT username, platform, incident_type AS \"incidentType\" FROM scam_reports WHERE username ILIKE $1 LIMIT 10",
      [`%${username}%`]
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error searching reports:", error);
    res.status(500).json({ error: "Server error while searching reports" });
  }
});

// Fetch detailed report by username
app.get("/reports/details", async (req, res) => {
  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: "Username query parameter is required" });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, platform, incident_type AS "incidentType", description, date_time AS "dateTime", 
              contact_info AS "contactInfo", victim_email AS "victimEmail"
       FROM scam_reports WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Report not found" });
    }

    res.status(200).json(result.rows[0]); // Include the id field in the response
  } catch (error) {
    console.error("Error fetching report details:", error);
    res.status(500).json({ error: "Server error while fetching report details" });
  }
});

// Add like or dislike to a report
app.post("/reports/reaction", async (req, res) => {
  const { reportId, userId, reaction } = req.body; // reaction: 'like' or 'dislike'

  console.log("Received reaction payload:", { reportId, userId, reaction });

  if (!reportId || !userId || !reaction) {
    console.error("Missing required fields:", { reportId, userId, reaction });
    return res.status(400).json({ error: "Required fields are missing" });
  }

  try {
    // Validate the user exists in the user database
    const userResult = await userPool.query("SELECT id FROM users WHERE id = $1", [userId]);
    if (userResult.rows.length === 0) {
      console.error("User not found:", userId);
      return res.status(404).json({ error: "User not found" });
    }

    // Check if the user already reacted to this report
    const existingReaction = await pool.query(
      "SELECT id, reaction FROM report_reactions WHERE report_id = $1 AND user_id = $2",
      [reportId, userId]
    );

    if (existingReaction.rows.length > 0) {
      if (existingReaction.rows[0].reaction === reaction) {
        // If the same reaction is clicked again, remove it
        await pool.query("DELETE FROM report_reactions WHERE id = $1", [
          existingReaction.rows[0].id,
        ]);
        return res.status(200).json({ message: "Reaction removed" });
      } else {
        // Update the reaction if it's different
        await pool.query(
          "UPDATE report_reactions SET reaction = $1 WHERE id = $2",
          [reaction, existingReaction.rows[0].id]
        );
        return res.status(200).json({ message: "Reaction updated" });
      }
    }

    // Add a new reaction
    await pool.query(
      "INSERT INTO report_reactions (report_id, user_id, reaction) VALUES ($1, $2, $3)",
      [reportId, userId, reaction]
    );
    res.status(201).json({ message: "Reaction added" });
  } catch (error) {
    console.error("Error handling reaction:", error);
    res.status(500).json({ error: "Server error while handling reaction" });
  }
});

// Get like and dislike counts for a report
app.get("/reports/reaction-counts", async (req, res) => {
  const { reportId } = req.query;

  if (!reportId) {
    return res.status(400).json({ error: "Report ID is required" });
  }

  try {
    const result = await pool.query(
      `SELECT 
         SUM(CASE WHEN reaction = 'like' THEN 1 ELSE 0 END) AS likes,
         SUM(CASE WHEN reaction = 'dislike' THEN 1 ELSE 0 END) AS dislikes
       FROM report_reactions WHERE report_id = $1`,
      [reportId]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching reaction counts:", error);
    res.status(500).json({ error: "Server error while fetching reaction counts" });
  }
});

// Fetch user's reaction for a specific report
app.get("/reports/user-reaction", async (req, res) => {
  const { reportId, userId } = req.query;

  if (!reportId || !userId) {
    return res.status(400).json({ error: "Report ID and User ID are required" });
  }

  try {
    const result = await pool.query(
      "SELECT reaction FROM report_reactions WHERE report_id = $1 AND user_id = $2",
      [reportId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ reaction: null });
    }

    res.status(200).json({ reaction: result.rows[0].reaction });
  } catch (error) {
    console.error("Error fetching user reaction:", error);
    res.status(500).json({ error: "Server error while fetching user reaction" });
  }
});

// Get top liked scam reports
app.get("/reports/top-liked", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         scam_reports.id AS id, username, platform, 
         SUM(CASE WHEN reaction = 'like' THEN 1 ELSE 0 END) AS likes
       FROM scam_reports
       LEFT JOIN report_reactions ON scam_reports.id = report_reactions.report_id
       GROUP BY scam_reports.id
       ORDER BY likes DESC
       LIMIT 10`
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching top liked reports:", error);
    res.status(500).json({ error: "Server error while fetching top liked reports" });
  }
});

app.use("/payments", paymentsRoutes); // Mount payments routes
app.use(profileRoutes); // Add profile routes
app.use(signupRoutes); // Mount signup API routes

// Start the chat server
exec("node chatting.js", (error, stdout, stderr) => {
  if (error) {
    console.error(`Error starting chat server: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`Chat server stderr: ${stderr}`);
    return;
  }
  console.log(`Chat server stdout: ${stdout}`);
});

// Start the signup server
exec('node signup.js', (error, stdout, stderr) => {
  if (error) {
    console.error(`Error starting signup server: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`Signup server stderr: ${stderr}`);
    return;
  }
  console.log(`Signup server stdout: ${stdout}`);
});

app.get("/", (req, res) => {
  res.send("Server is working!");
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});


require("dotenv").config(); // Load environment variables
const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const AWS = require("aws-sdk");

const router = express.Router();

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

// Update Profile API
router.post("/api/update-profile", upload.single("profilePhoto"), async (req, res) => {
  const { id, firstName, lastName } = req.body; // Extract user data from request body
  const profilePhoto = req.file;

  try {
    let profilePhotoUrl = null;

    if (profilePhoto) {
      profilePhotoUrl = await uploadToS3(profilePhoto); // Upload new profile photo to S3
    }

    // Update user data in the database
    const query = `
      UPDATE users
      SET first_name = $1, last_name = $2, profile_photo = COALESCE($3, profile_photo)
      WHERE id = $4
      RETURNING id, email, first_name AS "firstName", last_name AS "lastName", profile_photo AS "profilePhoto";
    `;
    const values = [firstName, lastName, profilePhotoUrl, id];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // Return updated user data
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error updating profile:", error);
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});

module.exports = router;

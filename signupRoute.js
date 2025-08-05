// signupRoute.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const sendSignupEmail = require('./sendEmail'); // adjust path as needed

const router = express.Router();

// File upload config (if you're saving profile photos)
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/api/signup', upload.single('profilePhoto'), async (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  try {
    // TODO: Save user to database
    // await User.create({ firstName, lastName, email, password });

    // Send confirmation/welcome email
    await sendSignupEmail(email, `${firstName} ${lastName}`);

    return res.status(201).json({ message: 'Signup successful. Check your email for confirmation.' });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ message: 'Signup failed. Please try again.' });
  }
});

module.exports = router;

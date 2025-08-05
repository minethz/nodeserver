const express = require('express');
const cors = require('cors');
const signupRoute = require('./signupRoute');
const OpenAI = require("openai");

require('dotenv').config();

const app = express();
const PORT = 5002;

app.use(cors());
app.use(express.json());
app.use(signupRoute); // mount signup route



app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

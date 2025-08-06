require("dotenv").config(); // Load environment variables
const axios = require('axios');

const apiKey = process.env.BREVO_API_KEY;

const sendSignupEmail = async (toEmail, userName, verificationCode) => {
  const emailData = {
    sender: {
      name: 'Legit Prove',
      email: 'no-reply@legitprove.com',
    },
    to: [{ email: toEmail, name: userName }],
    subject: 'Verify Your Email - Legit Prove',
    htmlContent: `
      <h1>Hello ${userName},</h1>
      <p>Thanks for signing up with us! Please use the following code to verify your email:</p>
      <h2>${verificationCode}</h2>
      <p>This code is valid for 1 minute.</p>
    `,
  };

  try {
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', emailData, {
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    console.log('Signup email sent!', response.data);
  } catch (error) {
    console.error('Signup email failed:', error.response?.data || error.message);
  }
};

const sendResetPasswordEmail = async (toEmail, userName, resetLink) => {
  const emailData = {
    sender: {
      name: 'Legit Prove Support',
      email: 'no-reply@legitprove.com',
    },
    to: [{ email: toEmail, name: userName }],
    subject: 'Reset Your Password - Legit Prove',
    htmlContent: `
      <p>Hello ${userName},</p>
      <p>You requested to reset your password. Click the link below to proceed:</p>
      <a href="${resetLink}">${resetLink}</a>
      <p>This link will expire in 15 minutes.</p>
    `,
  };

  try {
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', emailData, {
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    console.log('Reset password email sent!', response.data);
  } catch (error) {
    console.error('Reset password email failed:', error.response?.data || error.message);
  }
};

const sendMiddlemanEmail = async (toEmail, role, category, price, currency, actionLink, confirmationCode = null) => {
  const emailData = {
    sender: {
      name: 'Legit Prove Middleman Service',
      email: 'no-reply@legitprove.com',
    },
    to: [{ email: toEmail }],
    subject: `Middleman Service Details - ${role}`,
    htmlContent: `
      <h1>Hello ${role},</h1>
      <p>The middleman service has been initiated for the following details:</p>
      <ul>
        <li>Category: ${category}</li>
        <li>Price: ${currency} ${price}</li>
      </ul>
      ${confirmationCode ? `<p>Your confirmation code is: <strong>${confirmationCode}</strong></p>` : ""}
      <p>Please follow the link below to proceed with your action:</p>
      <a href="${actionLink}">${actionLink}</a>
      <p>Thank you for using Legit Prove's Middleman Service!</p>
    `,
  };

  try {
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', emailData, {
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    console.log('Middleman email sent!', response.data);
  } catch (error) {
    console.error('Middleman email failed:', error.response?.data || error.message);
  }
};

module.exports = {
  sendSignupEmail,
  sendResetPasswordEmail,
  sendMiddlemanEmail,
};

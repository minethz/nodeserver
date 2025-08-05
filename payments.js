require("dotenv").config(); // Load environment variables
const express = require("express");
const cors = require("cors"); // Import CORS middleware
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY); // Updated secret key

const app = express();
app.use(cors({ origin: "https://nodeserver-production-982a.up.railway.app" })); // Ensure CORS allows requests from frontend

const router = express.Router();

// Create a payment intent
router.post("/create-payment-intent", async (req, res) => {
  const { amount } = req.body;

  if (!amount || isNaN(amount)) { // Validate amount
    console.error("Invalid or missing amount in request body");
    return res.status(400).json({ error: "Valid amount is required" });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: "usd",
      payment_method_types: ["card"],
    });

    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error("Error creating payment intent:", error.message);
    res.status(500).json({ error: "Failed to create payment intent. Please check your Stripe configuration." });
  }
});

// Confirm payment success or failure
router.post("/confirm-payment", async (req, res) => {
  const { paymentIntentId } = req.body;

  if (!paymentIntentId) {
    console.error("Payment Intent ID is missing in request body");
    return res.status(400).json({ error: "Payment Intent ID is required" });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === "succeeded") {
      res.status(200).json({ success: true, message: "Payment successful" });
    } else {
      console.error(`Payment failed with status: ${paymentIntent.status}`);
      res.status(400).json({ success: false, message: "Payment failed or incomplete" });
    }
  } catch (error) {
    console.error("Error confirming payment:", error.message);
    res.status(500).json({ error: "Failed to confirm payment" });
  }
});

app.use("/payments", router);

module.exports = router; // Export router for use in server.js

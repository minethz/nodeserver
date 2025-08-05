require("dotenv").config(); // Load environment variables
const axios = require('axios');

async function createPayment() {
  const response = await axios.post('https://paykassma.com/api/0/create', {
    shop: process.env.PAYKASSAMA_SHOP_ID,
    amount: 100, // example amount
    currency: 'USD',
    order_id: 'order123',
    payway: 'perfectmoney', // example payment method
    api_password: process.env.PAYKASSAMA_API_PASSWORD
  });

  console.log(response.data);
}

createPayment();

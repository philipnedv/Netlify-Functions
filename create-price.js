// create-price.js

// Load environment variables from .env file
require('dotenv').config();

// Initialize Stripe with your secret key from environment variables
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function createPrice() {
  try {
    // Create a recurring price (subscription)
    const price = await stripe.prices.create({
      currency: 'gbp',
      unit_amount: 1799, // Amount in cents ($10.00)
      recurring: {
        interval: 'month',
      },
      product_data: {
        name: 'Membership',
      },
    });

    console.log('Price created successfully:', price);
  } catch (error) {
    console.error('Error creating price:', error);
  }
}

createPrice();

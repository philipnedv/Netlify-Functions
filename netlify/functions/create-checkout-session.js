// create-checkout-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  // Allow only POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse the request body to get the Clerk user ID and optionally the user email
    const { clerkUserId, userEmail, sessionId } = JSON.parse(event.body);
    
    // Use the provided sessionId for idempotency, or generate one if not provided
    const idempotencyKey = sessionId || `checkout_${clerkUserId}_${Date.now()}`;

    // Create a Stripe Checkout Session in subscription mode
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: userEmail,
      success_url: process.env.SUCCESS_URL || 'https://yourdomain.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: process.env.CANCEL_URL || 'https://yourdomain.com/cancel',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID || 'price_YourRecurringPriceId',
          quantity: 1,
        },
      ],
      metadata: {
        clerkUserId: clerkUserId,
      },
    }, {
      idempotencyKey: idempotencyKey, // Add idempotency key to prevent duplicate sessions
    });

    // Return the session ID with CORS headers for browser compatibility
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Or specify your domain
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify({ id: session.id }),
    };
  } catch (error) {
    console.error('Error creating checkout session:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify({ error: 'Failed to create checkout session' }),
    };
  }
};

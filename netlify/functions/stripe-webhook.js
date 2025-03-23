// stripe-webhook.js

// Load environment variables from the .env file
require('dotenv').config();

// Import required libraries
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
console.log('axiosRetry:', axiosRetry);

// Configure axios with retry logic
axiosRetry(axios, { 
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    // Retry on network errors or 5xx responses
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
           (error.response && error.response.status >= 500);
  }
});

/**
 * Structured logger function
 */
const log = (level, message, context = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = JSON.stringify({
    timestamp,
    level,
    message,
    ...context
  });
  
  if (level === 'error') {
    console.error(logEntry);
  } else {
    console.log(logEntry);
  }
};

/**
 * updateClerkUser - Function to update Clerk user metadata.
 *
 * @param {string} clerkUserId - The Clerk user ID from Stripe metadata.
 * @param {object} updateData - The data you want to update on the Clerk user.
 */
const updateClerkUser = async (clerkUserId, updateData) => {
  try {
    log('info', 'Updating Clerk user', { clerkUserId, updateData });
    
    // Wrap updateData inside public_metadata for updating Clerk
    const response = await axios.patch(
      `https://api.clerk.com/v1/users/${clerkUserId}`,
      {
        public_metadata: updateData,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.CLERK_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `clerk_update_${clerkUserId}_${Date.now()}`
        },
      }
    );
    
    log('info', `Successfully updated Clerk user ${clerkUserId}`, { 
      userId: clerkUserId,
      responseStatus: response.status
    });
    
    return response.data;
  } catch (error) {
    log('error', 'Error updating Clerk user', { 
      clerkUserId, 
      errorMessage: error.response ? error.response.data : error.message,
      stack: error.stack
    });
    throw error;
  }
};

exports.handler = async (event, context) => {
  // Handle OPTIONS requests for CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Or specify your domain
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
      },
      body: 'Method Not Allowed',
    };
  }

  let stripeEvent;
  try {
    // Verify the event with Stripe's webhook secret (your signing secret)
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
      },
      body: `Webhook Error: ${err.message}`,
    };
  }

  const eventType = stripeEvent.type;
  const dataObject = stripeEvent.data.object;
  // Detailed logging for debugging purposes
  console.log(`Received event: ${eventType}`);
  console.log('Event data:', JSON.stringify(dataObject, null, 2));

  // Extract the Clerk user ID from the Stripe metadata (if set)
  const clerkUserId = dataObject.metadata && dataObject.metadata.clerkUserId;

  try {
    // Process different event types
    switch (eventType) {
      case 'checkout.session.completed':
        console.log('Processing checkout.session.completed');
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { paid: true });
        }
        break;
      case 'checkout.session.expired':
        console.log('Processing checkout.session.expired');
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { paid: false });
        }
        break;
      case 'customer.subscription.created':
        console.log('Processing customer.subscription.created');
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { subscriptionActive: true });
        }
        break;
      case 'customer.subscription.deleted':
        console.log('Processing customer.subscription.deleted');
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { subscriptionActive: false });
        }
        break;
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        console.log('Processing invoice.paid/invoice.payment_succeeded');
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { paid: true });
        }
        break;
      case 'invoice.payment_failed':
        console.log('Processing invoice.payment_failed');
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { paid: false });
        }
        break;
      default:
        console.log(`Unhandled event type: ${eventType}`);
    }

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
      },
      body: 'Event processed successfully',
    };
  } catch (error) {
    console.error('Error processing event:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
      },
      body: 'Internal Server Error',
    };
  }
};

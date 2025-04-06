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

/**
 * getClerkUser - Function to retrieve current Clerk user metadata.
 */
const getClerkUser = async (clerkUserId) => {
  try {
    const response = await axios.get(
      `https://api.clerk.com/v1/users/${clerkUserId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.CLERK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching Clerk user:', error);
    throw error;
  }
};

/**
 * updateClerkUserMerged - Merges new updateData with existing metadata to prevent overwriting fields.
 */
const updateClerkUserMerged = async (clerkUserId, updateData) => {
  try {
    const currentUser = await getClerkUser(clerkUserId);
    const currentMetadata = currentUser.public_metadata || {};
    // Merge current metadata with updateData (updateData takes precedence)
    const newMetadata = { ...currentMetadata, ...updateData };
    return await updateClerkUser(clerkUserId, newMetadata);
  } catch (error) {
    console.error('Error updating Clerk user (merged):', error);
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
    switch (eventType) {
      // Paid events: Overwrite metadata with just the paid flag (removing any expiration date)
      case 'checkout.session.completed':
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        console.log(`Processing ${eventType}`);
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { paid: true, subscriptionEndDate: null });
        }
        break;
      // Payment failure events: Revoke access immediately
      case 'invoice.payment_failed':
      case 'checkout.session.expired':
        console.log(`Processing ${eventType}`);
        if (clerkUserId) {
          await updateClerkUser(clerkUserId, { paid: false, subscriptionEndDate: null });
        }
        break;
        
      // Handle subscription updates (including cancellations)
      case 'customer.subscription.updated':
        console.log('Processing customer.subscription.updated');
        console.log('Full subscription object:', JSON.stringify(dataObject, null, 2));
        
        if (clerkUserId) {
          // Check if the subscription was canceled (status remains active but cancel_at_period_end becomes true)
          if (dataObject.cancel_at_period_end === true) {
            const currentTime = Math.floor(Date.now() / 1000);
            
            // Only set subscriptionEndDate if current_period_end is in the future
            if (dataObject.current_period_end && dataObject.current_period_end > currentTime) {
              console.log(`Subscription was canceled but remains active until ${new Date(dataObject.current_period_end * 1000).toISOString()}`);
              // Set the subscription end date to current_period_end
              await updateClerkUserMerged(clerkUserId, { 
                subscriptionEndDate: dataObject.current_period_end,
                paid: true // Keep access until the end date
              });
            } else {
              console.log('Subscription was canceled and period has already ended');
              await updateClerkUser(clerkUserId, { 
                paid: false,
                subscriptionEndDate: null
              });
            }
          } 
          // If subscription is active and not canceled at period end, just use the paid flag
          else if (dataObject.status === 'active' && !dataObject.cancel_at_period_end) {
            console.log('Subscription is active and not scheduled for cancellation');
            await updateClerkUser(clerkUserId, { 
              paid: true,
              subscriptionEndDate: null // Remove any end date
            });
          }
          // If subscription is not active, revoke access
          else if (dataObject.status !== 'active') {
            console.log(`Subscription status changed to: ${dataObject.status}`);
            await updateClerkUser(clerkUserId, { 
              paid: false,
              subscriptionEndDate: null
            });
          }
        }
        break;
        
      // Subscription deleted: Immediately revoke access
      case 'customer.subscription.deleted':
        console.log('Processing customer.subscription.deleted');
        if (clerkUserId) {
          console.log('Subscription fully deleted, revoking access');
          await updateClerkUser(clerkUserId, { 
            subscriptionEndDate: null, 
            paid: false 
          });
        }
        break;
      // Unhandled events
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

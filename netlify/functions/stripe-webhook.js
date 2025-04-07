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
const updateClerkUser = async (clerkUserId, updateData, requestId) => {
  try {
    log('info', 'Updating Clerk user', { clerkUserId, updateData, requestId });
    
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
        timeout: 10000 // 10 second timeout
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
  // Generate a unique request ID for tracking this webhook event
  const requestId = `webhook_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  
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
    log('error', 'Webhook signature verification failed', { 
      requestId, 
      error: err.message 
    });
    return {
      statusCode: 400,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
        'X-Request-ID': requestId
      },
      body: `Webhook Error: ${err.message}`,
    };
  }

  const eventType = stripeEvent.type;
  const dataObject = stripeEvent.data.object;
  
  // Extract the Clerk user ID from the Stripe metadata (if set)
  const clerkUserId = dataObject.metadata && dataObject.metadata.clerkUserId;
  
  // Detailed logging for debugging purposes
  log('info', `Received event: ${eventType}`, { 
    requestId, 
    eventId: stripeEvent.id,
    objectId: dataObject.id,
    clerkUserId: clerkUserId || 'not_found'
  });
  
  // More detailed logging can be done at debug level
  log('debug', 'Event data details', {
    requestId,
    eventData: JSON.stringify(dataObject, null, 2)
  });

  try {
    switch (eventType) {
      // Handle invoice creation to add metadata
      case 'invoice.created':
        log('info', 'Processing invoice.created', { requestId });
        // If invoice doesn't have clerkUserId in metadata but has a customer
        if (!clerkUserId && dataObject.customer) {
          try {
            // Get the customer to find the clerkUserId
            const customer = await stripe.customers.retrieve(dataObject.customer);
            const customerClerkUserId = customer.metadata && customer.metadata.clerkUserId;
            
            if (customerClerkUserId) {
              log('info', `Adding clerkUserId to invoice`, { 
                requestId, 
                clerkUserId: customerClerkUserId, 
                invoiceId: dataObject.id 
              });
              // Update the invoice with the clerkUserId from the customer
              await stripe.invoices.update(dataObject.id, {
                metadata: {
                  clerkUserId: customerClerkUserId
                }
              });
              log('info', `Successfully updated invoice with clerkUserId metadata`, { 
                requestId, 
                invoiceId: dataObject.id 
              });
            } else {
              log('info', `Customer has no clerkUserId in metadata`, { 
                requestId, 
                customerId: dataObject.customer 
              });
            }
          } catch (err) {
            log('error', 'Error updating invoice metadata', { 
              requestId, 
              invoiceId: dataObject.id,
              error: err.message,
              stack: err.stack
            });
          }
        }
        break;
        
      // Payment confirmation events: set the paid flag based on definitive invoice payment events
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        log('info', `Processing ${eventType}`, { requestId });
        let effectiveClerkUserId;
        // Check if invoice metadata already has a clerkUserId
        if (!dataObject.metadata || !dataObject.metadata.clerkUserId) {
          // If not, and we have a customer ID, retrieve the customer to get the Clerk user ID
          if (dataObject.customer) {
            try {
              const customer = await stripe.customers.retrieve(dataObject.customer);
              effectiveClerkUserId = customer.metadata && customer.metadata.clerkUserId;
              if (effectiveClerkUserId) {
                log('info', `Appending clerkUserId to invoice`, { 
                  requestId, 
                  clerkUserId: effectiveClerkUserId, 
                  invoiceId: dataObject.id 
                });
                // Update the invoice with the clerkUserId from the customer
                await stripe.invoices.update(dataObject.id, {
                  metadata: { clerkUserId: effectiveClerkUserId }
                });
                log('info', `Successfully appended clerkUserId to invoice`, { 
                  requestId, 
                  invoiceId: dataObject.id 
                });
              }
            } catch (err) {
              log('error', `Error retrieving customer for invoice`, { 
                requestId, 
                invoiceId: dataObject.id, 
                error: err.message,
                stack: err.stack
              });
            }
          }
        } else {
          effectiveClerkUserId = dataObject.metadata.clerkUserId;
          log('info', `Using existing clerkUserId from invoice metadata`, { 
            requestId, 
            clerkUserId: effectiveClerkUserId 
          });
        }
        if (effectiveClerkUserId) {
          // Now update the backend to mark the user as paid
          await updateClerkUser(effectiveClerkUserId, { paid: true, subscriptionEndDate: null }, requestId);
        }
        break;
      }
        
      // Payment failure events: revoke access immediately
      case 'invoice.payment_failed':
      case 'checkout.session.expired': {
        console.log(`Processing ${eventType}`);
        let effectiveClerkUserId;
        // Check if invoice metadata already has a clerkUserId
        if (!dataObject.metadata || !dataObject.metadata.clerkUserId) {
          if (dataObject.customer) {
            try {
              const customer = await stripe.customers.retrieve(dataObject.customer);
              effectiveClerkUserId = customer.metadata && customer.metadata.clerkUserId;
              if (effectiveClerkUserId) {
                console.log(`Appending clerkUserId ${effectiveClerkUserId} to invoice ${dataObject.id}`);
                await stripe.invoices.update(dataObject.id, {
                  metadata: { clerkUserId: effectiveClerkUserId }
                });
                console.log(`Successfully appended clerkUserId to invoice ${dataObject.id}`);
              }
            } catch (err) {
              console.error(`Error retrieving customer for invoice ${dataObject.id}:`, err);
            }
          }
        } else {
          effectiveClerkUserId = dataObject.metadata.clerkUserId;
          console.log(`Using existing clerkUserId ${effectiveClerkUserId} from invoice metadata`);
        }
        if (effectiveClerkUserId) {
          // Update the backend to mark the user as not paid
          await updateClerkUser(effectiveClerkUserId, { paid: false, subscriptionEndDate: null });
        }
        break;
      }
        
      // Handle subscription updates (including cancellations)
      case 'customer.subscription.updated':
        console.log('Processing customer.subscription.updated');
        console.log('Full subscription object:', JSON.stringify(dataObject, null, 2));
        console.log('Subscription status:', dataObject.status);
        console.log('Cancel at period end:', dataObject.cancel_at_period_end);
        console.log('Current period end:', dataObject.current_period_end);
        
        if (clerkUserId) {
          // Check if the subscription was canceled (status remains active but cancel_at_period_end becomes true)
          if (dataObject.cancel_at_period_end === true) {
            const currentTime = Math.floor(Date.now() / 1000);
            console.log('Current time:', currentTime);
            
            // Only set subscriptionEndDate if current_period_end is in the future
            if (dataObject.current_period_end && dataObject.current_period_end > currentTime) {
              console.log(`Subscription was canceled but remains active until ${new Date(dataObject.current_period_end * 1000).toISOString()}`);
              // Set the subscription end date to current_period_end
              await updateClerkUserMerged(clerkUserId, { 
                subscriptionEndDate: dataObject.current_period_end,
                paid: true // Keep access until the end date
              });
              console.log('Updated user metadata with subscription end date');
            } else {
              console.log('Subscription was canceled and period has already ended');
              await updateClerkUser(clerkUserId, { 
                paid: false,
                subscriptionEndDate: null
              });
              console.log('Revoked access immediately as period has ended');
            }
          } 
          // If subscription is active and not scheduled for cancellation, mark as paid
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
        'X-Request-ID': requestId
      },
      body: JSON.stringify({ 
        message: 'Event processed successfully',
        requestId
      }),
    };
  } catch (error) {
    log('error', 'Error processing event', { 
      requestId, 
      eventType,
      errorMessage: error.message,
      stack: error.stack
    });
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
        'X-Request-ID': requestId
      },
      body: JSON.stringify({
        error: 'Internal Server Error',
        requestId
      }),
    };
  }
};

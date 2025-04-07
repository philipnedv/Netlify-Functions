// create-checkout-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Define logging helper
const log = (level, message, data = {}) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  }));
};

exports.handler = async (event) => {
  const requestId = event.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  log('info', `Processing request ${requestId}`);
  
  // Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  // Allow only POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse the request body to get the Clerk user ID and optionally the user email
    const { clerkUserId, userEmail, sessionId } = JSON.parse(event.body);
    
    // Validate required parameters
    if (!clerkUserId || !userEmail) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Missing required parameters: clerkUserId and userEmail are required' })
      };
    }
    
    log('info', 'Creating checkout session', { clerkUserId, email: userEmail, requestId });
    
    // Use the provided sessionId for idempotency, or generate one if not provided
    const idempotencyKey = sessionId || `checkout_${clerkUserId}_${Date.now()}`;

    // First, create or retrieve a customer with the clerkUserId in metadata
    let customer;
    try {
      // Try to find an existing customer with this email
      const customers = await stripe.customers.list({
        email: userEmail,
        limit: 1
      });
      
      if (customers.data.length > 0) {
        const existingCustomer = customers.data[0];
        
        // Only update if the clerkUserId is missing or different
        if (!existingCustomer.metadata?.clerkUserId || existingCustomer.metadata.clerkUserId !== clerkUserId) {
          customer = await stripe.customers.update(
            existingCustomer.id,
            { metadata: { clerkUserId } }
          );
          log('info', `Updated existing customer`, { customerId: customer.id, clerkUserId, requestId });
        } else {
          customer = existingCustomer;
          log('info', `Customer already has correct clerkUserId`, { customerId: customer.id, clerkUserId: customer.metadata.clerkUserId, requestId });
        }
      } else {
        // Create a new customer with the clerkUserId in metadata
        customer = await stripe.customers.create({
          email: userEmail,
          metadata: { clerkUserId }
        });
        log('info', `Created new customer`, { customerId: customer.id, requestId });
      }
    } catch (error) {
      log('error', 'Error creating/updating customer', { error: error.message, requestId });
      throw error;
    }

    // Create a Stripe Checkout Session with retry logic
    let session;
    let retries = 3;
    
    while (retries > 0) {
      try {
        session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customer.id,
          success_url: process.env.SUCCESS_URL || 'https://yourdomain.com/success?session_id={CHECKOUT_SESSION_ID}',
          cancel_url: process.env.CANCEL_URL || 'https://yourdomain.com/cancel',
          line_items: [
            {
              price: process.env.STRIPE_PRICE_ID || 'price_YourRecurringPriceId',
              quantity: 1,
            },
          ],
          subscription_data: {
            metadata: {
              clerkUserId: clerkUserId,
            },
          },
          metadata: {
            clerkUserId: clerkUserId,
          },
        }, {
          idempotencyKey: idempotencyKey,
        });
        log('info', 'Created checkout session successfully', { sessionId: session.id, requestId });
        break; // Success, exit the loop
      } catch (error) {
        retries--;
        if (retries === 0) throw error; // Re-throw if all retries failed
        log('warn', `Stripe API error, retrying`, { retriesLeft: retries, error: error.message, requestId });
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }
    
    // Return the session ID with CORS headers for browser compatibility
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'X-Request-ID': requestId
      },
      body: JSON.stringify({ id: session.id, requestId }),
    };
  } catch (error) {
    log('error', 'Error creating checkout session', { error: error.message, stack: error.stack, requestId });
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'X-Request-ID': requestId
      },
      body: JSON.stringify({ error: 'Failed to create checkout session', requestId }),
    };
  }
};

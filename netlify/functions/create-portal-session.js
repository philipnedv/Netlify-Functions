// create-portal-session.js

// Load environment variables
require('dotenv').config();

// Import required libraries
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

/**
 * getClerkUser - Function to retrieve Clerk user data by ID
 */
const getClerkUser = async (userId) => {
  try {
    const response = await axios.get(
      `https://api.clerk.com/v1/users/${userId}`,
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
 * Handler for creating a Stripe Customer Portal session
 */
exports.handler = async (event, context) => {
  // Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
      body: '',
    };
  }

  // Accept both GET and POST requests
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'Method Not Allowed',
    };
  }

  try {
    // Get the Clerk user ID from query parameters or request body
    let clerkUserId;
    
    if (event.httpMethod === 'GET') {
      clerkUserId = event.queryStringParameters?.userId;
      console.log('GET request with userId:', clerkUserId);
    } else {
      // For POST requests, parse the body
      const body = JSON.parse(event.body || '{}');
      clerkUserId = body.userId;
      console.log('POST request with userId:', clerkUserId);
    }
    
    if (!clerkUserId) {
      console.log('No userId found in request:', event);
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'User ID is required' }),
      };
    }

    // Get the Clerk user data using the server-side API key
    console.log('Fetching Clerk user with ID:', clerkUserId);
    const clerkUser = await getClerkUser(clerkUserId);
    
    if (!clerkUser) {
      return {
        statusCode: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'User not found' }),
      };
    }

    // Find the Stripe customer ID associated with this user
    const customers = await stripe.customers.list({
      limit: 1,
      email: clerkUser.email_addresses[0].email_address
    });

    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      console.log(`Using existing customer ${customerId}, updating metadata with clerkUserId: ${clerkUserId}`);
      
      // Update the existing customer with the Clerk user ID
      await stripe.customers.update(customerId, {
        metadata: {
          clerkUserId: clerkUserId
        }
      });
      console.log('Customer metadata updated successfully');
    } else {
      // If no customer exists, create one
      const newCustomer = await stripe.customers.create({
        email: clerkUser.email_addresses[0].email_address,
        metadata: {
          clerkUserId: clerkUser.id
        }
      });
      customerId = newCustomer.id;
      console.log(`Created new customer with ID: ${customerId}`);
    }

    // Create a Stripe Customer Portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.APP_URL || 'https://cosmic-salamander-18640e.netlify.app/',
    });

    // Return the URL instead of redirecting
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (error) {
    console.error('Error creating portal session:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal server error', details: error.message }),
    };
  }
};
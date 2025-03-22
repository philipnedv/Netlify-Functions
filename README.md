# Netlify Serverless Functions

This repository contains serverless functions for deployment on Netlify.

## Functions

- `hello-world.js`: A simple function that returns a "Hello World" message.

## Local Development

To run the functions locally, install the Netlify CLI:

```bash
npm install netlify-cli -g
```

Then start the local development server:

```bash
netlify dev
```

## Deploying to Netlify

Follow these steps to deploy your functions to Netlify:

1. **Create a Netlify account** - Sign up at [netlify.com](https://www.netlify.com/) if you don't have an account.

2. **Connect to GitHub** - In the Netlify dashboard:
   - Click "New site from Git"
   - Select GitHub as your Git provider
   - Authorize Netlify to access your GitHub account
   - Select your repository

3. **Configure build settings**:
   - Build command: Leave empty (or use `npm run build` if you add a build step later)
   - Publish directory: `public`
   - Netlify will automatically detect your `netlify.toml` file and use the settings there

4. **Deploy your site** - Click "Deploy site"

Once deployed, your function will be available at:
`https://your-site-name.netlify.app/.netlify/functions/hello-world`

## Environment Variables

To add environment variables:
1. Go to Site settings > Build & deploy > Environment
2. Add your variables there

For local development, you can create a `.env` file (which is git-ignored).
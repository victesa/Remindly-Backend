const functions = require('@google-cloud/functions-framework');
const axios = require('axios');

const CLIENT_ID = process.env.CF_CLIENT_ID;
const CLIENT_SECRET = process.env.CF_CLIENT_SECRET;
const TARGET_URL = 'https://remindly-backend-v2.victorkirui-dev.workers.dev/v1/billing/rtdn';

functions.http('forwardToCloudflare', async (req, res) => {
  try {
    const response = await axios.post(TARGET_URL, req.body, {
      headers: {
        'Content-Type': 'application/json',
        'CF-Access-Client-Id': CLIENT_ID,
        'CF-Access-Client-Secret': CLIENT_SECRET
      },
      timeout: 10000
    });
    res.status(response.status).send(response.data);
  } catch (error) {
    console.error('Error forwarding request:', error.message);
    res.status(error.response ? error.response.status : 500).send(error.message);
  }
});

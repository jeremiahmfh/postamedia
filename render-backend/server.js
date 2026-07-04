require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://postamedia.co.za',
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Yoco API Configuration
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_API_URL = 'https://payments.yoco.com/api/checkouts';
const YOCO_PAYOUT_URL = 'https://payments.yoco.com/v1/payouts';

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'PostaMedia backend is running' });
});

// Payment endpoint
app.post('/api/payment', async (req, res) => {
  try {
    const { amount, currency, userId, description, metadata = {} } = req.body;

    // Validate required fields
    if (!amount || !currency || !userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: amount, currency, userId' 
      });
    }

    console.log('Creating payment:', { amount, currency, userId });

    // Create checkout with Yoco
    const amountInCents = Math.round(amount * 100);
    const yocoResponse = await axios.post(YOCO_API_URL, {
      amount: amountInCents,
      currency: currency,
      success_url: 'https://postamedia.co.za/business/dashboard',
      cancel_url: 'https://postamedia.co.za/business/dashboard',
      metadata: {
        userId,
        ...metadata
      }
    }, {
      headers: {
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const checkoutData = yocoResponse.data;
    console.log('Yoco response:', checkoutData);

    res.json({
      success: true,
      checkoutUrl: checkoutData.redirectUrl,
      chargeId: checkoutData.id,
      transactionId: checkoutData.id
    });
  } catch (error) {
    console.error('Payment error:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: error.response?.data?.message || 'Failed to create payment session' 
    });
  }
});

// Withdrawal endpoint with Yoco payout API
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, currency, bankDetails } = req.body;

    // Validate required fields
    if (!userId || !amount || !currency || !bankDetails) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: userId, amount, currency, bankDetails' 
      });
    }

    // Validate bank details
    if (!bankDetails.accountNumber || !bankDetails.bankName || !bankDetails.accountHolder) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required bank details: accountNumber, bankName, accountHolder' 
      });
    }

    console.log('Processing withdrawal:', { userId, amount, currency, bankDetails });

    // Create payout with Yoco
    const amountInCents = Math.round(amount * 100);
    const yocoResponse = await axios.post(YOCO_PAYOUT_URL, {
      amount: amountInCents,
      currency: currency,
      beneficiary: {
        account_number: bankDetails.accountNumber,
        bank_name: bankDetails.bankName,
        account_holder: bankDetails.accountHolder,
        account_type: bankDetails.accountType || 'cheque'
      },
      metadata: {
        userId,
        withdrawalType: 'user_withdrawal'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const payoutData = yocoResponse.data;
    console.log('Yoco payout response:', payoutData);

    res.json({
      success: true,
      message: 'Withdrawal request processed successfully',
      withdrawalId: payoutData.id,
      payoutId: payoutData.id,
      status: payoutData.status
    });
  } catch (error) {
    console.error('Withdrawal error:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: error.response?.data?.message || 'Failed to process withdrawal request' 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

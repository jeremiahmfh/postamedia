require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://postamedia.co.za',
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Firebase Admin SDK initialization - commented out for testing
/*
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_API_URL = 'https://online.yoco.com/v1/charges';
const YOCO_PAYOUT_URL = 'https://online.yoco.com/v1/payouts';
*/

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'PostaMedia backend is running' });
});

// Payment endpoint - simplified for testing
app.post('/api/payment', async (req, res) => {
  try {
    const { amount, currency, userId, description, callbackUrl, metadata = {} } = req.body;

    // Validate required fields
    if (!amount || !currency || !userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: amount, currency, userId' 
      });
    }

    // Mock response for testing without Firebase/Yoco
    // In production, this would create a real Yoco checkout session with the callbackUrl
    const chargeId = `test_charge_${Date.now()}`;
    
    // If callbackUrl is provided, use it to construct the redirect URL
    if (callbackUrl) {
      const successUrl = `${callbackUrl}?success=true&charge_id=${chargeId}&amount=${amount}`;
      const cancelUrl = `${callbackUrl}?success=false&charge_id=${chargeId}&amount=${amount}`;
      
      res.json({
        success: true,
        checkoutUrl: successUrl, // For testing, directly redirect to callback with success
        chargeId: chargeId,
        transactionId: `test_transaction_${Date.now()}`
      });
    } else {
      res.json({
        success: true,
        checkoutUrl: 'https://online.yoco.com/checkout/test',
        chargeId: chargeId,
        transactionId: `test_transaction_${Date.now()}`
      });
    }
  } catch (error) {
    console.error('Error creating payment:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create payment session' 
    });
  }
});

// Create checkout session - simplified for testing
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { amount, currency, description, userId, metadata = {} } = req.body;

    // Validate required fields
    if (!amount || !currency || !userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: amount, currency, userId' 
      });
    }

    // Mock response for testing without Firebase/Yoco
    res.json({
      success: true,
      checkoutUrl: 'https://online.yoco.com/checkout/test',
      chargeId: 'test_charge_id',
      transactionId: 'test_transaction_id'
    });
  } catch (error) {
    console.error('Error creating checkout:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create checkout session' 
    });
  }
});

// Check payment status
app.get('/api/payment-status/:chargeId', async (req, res) => {
  try {
    const { chargeId } = req.params;

    const yocoResponse = await axios.get(`${YOCO_API_URL}/${chargeId}`, {
      headers: {
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`
      }
    });

    const paymentData = yocoResponse.data;

    res.json({
      success: true,
      status: paymentData.status,
      amount: paymentData.amount_in_cents / 100,
      currency: paymentData.currency
    });
  } catch (error) {
    console.error('Error checking payment status:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check payment status' 
    });
  }
});

// Request withdrawal
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

    // Check user's current balance
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    const currentBalance = userDoc.data().walletBalance || 0;

    if (currentBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient balance' 
      });
    }

    // Deduct amount from wallet balance
    await userRef.update({
      walletBalance: currentBalance - amount,
      lastWithdrawalAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create withdrawal record in Firestore
    const withdrawalRef = await db.collection('withdrawals').add({
      userId,
      amount,
      currency,
      bankDetails: {
        accountNumber: bankDetails.accountNumber,
        bankName: bankDetails.bankName,
        accountHolder: bankDetails.accountHolder,
        accountType: bankDetails.accountType || 'checking',
        branchCode: bankDetails.branchCode || ''
      },
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create wallet transaction record
    await db.collection('walletTransactions').add({
      userId,
      type: 'withdrawal',
      amount,
      currency,
      withdrawalId: withdrawalRef.id,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Process payout with Yoco (if Yoco supports payouts)
    try {
      const yocoPayoutResponse = await axios.post(YOCO_PAYOUT_URL, {
        amount_in_cents: Math.round(amount * 100),
        currency: currency,
        beneficiary: {
          account_number: bankDetails.accountNumber,
          bank_name: bankDetails.bankName,
          account_holder_name: bankDetails.accountHolder,
          account_type: bankDetails.accountType || 'checking',
          branch_code: bankDetails.branchCode || ''
        },
        reference: withdrawalRef.id,
        description: 'PostaMedia withdrawal'
      }, {
        headers: {
          'Authorization': `Bearer ${YOCO_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      // Update withdrawal with Yoco payout ID
      await withdrawalRef.update({
        yocoPayoutId: yocoPayoutResponse.data.id,
        status: 'processing'
      });

      res.json({
        success: true,
        withdrawalId: withdrawalRef.id,
        yocoPayoutId: yocoPayoutResponse.data.id,
        status: 'processing',
        message: 'Withdrawal request submitted successfully'
      });
    } catch (yocoError) {
      // If Yoco payout fails, still record the withdrawal as pending for manual processing
      console.error('Yoco payout error:', yocoError.response?.data || yocoError.message);
      
      await withdrawalRef.update({
        status: 'pending_manual',
        error: 'Yoco payout API not available, requires manual processing'
      });

      res.json({
        success: true,
        withdrawalId: withdrawalRef.id,
        status: 'pending_manual',
        message: 'Withdrawal request submitted. Manual processing required.'
      });
    }
  } catch (error) {
    console.error('Error processing withdrawal:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process withdrawal' 
    });
  }
});

// Check withdrawal status
app.get('/api/withdrawal-status/:withdrawalId', async (req, res) => {
  try {
    const { withdrawalId } = req.params;

    const withdrawalDoc = await db.collection('withdrawals').doc(withdrawalId).get();

    if (!withdrawalDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Withdrawal not found' 
      });
    }

    const withdrawalData = withdrawalDoc.data();

    // If withdrawal has Yoco payout ID, check status with Yoco
    if (withdrawalData.yocoPayoutId) {
      try {
        const yocoResponse = await axios.get(`${YOCO_PAYOUT_URL}/${withdrawalData.yocoPayoutId}`, {
          headers: {
            'Authorization': `Bearer ${YOCO_SECRET_KEY}`
          }
        });

        const payoutData = yocoResponse.data;

        // Update withdrawal status based on Yoco response
        await withdrawalDoc.ref.update({
          status: payoutData.status,
          completedAt: payoutData.status === 'succeeded' ? admin.firestore.FieldValue.serverTimestamp() : null
        });

        res.json({
          success: true,
          status: payoutData.status,
          amount: withdrawalData.amount,
          currency: withdrawalData.currency
        });
      } catch (yocoError) {
        console.error('Error checking Yoco payout status:', yocoError);
        res.json({
          success: true,
          status: withdrawalData.status,
          amount: withdrawalData.amount,
          currency: withdrawalData.currency
        });
      }
    } else {
      res.json({
        success: true,
        status: withdrawalData.status,
        amount: withdrawalData.amount,
        currency: withdrawalData.currency
      });
    }
  } catch (error) {
    console.error('Error checking withdrawal status:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check withdrawal status' 
    });
  }
});

// Yoco webhook handler
app.post('/api/webhook/yoco', async (req, res) => {
  try {
    const event = req.body;

    // Verify webhook signature (recommended in production)
    // For now, we'll process all webhooks

    switch (event.type) {
      case 'payment.succeeded':
        await handlePaymentSucceeded(event.data);
        break;
      case 'payment.failed':
        await handlePaymentFailed(event.data);
        break;
      default:
        console.log('Unhandled webhook event:', event.type);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Handle successful payment
async function handlePaymentSucceeded(paymentData) {
  try {
    const { id: chargeId, amount_in_cents, currency, metadata } = paymentData;
    const { userId } = metadata || {};

    if (!userId) {
      console.error('No userId in payment metadata');
      return;
    }

    // Update transaction status in Firestore
    const transactionsQuery = await db.collection('transactions')
      .where('yocoChargeId', '==', chargeId)
      .limit(1)
      .get();

    if (!transactionsQuery.empty) {
      const transactionDoc = transactionsQuery.docs[0];
      await transactionDoc.ref.update({
        status: 'succeeded',
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Update user wallet balance
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      const currentBalance = userDoc.data().walletBalance || 0;
      const amount = amount_in_cents / 100;

      await userRef.update({
        walletBalance: currentBalance + amount,
        totalDeposits: (userDoc.data().totalDeposits || 0) + amount,
        lastDepositAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Add to wallet transactions
      await db.collection('walletTransactions').add({
        userId,
        type: 'deposit',
        amount,
        currency,
        chargeId,
        status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (error) {
    console.error('Error handling payment succeeded:', error);
  }
}

// Handle failed payment
async function handlePaymentFailed(paymentData) {
  try {
    const { id: chargeId } = paymentData;

    // Update transaction status in Firestore
    const transactionsQuery = await db.collection('transactions')
      .where('yocoChargeId', '==', chargeId)
      .limit(1)
      .get();

    if (!transactionsQuery.empty) {
      const transactionDoc = transactionsQuery.docs[0];
      await transactionDoc.ref.update({
        status: 'failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (error) {
    console.error('Error handling payment failed:', error);
  }
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`PostaMedia backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

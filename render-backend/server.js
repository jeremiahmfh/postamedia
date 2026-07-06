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
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Yoco API Configuration
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_API_URL = 'https://payments.yoco.com/api/checkouts';
const YOCO_PAYOUT_URL = 'https://online.yoco.com/v1/payouts';

// Azure Computer Vision Configuration
const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT || 'https://postamediaresources.cognitiveservices.azure.com/';
const AZURE_API_KEY = process.env.AZURE_API_KEY || '29NAz9AntOICwEZzvdAUEolO3diSC1iTwj3DJdFAaEh6xiQB2EGtJQQJ99CGACrIdLPXJ3w3AAAFACOG7UG6';

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'PostaMedia backend is running' });
});

// Explicit OPTIONS handler for CORS preflight
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'https://postamedia.co.za');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
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

// Withdrawal endpoint (simplified - records withdrawal request for manual processing)
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

    console.log('Processing withdrawal request:', { userId, amount, currency, bankDetails });

    // Note: Actual bank transfer will be processed manually
    // This endpoint records the withdrawal request for manual processing
    res.json({
      success: true,
      message: 'Withdrawal request submitted successfully. Funds will be transferred within 1-3 business days.',
      withdrawalId: `WD-${Date.now()}`
    });
  } catch (error) {
    console.error('Withdrawal error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to process withdrawal request'
    });
  }
});

// OCR endpoint using Azure Computer Vision Read API (better for scattered text)
app.post('/api/ocr', async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: imageUrl'
      });
    }

    console.log('Processing OCR request');

    // Convert base64 to binary buffer
    let imageData;
    if (imageUrl.startsWith('data:image/')) {
      // Extract base64 data
      const base64Data = imageUrl.split(',')[1];
      imageData = Buffer.from(base64Data, 'base64');
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid image format'
      });
    }

    // Use Read API instead of OCR API for better layout analysis
    const readUrl = `${AZURE_ENDPOINT}vision/v3.2/read/analyze`;
    
    // Submit image for analysis
    const submitResponse = await axios.post(readUrl, imageData, {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_API_KEY,
        'Content-Type': 'application/octet-stream'
      }
    });

    const operationLocation = submitResponse.headers['operation-url'] || submitResponse.headers['Operation-Location'];
    console.log('Operation location:', operationLocation);

    if (!operationLocation) {
      throw new Error('No operation location returned from Azure');
    }

    // Poll for results
    let ocrResult = null;
    let attempts = 0;
    const maxAttempts = 20;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      
      const statusResponse = await axios.get(operationLocation, {
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_API_KEY
        }
      });

      ocrResult = statusResponse.data;
      console.log('Poll status:', ocrResult.status);

      if (ocrResult.status === 'succeeded') {
        break;
      } else if (ocrResult.status === 'failed') {
        throw new Error('Azure Read API operation failed');
      }

      attempts++;
    }

    if (!ocrResult || ocrResult.status !== 'succeeded') {
      throw new Error('Azure Read API operation timed out');
    }

    console.log('Azure Read result:', JSON.stringify(ocrResult, null, 2));

    // Extract text from Read API result
    let extractedText = '';
    if (ocrResult.analyzeResult && ocrResult.analyzeResult.readResults) {
      ocrResult.analyzeResult.readResults.forEach(readResult => {
        if (readResult.lines) {
          readResult.lines.forEach(line => {
            extractedText += line.text + ' ';
          });
        }
      });
    }

    extractedText = extractedText.trim();
    console.log('Extracted text:', extractedText);

    // Extract view count using patterns
    const patterns = [
      /(\d{1,5})\s*iews?/i,
      /(\d{1,5})\s*iew\s+s/i,
      /[\u25CF●●\s]*(\d{1,5})[\s\n]*views?/i,
      /(\d{1,5})\s*views?/i,
      /views?\s*[:\-]?\s*(\d{1,5})/i,
      /(\d{1,5})\s*\n?\s*views?/i,
      /v1ews?\s*(\d{1,5})/i,
      /vlews?\s*(\d{1,5})/i,
      /view\s*(\d{1,5})/i,
    ];

    let viewCount = null;
    
    // Rule: Views will always be the last number in the array
    const allNumbers = extractedText.match(/\d{1,5}/g) || [];
    if (allNumbers.length > 0) {
      const lastNumber = parseInt(allNumbers[allNumbers.length - 1]);
      if (lastNumber > 0 && lastNumber <= 10000) {
        viewCount = lastNumber;
      }
    }

    // Fallback to pattern matching if last number rule fails
    if (!viewCount) {
      for (const pattern of patterns) {
        const match = extractedText.match(pattern);
        if (match) {
          viewCount = parseInt(match[1]);
          break;
        }
      }
    }

    res.json({
      success: true,
      viewCount: viewCount,
      extractedText: extractedText,
      rawResult: ocrResult
    });
  } catch (error) {
    console.error('OCR error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.error?.message || 'Failed to process OCR'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

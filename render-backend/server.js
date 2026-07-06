require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createWorker } = require('tesseract.js');

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

// OCR endpoint using Tesseract.js (server-side)
app.post('/api/ocr', async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: imageUrl'
      });
    }

    console.log('Processing OCR request with Tesseract.js');

    // Convert base64 to buffer for Tesseract
    let imageData;
    if (imageUrl.startsWith('data:image/')) {
      const base64Data = imageUrl.split(',')[1];
      imageData = Buffer.from(base64Data, 'base64');
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid image format'
      });
    }

    // Create Tesseract worker
    const worker = await createWorker('eng', 1, {
      logger: () => {},
    });

    // Configure Tesseract for better small text recognition
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789 Views●○',
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });

    // Perform OCR
    const { data } = await worker.recognize(imageData);
    await worker.terminate();

    const text = data.text;
    console.log('OCR extracted text:', text);

    // Reconstruct scattered text
    const ocrLines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const reconstructedText = ocrLines.join(' ');
    const cleanedText = reconstructedText.replace(/\s+/g, ' ').trim();
    console.log('Cleaned text:', cleanedText);

    // Extract all numbers
    const allNumbers = cleanedText.match(/\d{1,5}/g) || [];
    console.log('All numbers found:', allNumbers);

    // Rule: Views will always be the last number in the array
    if (allNumbers.length > 0) {
      const lastNumber = parseInt(allNumbers[allNumbers.length - 1]);
      if (lastNumber > 0 && lastNumber <= 10000) {
        console.log('Using last number as view count:', lastNumber);
        return res.json({
          success: true,
          viewCount: lastNumber,
          extractedText: cleanedText
        });
      }
    }

    // Check if "views" or similar keywords are present
    const hasViewsKeyword = /views?|iews?/i.test(cleanedText);

    if (hasViewsKeyword && allNumbers.length > 0) {
      const words = cleanedText.split(' ');
      let viewCount = null;
      let lastViewIndex = -1;
      
      for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i].toLowerCase();
        if (word.includes('view') || word.includes('iew')) {
          lastViewIndex = i;
          break;
        }
      }
      
      if (lastViewIndex !== -1) {
        if (lastViewIndex > 0 && /\d{1,5}/.test(words[lastViewIndex - 1])) {
          viewCount = parseInt(words[lastViewIndex - 1].match(/\d{1,5}/)[0]);
        } else if (lastViewIndex < words.length - 1 && /\d{1,5}/.test(words[lastViewIndex + 1])) {
          viewCount = parseInt(words[lastViewIndex + 1].match(/\d{1,5}/)[0]);
        } else if (/\d{1,5}/.test(words[lastViewIndex])) {
          viewCount = parseInt(words[lastViewIndex].match(/\d{1,5}/)[0]);
        }
      }
      
      if (viewCount && viewCount > 0 && viewCount <= 10000) {
        console.log('Found view count near last keyword:', viewCount);
        return res.json({
          success: true,
          viewCount: viewCount,
          extractedText: cleanedText
        });
      }
    }

    // Fallback patterns
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

    for (const p of patterns) {
      const m = cleanedText.match(p);
      if (m) {
        const n = parseInt(m[1]);
        if (n > 0 && n <= 10000) {
          console.log('Matched pattern:', p, 'Result:', n);
          return res.json({
            success: true,
            viewCount: n,
            extractedText: cleanedText
          });
        }
      }
    }

    // Last resort: largest reasonable number
    if (hasViewsKeyword && allNumbers.length > 0) {
      const reasonableNumbers = allNumbers
        .map(n => parseInt(n))
        .filter(n => n > 0 && n <= 10000 && n > 5);
      
      if (reasonableNumbers.length > 0) {
        const maxNumber = Math.max(...reasonableNumbers);
        console.log('Using fallback - largest reasonable number:', maxNumber);
        return res.json({
          success: true,
          viewCount: maxNumber,
          extractedText: cleanedText
        });
      }
    }

    res.json({
      success: false,
      viewCount: null,
      extractedText: cleanedText,
      error: 'Could not extract view count'
    });
  } catch (error) {
    console.error('Tesseract OCR error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process OCR'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

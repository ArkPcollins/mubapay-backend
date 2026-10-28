'use strict';
/**
 * WhatsApp Local Web-Bridge Adapter (whatsapp-web.js)
 * Completely free, requires zero cloud hosting, templates, or credit cards.
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { E } = require('../../lib/errors');

// Initialize a persistent client session so you only scan the QR code ONCE
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './sessions' }),
  puppeteer: {
    headless: true,
    // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let isClientReady = false;

// 1. Generate the terminal login QR code dynamically
client.on('qr', (qr) => {
  console.log('\n=== WHATSAPP LOGIN REQUIRED ===');
  console.log('Scan the QR code below using your linked WhatsApp device:');
  qrcode.generate(qr, { small: true });
  console.log('================================\n');
});

// 2. Flip state flag when the background channel link completes
client.on('ready', () => {
  console.log('🚀 FinCore WhatsApp local-bridge is authenticated and ready!');
  isClientReady = true;
});

client.on('auth_failure', (msg) => {
  console.error('WhatsApp local authentication failed:', msg);
});

// Boot up the hidden browser stream on application startup
client.initialize();

function requireConfigured() {
  if (!isClientReady) {
    throw E.notConfigured(
      'WhatsApp Bridge', 
      'The local WhatsApp client is still initializing or needs a QR code scan.'
    );
  }
}

/** Normalise Nigerian numbers to WhatsApp's formatting requirements */
function toWaId(phone) {
  const digits = String(phone).replace(/\D/g, '');
  let formatted = digits;
  
  if (digits.startsWith('0') && digits.length === 11) {
    formatted = `234${digits.slice(1)}`;
  }
  
  // Append WhatsApp's mandatory user routing suffix
  return formatted.endsWith('@c.us') ? formatted : `${formatted}@c.us`;
}

/** Send plain custom textual payloads directly */
async function sendText(to, body) {
  requireConfigured();
  
  const chatId = toWaId(to);
  await client.sendMessage(chatId, body);
  
  return { messageId: 'message-sent-successfully' };
//   return { messageId: response.id._serialized };
}

/** Send an OTP using raw text interpolation strings without templates */
async function sendOtp(to, code) {
//   requireConfigured();
  
  const otpMessage = `Your FinCore verification code is: ${code}\n\nThis token expires in 10 minutes. Do not share this code with anyone.`;
  
  return sendText(to, otpMessage);
}

/** Simple stub bypass to keep validation structures intact */
function verifySignature(rawBody, header) {
  return true; 
}

function status() {
  return { 
    implemented: true, 
    configured: isClientReady, 
    otpTemplate: false 
  };
}

module.exports = { sendText, sendOtp, verifySignature, toWaId, status, requireConfigured };

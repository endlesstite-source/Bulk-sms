const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Firebase Admin initialization
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing!');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Talksasa configuration
const TALKSASA_API_KEY = process.env.TALKSASA_API_KEY;
const TALKSASA_SENDER_ID = process.env.TALKSASA_SENDER_ID || 'TALK-SASA';
const TALKSASA_API_URL = 'https://bulksms.talksasa.com/api/v3/sms/send';

// Format Kenyan phone number to international format
function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\s+/g, '').replace(/[()-]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
  else if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
  return cleaned;
}

// Send SMS via Talksasa
async function sendSms(recipientPhone, message) {
  const formattedPhone = formatPhoneNumber(recipientPhone);
  const payload = { recipient: formattedPhone, message };
  if (TALKSASA_SENDER_ID) payload.sender_id = TALKSASA_SENDER_ID;
  
  console.log(`[SMS] Sending to ${formattedPhone}: ${message.substring(0, 30)}...`);
  try {
    const response = await axios.post(TALKSASA_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TALKSASA_API_KEY}`
      }
    });
    console.log(`[SMS] Response:`, response.data);
    return { success: response.data.status === 'success', messageId: response.data.data?.uid };
  } catch (error) {
    console.error(`[SMS] Failed:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// Authentication middleware
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
  const token = authHeader.replace('Bearer ', '');
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes
app.get('/', (req, res) => res.send('SMS Marketing API is running.'));

// Groups
app.get('/api/groups', authenticateUser, async (req, res) => {
  const snapshot = await db.collection('groups').where('userId', '==', req.user.uid).get();
  res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
});

app.post('/api/groups', authenticateUser, async (req, res) => {
  const { name } = req.body;
  const docRef = await db.collection('groups').add({
    userId: req.user.uid,
    name,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  const doc = await docRef.get();
  res.json({ id: doc.id, ...doc.data() });
});

// Contacts
app.get('/api/contacts', authenticateUser, async (req, res) => {
  const snapshot = await db.collection('contacts').where('userId', '==', req.user.uid).get();
  res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
});

app.post('/api/contacts', authenticateUser, async (req, res) => {
  const { phone, first_name, last_name, group_id } = req.body;
  if (!phone || !group_id) return res.status(400).json({ error: 'Phone and group required' });
  const docRef = await db.collection('contacts').add({
    userId: req.user.uid,
    phone,
    first_name: first_name || '',
    last_name: last_name || '',
    groupId: group_id,
    blocked: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  const doc = await docRef.get();
  res.json({ id: doc.id, ...doc.data() });
});

// Templates
app.get('/api/templates', authenticateUser, async (req, res) => {
  const snapshot = await db.collection('templates').where('userId', '==', req.user.uid).get();
  res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
});

app.post('/api/templates', authenticateUser, async (req, res) => {
  const { name, body } = req.body;
  const docRef = await db.collection('templates').add({
    userId: req.user.uid,
    name,
    body,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  const doc = await docRef.get();
  res.json({ id: doc.id, ...doc.data() });
});

// Campaigns
app.post('/api/campaigns', authenticateUser, async (req, res) => {
  console.log('📨 POST /api/campaigns - Body:', JSON.stringify(req.body, null, 2));
  const { name, message, group_ids, scheduled_at, repeat_interval } = req.body;
  
  if (!name || !message || !group_ids?.length) {
    console.log('❌ Missing fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const docRef = await db.collection('campaigns').add({
    userId: req.user.uid,
    name,
    message,
    groupIds: group_ids,
    scheduledAt: scheduled_at,
    repeatInterval: repeat_interval || 'none',
    status: 'scheduled',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  console.log('✅ Campaign saved:', docRef.id);
  res.json({ id: docRef.id });
});

// ====================== CRON JOB (WITH VERBOSE LOGGING) ======================
cron.schedule('* * * * *', async () => {
  console.log('[CRON] Checking campaigns...');
  const now = new Date().toISOString();
  console.log('[CRON] Current time:', now);
  
  try {
    const snap = await db.collection('campaigns')
      .where('status', '==', 'scheduled')
      .where('scheduledAt', '<=', now)
      .get();
    
    console.log(`[CRON] Query returned ${snap.size} campaigns.`);
    
    if (snap.empty) {
      // Debug: show all campaigns to see their status and scheduledAt
      console.log('[CRON DEBUG] No campaigns found. Listing all campaigns (up to 5):');
      const allSnap = await db.collection('campaigns').limit(5).get();
      allSnap.forEach(doc => {
        const d = doc.data();
        console.log(`[CRON DEBUG] Campaign ${doc.id}: status="${d.status}", scheduledAt="${d.scheduledAt}"`);
      });
      return;
    }
    
    for (const doc of snap.docs) {
      const campaign = doc.data();
      console.log(`[CRON] Processing "${campaign.name}" (ID: ${doc.id})`);
      console.log(`[CRON] Group IDs: ${campaign.groupIds}`);
      
      const contactsSnap = await db.collection('contacts')
        .where('userId', '==', campaign.userId)
        .where('groupId', 'in', campaign.groupIds)
        .where('blocked', '==', false)
        .get();
      
      console.log(`[CRON] Contacts to send: ${contactsSnap.size}`);
      
      if (contactsSnap.empty) {
        console.log('[CRON] No contacts found for these groups. Skipping.');
        // Mark as completed to avoid infinite loop
        await doc.ref.update({ status: 'completed' });
        continue;
      }
      
      let successCount = 0;
      for (const contactDoc of contactsSnap.docs) {
        const contact = contactDoc.data();
        let msg = campaign.message;
        msg = msg.replace(/{{first_name}}/g, contact.first_name || 'Customer');
        msg = msg.replace(/{{last_name}}/g, contact.last_name || '');
        
        const nowDate = new Date();
        msg = msg.replace(/{{date}}/g, nowDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
        msg = msg.replace(/{{time}}/g, nowDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }));
        
        const result = await sendSms(contact.phone, msg);
        if (result.success) successCount++;
        await new Promise(r => setTimeout(r, 150));
      }
      
      console.log(`[CRON] Campaign "${campaign.name}" completed. Sent: ${successCount}/${contactsSnap.size}`);
      
      // Update status or next occurrence
      if (campaign.repeatInterval && campaign.repeatInterval !== 'none') {
        let next = new Date(campaign.scheduledAt);
        if (campaign.repeatInterval === 'daily') next.setDate(next.getDate() + 1);
        else if (campaign.repeatInterval === 'weekly') next.setDate(next.getDate() + 7);
        else if (campaign.repeatInterval === 'monthly') next.setMonth(next.getMonth() + 1);
        await doc.ref.update({ scheduledAt: next.toISOString() });
        console.log(`[CRON] Next occurrence scheduled for: ${next.toISOString()}`);
      } else {
        await doc.ref.update({ status: 'completed' });
      }
    }
  } catch (error) {
    console.error('[CRON] Error:', error);
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
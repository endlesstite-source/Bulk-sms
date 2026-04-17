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

// Firebase Admin
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT missing!');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TALKSASA_API_KEY = process.env.TALKSASA_API_KEY;
const TALKSASA_SENDER_ID = process.env.TALKSASA_SENDER_ID || 'TALK-SASA';
const TALKSASA_API_URL = 'https://bulksms.talksasa.com/api/v3/sms/send';

function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\s+/g, '').replace(/[()-]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
  else if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
  return cleaned;
}

async function sendSms(recipientPhone, message) {
  const formattedPhone = formatPhoneNumber(recipientPhone);
  const payload = { recipient: formattedPhone, message };
  if (TALKSASA_SENDER_ID) payload.sender_id = TALKSASA_SENDER_ID;
  console.log(`[SMS] Sending to ${formattedPhone}: ${message.substring(0,30)}...`);
  try {
    const response = await axios.post(TALKSASA_API_URL, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TALKSASA_API_KEY}` }
    });
    console.log(`[SMS] Response:`, response.data);
    return { success: response.data.status === 'success', messageId: response.data.data?.uid };
  } catch (error) {
    console.error(`[SMS] Failed:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing token' });
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/', (req, res) => res.send('SMS API running.'));

app.get('/api/groups', authenticateUser, async (req, res) => {
  const snap = await db.collection('groups').where('userId', '==', req.user.uid).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post('/api/groups', authenticateUser, async (req, res) => {
  const { name } = req.body;
  const ref = await db.collection('groups').add({ userId: req.user.uid, name });
  res.json({ id: ref.id, name });
});

app.get('/api/contacts', authenticateUser, async (req, res) => {
  const snap = await db.collection('contacts').where('userId', '==', req.user.uid).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post('/api/contacts', authenticateUser, async (req, res) => {
  const { phone, first_name, last_name, group_id } = req.body;
  if (!phone || !group_id) return res.status(400).json({ error: 'Missing fields' });
  const ref = await db.collection('contacts').add({ userId: req.user.uid, phone, first_name: first_name||'', last_name: last_name||'', groupId: group_id, blocked: false });
  res.json({ id: ref.id });
});

app.get('/api/templates', authenticateUser, async (req, res) => {
  const snap = await db.collection('templates').where('userId', '==', req.user.uid).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post('/api/templates', authenticateUser, async (req, res) => {
  const { name, body } = req.body;
  const ref = await db.collection('templates').add({ userId: req.user.uid, name, body });
  res.json({ id: ref.id });
});

app.post('/api/campaigns', authenticateUser, async (req, res) => {
  console.log('📨 POST /api/campaigns - Body:', JSON.stringify(req.body, null, 2));
  const { name, message, group_ids, scheduled_at, repeat_interval } = req.body;
  if (!name || !message || !group_ids?.length) {
    console.log('❌ Missing fields');
    return res.status(400).json({ error: 'Missing fields' });
  }
  const ref = await db.collection('campaigns').add({
    userId: req.user.uid, name, message, groupIds: group_ids, scheduledAt: scheduled_at, repeatInterval: repeat_interval,
    status: 'scheduled', createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('✅ Campaign saved:', ref.id);
  res.json({ id: ref.id });
});

// Cron job
cron.schedule('* * * * *', async () => {
  console.log('[CRON] Checking campaigns...');
  const now = new Date().toISOString();
  const snap = await db.collection('campaigns').where('status', '==', 'scheduled').where('scheduledAt', '<=', now).get();
  console.log(`[CRON] Found ${snap.size} campaigns to process.`);
  for (const doc of snap.docs) {
    const c = doc.data();
    console.log(`[CRON] Processing "${c.name}" with groups: ${c.groupIds}`);
    const contactsSnap = await db.collection('contacts').where('userId', '==', c.userId).where('groupId', 'in', c.groupIds).where('blocked', '==', false).get();
    console.log(`[CRON] Contacts to send: ${contactsSnap.size}`);
    for (const cDoc of contactsSnap.docs) {
      const contact = cDoc.data();
      let msg = c.message.replace(/{{first_name}}/g, contact.first_name || 'Customer');
      await sendSms(contact.phone, msg);
      await new Promise(r => setTimeout(r, 150));
    }
    if (c.repeatInterval && c.repeatInterval !== 'none') {
      let next = new Date(c.scheduledAt);
      if (c.repeatInterval === 'daily') next.setDate(next.getDate() + 1);
      else if (c.repeatInterval === 'weekly') next.setDate(next.getDate() + 7);
      else if (c.repeatInterval === 'monthly') next.setMonth(next.getMonth() + 1);
      await doc.ref.update({ scheduledAt: next.toISOString() });
    } else {
      await doc.ref.update({ status: 'completed' });
    }
  }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
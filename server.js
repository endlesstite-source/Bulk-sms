const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const dbPath = path.join(__dirname, 'sms_marketing.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    first_name TEXT,
    last_name TEXT,
    group_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups (id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    body TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    group_id INTEGER,
    scheduled_at DATETIME,
    repeat_interval TEXT,
    status TEXT DEFAULT 'draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups (id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS campaign_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER,
    contact_id INTEGER,
    message_id TEXT,
    status TEXT,
    cost REAL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
    FOREIGN KEY (contact_id) REFERENCES contacts (id)
  )`);
  db.get("SELECT id FROM groups WHERE name = 'All Contacts'", (err, row) => {
    if (!row) db.run("INSERT INTO groups (name) VALUES ('All Contacts')");
  });
});

const TALKSASA_API_KEY = process.env.TALKSASA_API_KEY;
const TALKSASA_API_URL = 'https://bulksms.talksasa.com/api/v3/sms/send';
const TALKSASA_SENDER_ID = process.env.TALKSASA_SENDER_ID || 'Talksasa';

async function sendSms(recipientPhone, message) {
  console.log(`[SMS] Sending to ${recipientPhone}`);
  const payload = {
    sender_id: TALKSASA_SENDER_ID,
    recipients: [{ phone: recipientPhone, name: '' }],
    message: message
  };
  try {
    const response = await axios.post(TALKSASA_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TALKSASA_API_KEY}`
      }
    });
    console.log(`[SMS] SUCCESS:`, response.data);
    return { success: true, messageId: response.data.message_id || response.data.id };
  } catch (error) {
    console.error(`[SMS] FAILED for ${recipientPhone}:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

app.get('/', (req, res) => res.send('SMS Marketing API is running.'));

app.get('/api/groups', (req, res) => {
  db.all("SELECT * FROM groups", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/groups', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name required' });
  db.run("INSERT INTO groups (name) VALUES (?)", [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name });
  });
});

app.get('/api/contacts', (req, res) => {
  const { groupId } = req.query;
  let query = "SELECT * FROM contacts";
  let params = [];
  if (groupId) { query += " WHERE group_id = ?"; params.push(groupId); }
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/contacts', (req, res) => {
  const { phone, first_name, last_name, group_id } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  db.run("INSERT INTO contacts (phone, first_name, last_name, group_id) VALUES (?, ?, ?, ?)",
    [phone, first_name || '', last_name || '', group_id || 1],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, phone, first_name, last_name, group_id });
    });
});

app.get('/api/templates', (req, res) => {
  db.all("SELECT * FROM templates", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/templates', (req, res) => {
  const { name, body } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'Name and body required' });
  db.run("INSERT INTO templates (name, body) VALUES (?, ?)", [name, body], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name, body });
  });
});

app.get('/api/campaigns', (req, res) => {
  db.all("SELECT * FROM campaigns ORDER BY created_at DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/campaigns', (req, res) => {
  const { name, message, group_id, scheduled_at, repeat_interval } = req.body;
  if (!name || !message || !group_id) return res.status(400).json({ error: 'Missing fields' });
  db.run("INSERT INTO campaigns (name, message, group_id, scheduled_at, repeat_interval, status) VALUES (?, ?, ?, ?, ?, ?)",
    [name, message, group_id, scheduled_at || new Date().toISOString(), repeat_interval || 'none', 'scheduled'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    });
});

app.get('/api/reports', (req, res) => {
  const query = `
    SELECT c.name as campaign_name, COUNT(cl.id) as sent_count,
           SUM(CASE WHEN cl.status = 'sent' THEN 1 ELSE 0 END) as delivered_count,
           SUM(cl.cost) as total_cost
    FROM campaign_logs cl
    JOIN campaigns c ON cl.campaign_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC
  `;
  db.all(query, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

cron.schedule('* * * * *', () => {
  console.log('[CRON] Checking scheduled campaigns...');
  const now = new Date().toISOString();
  db.all("SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?", [now], async (err, campaigns) => {
    if (err || !campaigns.length) return;
    for (const campaign of campaigns) {
      console.log(`[CRON] Processing: ${campaign.name}`);
      db.all("SELECT * FROM contacts WHERE group_id = ?", [campaign.group_id], async (err, contacts) => {
        if (err || !contacts.length) return;
        let success = 0, cost = 0;
        for (const contact of contacts) {
          let msg = campaign.message.replace(/{{first_name}}/g, contact.first_name || 'Customer');
          const result = await sendSms(contact.phone, msg);
          const status = result.success ? 'sent' : 'failed';
          if (result.success) success++;
          cost += 0.35;
          db.run("INSERT INTO campaign_logs (campaign_id, contact_id, message_id, status, cost) VALUES (?, ?, ?, ?, ?)",
            [campaign.id, contact.id, result.messageId || null, status, 0.35]);
          await new Promise(r => setTimeout(r, 150));
        }
        console.log(`[CRON] Campaign done. Sent: ${success}, Cost: KES ${cost.toFixed(2)}`);
        let newStatus = 'completed';
        if (campaign.repeat_interval && campaign.repeat_interval !== 'none') {
          newStatus = 'scheduled';
          const next = new Date(campaign.scheduled_at);
          if (campaign.repeat_interval === 'daily') next.setDate(next.getDate() + 1);
          else if (campaign.repeat_interval === 'weekly') next.setDate(next.getDate() + 7);
          else if (campaign.repeat_interval === 'monthly') next.setMonth(next.getMonth() + 1);
          db.run("UPDATE campaigns SET scheduled_at = ? WHERE id = ?", [next.toISOString(), campaign.id]);
        } else {
          db.run("UPDATE campaigns SET status = ? WHERE id = ?", [newStatus, campaign.id]);
        }
      });
    }
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
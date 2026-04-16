const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());

// --- Database Setup (SQLite) ---
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

  // Insert default "All Contacts" group if it doesn't exist
  db.get("SELECT id FROM groups WHERE name = 'All Contacts'", (err, row) => {
    if (!row) {
      db.run("INSERT INTO groups (name) VALUES ('All Contacts')");
    }
  });
});

// --- Talksasa API Configuration ---
const TALKSASA_API_KEY = process.env.TALKSASA_API_KEY;
const TALKSASA_API_URL = 'https://bulksms.talksasa.com/api/v3/sms/send';
const TALKSASA_SENDER_ID = process.env.TALKSASA_SENDER_ID || 'Talksasa';

// --- Helper function to send SMS via Talksasa ---
async function sendSms(recipientPhone, message) {
  console.log(`[SMS] 📱 Attempting to send to ${recipientPhone}`);
  console.log(`[SMS] Message: ${message.substring(0, 50)}...`);
  
  const payload = {
    sender_id: TALKSASA_SENDER_ID,
    recipients: [{ phone: recipientPhone, name: '' }],
    message: message
  };
  
  try {
    const response = await axios.post(TALKSASA_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'api-key': TALKSASA_API_KEY
      }
    });
    
    console.log(`[SMS] ✅ SUCCESS for ${recipientPhone}`);
    console.log(`[SMS] Response:`, response.data);
    return { success: true, messageId: response.data.message_id || response.data.id };
  } catch (error) {
    console.error(`[SMS] ❌ FAILED for ${recipientPhone}`);
    if (error.response) {
      console.error(`[SMS] Status: ${error.response.status}`);
      console.error(`[SMS] Data:`, error.response.data);
    } else {
      console.error(`[SMS] Error:`, error.message);
    }
    return { success: false, error: error.message };
  }
}

// --- API Routes ---

app.get('/', (req, res) => {
  res.send('SMS Marketing API is running.');
});

// === Groups ===
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

// === Contacts ===
app.get('/api/contacts', (req, res) => {
  const { groupId } = req.query;
  let query = "SELECT * FROM contacts";
  let params = [];
  if (groupId) {
    query += " WHERE group_id = ?";
    params.push(groupId);
  }
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

// === Templates ===
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

// === Campaigns ===
app.get('/api/campaigns', (req, res) => {
  db.all("SELECT * FROM campaigns ORDER BY created_at DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/campaigns', (req, res) => {
  const { name, message, group_id, scheduled_at, repeat_interval } = req.body;
  if (!name || !message || !group_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run("INSERT INTO campaigns (name, message, group_id, scheduled_at, repeat_interval, status) VALUES (?, ?, ?, ?, ?, ?)",
    [name, message, group_id, scheduled_at || new Date().toISOString(), repeat_interval || 'none', 'scheduled'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, message, group_id, scheduled_at, repeat_interval, status: 'scheduled' });
    });
});

// === Reports ===
app.get('/api/reports', (req, res) => {
  const query = `
    SELECT c.name as campaign_name, COUNT(cl.id) as sent_count,
           SUM(CASE WHEN cl.status = 'sent' OR cl.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
           SUM(cl.cost) as total_cost
    FROM campaign_logs cl
    JOIN campaigns c ON cl.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `;
  db.all(query, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// --- Scheduler: Runs every minute ---
cron.schedule('* * * * *', () => {
  console.log('[CRON] Running scheduled campaign check...');
  const now = new Date().toISOString();
  
  db.all("SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?", [now], async (err, campaigns) => {
    if (err) {
      console.error('[CRON] Error fetching campaigns:', err);
      return;
    }
    
    if (campaigns.length === 0) {
      console.log('[CRON] No campaigns due at this time.');
      return;
    }
    
    console.log(`[CRON] Found ${campaigns.length} campaign(s) to process.`);
    
    for (const campaign of campaigns) {
      console.log(`[CRON] Processing campaign: "${campaign.name}" (ID: ${campaign.id})`);
      
      db.all("SELECT * FROM contacts WHERE group_id = ?", [campaign.group_id], async (err, contacts) => {
        if (err) {
          console.error(`[CRON] Error fetching contacts for campaign ${campaign.id}:`, err);
          return;
        }
        
        if (contacts.length === 0) {
          console.log(`[CRON] No contacts found for group ${campaign.group_id}. Skipping.`);
          // Update campaign to completed to avoid infinite loop
          db.run("UPDATE campaigns SET status = 'completed' WHERE id = ?", [campaign.id]);
          return;
        }
        
        console.log(`[CRON] Sending to ${contacts.length} contact(s)...`);
        let successCount = 0;
        let failCount = 0;
        let totalCost = 0;
        const costPerSms = 0.35;
        
        for (const contact of contacts) {
          // Personalize message
          let personalizedMsg = campaign.message;
          personalizedMsg = personalizedMsg.replace(/{{first_name}}/g, contact.first_name || 'Customer');
          personalizedMsg = personalizedMsg.replace(/{{last_name}}/g, contact.last_name || '');
          personalizedMsg = personalizedMsg.replace(/{{amount}}/g, '');
          personalizedMsg = personalizedMsg.replace(/{{code}}/g, '');
          
          const result = await sendSms(contact.phone, personalizedMsg);
          
          const logStatus = result.success ? 'sent' : 'failed';
          if (result.success) successCount++; else failCount++;
          totalCost += costPerSms;
          
          // Log the attempt
          db.run("INSERT INTO campaign_logs (campaign_id, contact_id, message_id, status, cost) VALUES (?, ?, ?, ?, ?)",
            [campaign.id, contact.id, result.messageId || null, logStatus, costPerSms],
            (err) => {
              if (err) console.error('[CRON] Error logging campaign:', err);
            });
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        
        console.log(`[CRON] Campaign "${campaign.name}" completed. Success: ${successCount}, Failed: ${failCount}, Cost: KES ${totalCost.toFixed(2)}`);
        
        // Update campaign status
        let newStatus = 'completed';
        let nextScheduledAt = null;
        
        if (campaign.repeat_interval && campaign.repeat_interval !== 'none') {
          newStatus = 'scheduled';
          const nextDate = new Date(campaign.scheduled_at);
          if (campaign.repeat_interval === 'daily') nextDate.setDate(nextDate.getDate() + 1);
          else if (campaign.repeat_interval === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
          else if (campaign.repeat_interval === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
          nextScheduledAt = nextDate.toISOString();
        }
        
        if (nextScheduledAt) {
          db.run("UPDATE campaigns SET scheduled_at = ? WHERE id = ?", [nextScheduledAt, campaign.id]);
          console.log(`[CRON] Next occurrence scheduled for: ${nextScheduledAt}`);
        } else {
          db.run("UPDATE campaigns SET status = ? WHERE id = ?", [newStatus, campaign.id]);
        }
      });
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Talksasa API Key ${TALKSASA_API_KEY ? 'is set' : 'IS NOT SET!'}`);
});
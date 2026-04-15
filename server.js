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

// Create tables if they don't exist
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
// These will be set via environment variables on Render
const TALKSASA_API_KEY = process.env.TALKSASA_API_KEY;
const TALKSASA_API_URL = 'https://bulksms.talksasa.com/api/v3/sms/send';
const TALKSASA_SENDER_ID = 'Talksasa'; // Default sender ID

// Helper function to send SMS via Talksasa
async function sendSms(recipientPhone, message) {
  try {
    const response = await axios.post(TALKSASA_API_URL, {
      sender_id: TALKSASA_SENDER_ID,
      recipients: [{ phone: recipientPhone, name: '' }],
      message: message
    }, {
      headers: {
        'Content-Type': 'application/json',
        'api-key': TALKSASA_API_KEY
      }
    });
    return { success: true, messageId: response.data.message_id };
  } catch (error) {
    console.error(`Failed to send to ${recipientPhone}:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// --- API Routes ---

// Health check
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
  db.run("INSERT INTO contacts (phone, first_name, last_name, group_id) VALUES (?, ?, ?, ?)",
    [phone, first_name, last_name, group_id || 1],
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
  db.run("INSERT INTO campaigns (name, message, group_id, scheduled_at, repeat_interval, status) VALUES (?, ?, ?, ?, ?, ?)",
    [name, message, group_id, scheduled_at, repeat_interval, 'scheduled'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, message, group_id, scheduled_at, repeat_interval, status: 'scheduled' });
    });
});

// Endpoint to get contacts for a specific group (used by the scheduler)
app.get('/api/groups/:groupId/contacts', (req, res) => {
  const { groupId } = req.params;
  db.all("SELECT * FROM contacts WHERE group_id = ?", [groupId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// === Reports ===
app.get('/api/reports', (req, res) => {
  const query = `
    SELECT c.name as campaign_name, COUNT(cl.id) as sent_count,
           SUM(CASE WHEN cl.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
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

// --- Scheduler (Runs every minute) ---
cron.schedule('* * * * *', () => {
  console.log('Running scheduled campaign check...');
  const now = new Date().toISOString();
  
  db.all("SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?", [now], async (err, campaigns) => {
    if (err) {
      console.error('Error fetching campaigns:', err);
      return;
    }
    
    for (const campaign of campaigns) {
      console.log(`Processing campaign: ${campaign.name}`);
      
      // Get contacts for the campaign's group
      db.all("SELECT * FROM contacts WHERE group_id = ?", [campaign.group_id], async (err, contacts) => {
        if (err) {
          console.error(`Error fetching contacts for campaign ${campaign.id}:`, err);
          return;
        }
        
        let totalCost = 0;
        for (const contact of contacts) {
          // Personalize message (simple replace)
          let personalizedMsg = campaign.message;
          personalizedMsg = personalizedMsg.replace('{{first_name}}', contact.first_name || 'Customer');
          personalizedMsg = personalizedMsg.replace('{{last_name}}', contact.last_name || '');
          
          const result = await sendSms(contact.phone, personalizedMsg);
          const costPerSms = 0.35; // Talksasa rate
          
          // Log the attempt
          db.run("INSERT INTO campaign_logs (campaign_id, contact_id, message_id, status, cost) VALUES (?, ?, ?, ?, ?)",
            [campaign.id, contact.id, result.messageId || null, result.success ? 'sent' : 'failed', costPerSms],
            (err) => {
              if (err) console.error('Error logging campaign:', err);
            });
          
          totalCost += costPerSms;
          // Small delay to avoid hitting API rate limits
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Update campaign status
        let newStatus = 'completed';
        if (campaign.repeat_interval && campaign.repeat_interval !== 'none') {
          newStatus = 'scheduled'; // Keep it scheduled for next recurrence
          // Calculate next scheduled time based on interval
          const nextDate = new Date(campaign.scheduled_at);
          if (campaign.repeat_interval === 'daily') nextDate.setDate(nextDate.getDate() + 1);
          else if (campaign.repeat_interval === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
          else if (campaign.repeat_interval === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
          
          db.run("UPDATE campaigns SET scheduled_at = ? WHERE id = ?", [nextDate.toISOString(), campaign.id]);
        } else {
          db.run("UPDATE campaigns SET status = ? WHERE id = ?", [newStatus, campaign.id]);
        }
        
        console.log(`Campaign ${campaign.name} processed. Total cost: KES ${totalCost.toFixed(2)}`);
      });
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';

app.use(cors());
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${req.method} ${req.url}`);
  next();
});

// Initialize data storage
function initializeData() {
  const defaultData = {
    logs: [],
    notifications: [],
    availableCourts: [],
    lastChecked: null,
    subscribers: []
  };
  
  try {
    if (!fs.existsSync(DB_PATH)) {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
    }
  } catch (error) {
    console.error('Error initializing data:', error);
  }
}

function readData() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (error) {
    console.error('Error reading data:', error);
  }
  return { logs: [], notifications: [], availableCourts: [], lastChecked: null, subscribers: [] };
}

function writeData(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error writing data:', error);
  }
}

function addLog(message) {
  const data = readData();
  const logEntry = {
    timestamp: new Date().toISOString(),
    message
  };
  data.logs.push(logEntry);
  // Keep only last 100 logs
  if (data.logs.length > 100) {
    data.logs = data.logs.slice(-100);
  }
  writeData(data);
  console.log(`LOG: ${logEntry.message}`);
}

function getUpcomingFridays() {
  const fridays = [];
  const today = new Date();
  
  for (let i = 0; i < 28; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    
    if (date.getDay() === 5) { // Friday is day 5
      fridays.push(date.toISOString().split('T')[0]);
    }
  }
  
  return fridays;
}

async function scrapeCourts() {
  let browser;
  try {
    addLog('Starting court availability scrape...');
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    addLog('Loading rec.us/joedimaggio...');
    await page.goto('https://rec.us/joedimaggio', { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Wait for content to load
    await page.waitForTimeout(3000);
    
    const fridays = getUpcomingFridays();
    addLog(`Checking availability for Fridays: ${fridays.join(', ')}`);
    
    const availableCourts = [];
    
    // Look for tennis court availability elements
    const courtElements = await page.$$eval('[data-testid*="court"], .court, .booking-slot, .time-slot, .available', (elements) => {
      return elements.map(el => ({
        text: el.textContent?.trim() || '',
        className: el.className || '',
        id: el.id || ''
      }));
    });
    
    addLog(`Found ${courtElements.length} potential court elements`);
    
    // Look for date/time patterns and availability indicators
    const pageText = await page.evaluate(() => document.body.innerText);
    const lines = pageText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    let foundAvailability = false;
    
    for (const friday of fridays) {
      const fridayDate = new Date(friday);
      const dateStr = fridayDate.toLocaleDateString();
      const dayStr = fridayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      
      // Look for this Friday's date in various formats
      const datePatterns = [
        dateStr,
        dayStr,
        friday,
        fridayDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
        fridayDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })
      ];
      
      for (const line of lines) {
        for (const pattern of datePatterns) {
          if (line.includes(pattern) || line.toLowerCase().includes('friday')) {
            addLog(`Found potential Friday content: "${line}"`);
            
            // Look for availability keywords
            if (line.toLowerCase().includes('available') || 
                line.toLowerCase().includes('book') ||
                line.toLowerCase().includes('reserve') ||
                line.match(/\d+:\d+\s*(am|pm)/i)) {
              
              const court = {
                date: friday,
                time: line,
                found: new Date().toISOString()
              };
              
              availableCourts.push(court);
              foundAvailability = true;
              addLog(`FOUND AVAILABLE COURT: ${friday} - ${line}`);
            }
          }
        }
      }
    }
    
    if (!foundAvailability) {
      addLog('No courts available for upcoming Fridays');
      // Log a sample of what we found for debugging
      const sampleLines = lines.slice(0, 10);
      addLog(`Sample page content: ${sampleLines.join(' | ')}`);
    }
    
    // Update data
    const data = readData();
    const previousCount = data.availableCourts.length;
    data.availableCourts = availableCourts;
    data.lastChecked = new Date().toISOString();
    
    // If new courts found, create notification
    if (availableCourts.length > previousCount) {
      const newCourts = availableCourts.slice(previousCount);
      for (const court of newCourts) {
        const notification = {
          id: Date.now() + Math.random(),
          title: 'Tennis Court Available!',
          body: `Court available on ${court.date}: ${court.time}`,
          timestamp: new Date().toISOString(),
          read: false
        };
        data.notifications.push(notification);
        addLog(`Created notification: ${notification.body}`);
      }
    }
    
    writeData(data);
    addLog(`Scrape completed. Found ${availableCourts.length} available courts.`);
    
  } catch (error) {
    addLog(`Scraping error: ${error.message}`);
    console.error('Scraping error:', error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Tennis Court Monitor API',
    timestamp: new Date().toISOString()
  });
});

// Get logs
app.get('/api/logs', (req, res) => {
  const data = readData();
  res.json({ logs: data.logs.slice(-50) }); // Return last 50 logs
});

// Get available courts
app.get('/api/courts', (req, res) => {
  const data = readData();
  res.json({ 
    courts: data.availableCourts,
    lastChecked: data.lastChecked
  });
});

// Get notifications
app.get('/api/notifications', (req, res) => {
  const data = readData();
  res.json({ notifications: data.notifications });
});

// Mark notification as read
app.put('/api/notifications/:id/read', (req, res) => {
  const data = readData();
  const notification = data.notifications.find(n => n.id == req.params.id);
  if (notification) {
    notification.read = true;
    writeData(data);
  }
  res.json({ success: true });
});

// Manual scrape trigger
app.post('/api/scrape', async (req, res) => {
  addLog('Manual scrape triggered');
  scrapeCourts();
  res.json({ message: 'Scrape started' });
});

// Subscribe for notifications (placeholder for push notification tokens)
app.post('/api/subscribe', (req, res) => {
  const { token } = req.body;
  if (token) {
    const data = readData();
    if (!data.subscribers.includes(token)) {
      data.subscribers.push(token);
      writeData(data);
      addLog(`New subscriber added: ${token.substring(0, 20)}...`);
    }
  }
  res.json({ success: true });
});

// Initialize data and start server
initializeData();

app.listen(PORT, () => {
  console.log(`Tennis Court Monitor API running on port ${PORT}`);
  addLog(`Server started on port ${PORT}`);
  
  // Run initial scrape after 5 seconds
  setTimeout(() => {
    addLog('Running initial scrape...');
    scrapeCourts();
  }, 5000);
});

// Schedule scraping every 30 minutes
cron.schedule('*/30 * * * *', () => {
  addLog('Scheduled scrape starting...');
  scrapeCourts();
});

// Also scrape every Friday at 8 AM
cron.schedule('0 8 * * 5', () => {
  addLog('Friday morning scrape starting...');
  scrapeCourts();
});
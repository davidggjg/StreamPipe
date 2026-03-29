const https = require('https');
const express = require('express');

// -------------------------------
// 1. קריאת משתני סביבה
// -------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ARCHIVE_KEY = process.env.ARCHIVE_KEY;
const ARCHIVE_SECRET = process.env.ARCHIVE_SECRET;
const ARCHIVE_BUCKET = (process.env.ARCHIVE_BUCKET || 'mybucket').toLowerCase().replace(/[^a-z0-9-]/g, '-');
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !ARCHIVE_KEY || !ARCHIVE_SECRET) {
  console.error('❌ חסרים משתני סביבה: BOT_TOKEN, ARCHIVE_KEY, ARCHIVE_SECRET');
  process.exit(1);
}

// -------------------------------
// 2. מחק Webhook
// -------------------------------
async function deleteWebhook() {
  return new Promise((resolve, reject) => {
    const url = `${TELEGRAM_API}/deleteWebhook`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const ok = JSON.parse(data).ok;
        ok ? resolve() : reject(new Error('deleteWebhook failed'));
      });
    }).on('error', reject);
  });
}

// -------------------------------
// 3. שליחת הודעה
// -------------------------------
function sendMessage(chatId, text) {
  const data = JSON.stringify({ chat_id: chatId, text });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// -------------------------------
// 4. קבלת file_path
// -------------------------------
async function getFilePath(fileId) {
  return new Promise((resolve, reject) => {
    const url = `${TELEGRAM_API}/getFile?file_id=${fileId}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (!json.ok) return reject(new Error('getFile failed'));
        resolve(json.result.file_path);
      });
    }).on('error', reject);
  });
}

// -------------------------------
// 5. Stream ישיר
// -------------------------------
function pipeToArchive(downloadUrl, uploadUrl, headers) {
  return new Promise((resolve, reject) => {
    https.get(downloadUrl, (dlRes) => {
      if (!headers['Content-Length'] && dlRes.headers['content-length']) {
        headers['Content-Length'] = dlRes.headers['content-length'];
      }
      const req = https.request(uploadUrl, { method: 'PUT', headers }, (archiveRes) => {
        let body = '';
        archiveRes.on('data', c => body += c);
        archiveRes.on('end', () => {
          if (archiveRes.statusCode >= 200 && archiveRes.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Archive ${archiveRes.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', reject);
      dlRes.pipe(req);
    }).on('error', reject);
  });
}

// -------------------------------
// 6. טיפול בהודעה
// -------------------------------
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const video = msg.video || msg.document;
  if (!video) return;

  const fileName = video.file_name || `video_${Date.now()}.mp4`;
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const uploadUrl = `https://s3.us.archive.org/${ARCHIVE_BUCKET}/${safeFileName}`;

  await sendMessage(chatId, `📥 קיבלתי את "${fileName}"\n🚀 מתחיל העלאה ל‑Archive.org...`);

  try {
    const filePath = await getFilePath(video.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const headers = {
      'Authorization': `LOW ${ARCHIVE_KEY}:${ARCHIVE_SECRET}`,
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta-mediatype': 'movies'
    };
    await pipeToArchive(downloadUrl, uploadUrl, headers);
    const resultUrl = `https://archive.org/download/${ARCHIVE_BUCKET}/${safeFileName}`;
    await sendMessage(chatId, `✅ הסרט הועלה בהצלחה!\n🔗 ${resultUrl}`);
  } catch (err) {
    console.error('שגיאה:', err.message);
    await sendMessage(chatId, `❌ ההעלאה נכשלה:\n${err.message}`);
  }
}

// -------------------------------
// 7. Long Polling
// -------------------------------
let lastUpdateId = 0;
async function pollUpdates() {
  try {
    const url = `${TELEGRAM_API}/getUpdates?timeout=30&offset=${lastUpdateId + 1}`;
    const response = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(JSON.parse(data)));
        res.on('error', reject);
      });
    });
    if (response.ok && response.result.length > 0) {
      for (const update of response.result) {
        lastUpdateId = update.update_id;
        if (update.message) await handleMessage(update.message);
      }
    }
  } catch (err) {
    console.error('Polling error:', err.message);
  } finally {
    setTimeout(pollUpdates, 1000);
  }
}

// -------------------------------
// 8. Express server
// -------------------------------
const app = express();
app.get('/health', (req, res) => res.send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Health check server on port ${PORT}`));

// -------------------------------
// 9. אתחול
// -------------------------------
(async () => {
  console.log('🧹 מוחק webhook...');
  await deleteWebhook();
  console.log('✅ Webhook נמחק, מתחיל Long Polling');
  pollUpdates();
})();

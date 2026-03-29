const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const app      = express();

app.use(express.json());
app.use(express.static('public'));

const KEYS_FILE = path.join(__dirname, 'keys.json');

function loadKeys() {
  try {
    if (fs.existsSync(KEYS_FILE))
      return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveKeys(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

app.get('/healthz', (req, res) => res.send('OK'));

// ── שמירת מפתחות ──
app.post('/save-keys', async (req, res) => {
  const { archiveKey, archiveSecret, bucketName, botToken } = req.body;
  if (!archiveKey || !archiveSecret || !bucketName || !botToken)
    return res.status(400).json({ ok: false, msg: '❌ כל השדות חובה' });

  // בדיקת Archive.org
  try {
    await axios.get('https://s3.us.archive.org', {
      headers: { Authorization: `LOW ${archiveKey}:${archiveSecret}` },
      timeout: 8000,
    });
  } catch (err) {
    const s = err.response?.status;
    if (s === 403)
      return res.status(400).json({ ok: false, msg: '❌ מפתחות Archive.org שגויים' });
    if (!err.response)
      return res.status(400).json({ ok: false, msg: `❌ שגיאת רשת: ${err.message}` });
  }

  // בדיקת Bot Token
  try {
    const r = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 8000 });
    if (!r.data.ok) throw new Error('invalid token');
  } catch (err) {
    return res.status(400).json({ ok: false, msg: '❌ Bot Token שגוי — בדוק שהעתקת נכון' });
  }

  saveKeys({ archiveKey, archiveSecret, bucketName, botToken });
  res.json({ ok: true, msg: '✅ המפתחות נשמרו בהצלחה!' });
});

app.get('/keys-status', (req, res) => {
  const keys = loadKeys();
  res.json({
    hasKeys: !!(keys.archiveKey && keys.archiveSecret && keys.bucketName && keys.botToken),
    bucketName: keys.bucketName || null,
  });
});

// ── קבלת עדכונים מטלגרם (Webhook) ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // תמיד עונים מיד לטלגרם

  const keys = loadKeys();
  if (!keys.botToken || !keys.archiveKey) return;

  const msg = req.body.message || req.body.channel_post;
  if (!msg) return;

  const chatId = msg.chat.id;
  const video  = msg.video || msg.document;
  if (!video) return;

  const fileId   = video.file_id;
  const fileName = (msg.document?.file_name || video.file_name || `video_${fileId}.mp4`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  try {
    // שלב 1: שלוף את ה-file_path מטלגרם
    await sendMessage(keys.botToken, chatId, `⏳ מתחיל העלאה של ${fileName}...`);

    const fileRes = await axios.get(
      `https://api.telegram.org/bot${keys.botToken}/getFile?file_id=${fileId}`,
      { timeout: 15000 }
    );
    const filePath = fileRes.data.result.file_path;
    const dlUrl    = `https://api.telegram.org/file/bot${keys.botToken}/${filePath}`;

    // שלב 2: פתח stream מטלגרם
    const stream = await axios.get(dlUrl, {
      responseType: 'stream',
      timeout: 0,
    });

    // שלב 3: העלה ישירות לארכיון
    const bucket    = keys.bucketName;
    const uploadUrl = `https://s3.us.archive.org/${bucket}/${fileName}`;

    const headers = {
      Authorization:                `LOW ${keys.archiveKey}:${keys.archiveSecret}`,
      'Content-Type':               stream.headers['content-type'] || 'video/mp4',
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta-mediatype':   'movies',
      'x-archive-meta-title':       fileName,
    };
    if (stream.headers['content-length'])
      headers['Content-Length'] = stream.headers['content-length'];

    await axios.put(uploadUrl, stream.data, {
      headers,
      maxBodyLength:    Infinity,
      maxContentLength: Infinity,
      timeout:          0,
    });

    const archiveUrl = `https://archive.org/download/${bucket}/${fileName}`;
    await sendMessage(keys.botToken, chatId,
      `✅ הועלה בהצלחה!\n\n🔗 ${archiveUrl}`
    );

  } catch (err) {
    console.error('[webhook] ❌', err.message);
    await sendMessage(keys.botToken, chatId, `❌ שגיאה: ${err.message}`);
  }
});

async function sendMessage(token, chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId, text,
    });
  } catch (e) {}
}

// ── הגדרת Webhook אוטומטית ──
app.post('/set-webhook', async (req, res) => {
  const keys = loadKeys();
  if (!keys.botToken)
    return res.status(400).json({ ok: false, msg: '❌ אין Bot Token' });

  const host       = req.headers.host;
  const webhookUrl = `https://${host}/webhook`;

  try {
    await axios.get(
      `https://api.telegram.org/bot${keys.botToken}/setWebhook?url=${webhookUrl}`,
      { timeout: 8000 }
    );
    res.json({ ok: true, msg: `✅ Webhook הוגדר ל-${webhookUrl}` });
  } catch (err) {
    res.status(500).json({ ok: false, msg: `❌ ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚰 StreamPipe פועל על פורט ${PORT}`));

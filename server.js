const express = require('express');
const axios   = require('axios');
const https   = require('https');
const app     = express();

app.use(express.json());
app.use(express.static('public'));

function getKeys() {
  return {
    archiveKey:    process.env.ARCHIVE_KEY,
    archiveSecret: process.env.ARCHIVE_SECRET,
    bucketName:    process.env.ARCHIVE_BUCKET,
    botToken:      process.env.BOT_TOKEN,
  };
}

function pipeToArchive(dlUrl, uploadUrl, headers) {
  return new Promise((resolve, reject) => {
    https.get(dlUrl, (dlRes) => {
      if (!headers['Content-Length'] && dlRes.headers['content-length'])
        headers['Content-Length'] = dlRes.headers['content-length'];
      const req = https.request(uploadUrl, { method: 'PUT', headers }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Archive ${res.statusCode}: ${body}`));
        });
      });
      req.on('error', reject);
      dlRes.pipe(req);
    }).on('error', reject);
  });
}

async function sendMessage(token, chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId, text,
    });
  } catch(e) {}
}

app.get('/healthz', (req, res) => res.send('OK'));

app.get('/keys-status', (req, res) => {
  const k = getKeys();
  res.json({
    hasKeys:    !!(k.archiveKey && k.archiveSecret && k.bucketName && k.botToken),
    bucketName: k.bucketName || null,
  });
});

app.post('/save-token', async (req, res) => {
  const { botToken } = req.body;
  if (!botToken)
    return res.status(400).json({ ok: false, msg: '❌ Token חסר' });
  try {
    const r = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 8000 });
    if (!r.data.ok) throw new Error('invalid');
    process.env.BOT_TOKEN = botToken;
    res.json({ ok: true, msg: `✅ בוט מחובר: @${r.data.result.username}` });
  } catch(e) {
    res.status(400).json({ ok: false, msg: '❌ Token שגוי' });
  }
});

app.post('/set-webhook', async (req, res) => {
  const k = getKeys();
  if (!k.botToken)
    return res.status(400).json({ ok: false, msg: '❌ BOT_TOKEN חסר' });
  const webhookUrl = `https://${req.headers.host}/webhook`;
  try {
    await axios.get(`https://api.telegram.org/bot${k.botToken}/setWebhook?url=${webhookUrl}`, { timeout: 8000 });
    res.json({ ok: true, msg: '✅ הבוט הופעל בהצלחה!' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: `❌ ${err.message}` });
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const k = getKeys();
  if (!k.botToken || !k.archiveKey) return;

  const msg = req.body.message || req.body.channel_post;
  if (!msg) return;

  const chatId = msg.chat.id;
  const video  = msg.video || msg.document;
  if (!video) return;

  const mime = video.mime_type || '';
  if (msg.document && !mime.startsWith('video/')) {
    await sendMessage(k.botToken, chatId, '❌ אנא שלח קובץ וידאו בלבד');
    return;
  }

  const fileId   = video.file_id;
  const fileSize = video.file_size || 0;
  const fileName = (msg.document?.file_name || `video_${fileId}.mp4`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  const sizeMB  = (fileSize / 1024 / 1024).toFixed(1);
  const estSec  = Math.ceil(fileSize / (3 * 1024 * 1024));
  const timeStr = estSec < 60 ? `~${estSec} שניות` : `~${Math.ceil(estSec/60)} דקות`;

  try {
    await sendMessage(k.botToken, chatId,
      `📥 קיבלתי!\n\n📄 ${fileName}\n📦 ${sizeMB} MB\n⏱ זמן משוער: ${timeStr}\n\n⏳ מעלה לארכיון...`
    );

    const fileRes  = await axios.get(`https://api.telegram.org/bot${k.botToken}/getFile?file_id=${fileId}`, { timeout: 15000 });
    const filePath = fileRes.data.result.file_path;
    const dlUrl    = `https://api.telegram.org/file/bot${k.botToken}/${filePath}`;
    const uploadUrl = `https://s3.us.archive.org/${k.bucketName}/${fileName}`;

    const headers = {
      'Authorization':                `LOW ${k.archiveKey}:${k.archiveSecret}`,
      'Content-Type':               mime || 'video/mp4',
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta-mediatype':   'movies',
      'x-archive-meta-title':       fileName,
    };
    if (fileSize) headers['Content-Length'] = String(fileSize);

    const start = Date.now();
    await pipeToArchive(dlUrl, uploadUrl, headers);
    const took = Math.ceil((Date.now() - start) / 1000);
    const tookStr = took < 60 ? `${took} שניות` : `${Math.ceil(took/60)} דקות`;

    const archiveUrl = `https://archive.org/download/${k.bucketName}/${fileName}`;
    await sendMessage(k.botToken, chatId, `✅ הועלה בהצלחה!\n\n⏱ לקח: ${tookStr}\n\n🔗 ${archiveUrl}`);

  } catch (err) {
    console.error('[webhook] ❌', err.message);
    await sendMessage(k.botToken, chatId, `❌ שגיאה: ${err.message}`);
  }
});

// הגדרת webhook אוטומטית בעליית השרת
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚰 StreamPipe פועל על פורט ${PORT}`);
  const k = getKeys();
  if (k.botToken) {
    try {
      const webhookUrl = `https://streampipe.onrender.com/webhook`;
      await axios.get(`https://api.telegram.org/bot${k.botToken}/setWebhook?url=${webhookUrl}`, { timeout: 8000 });
      console.log(`✅ Webhook set: ${webhookUrl}`);
    } catch(e) {
      console.error('❌ Webhook setup failed:', e.message);
    }
  }
});

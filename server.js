const express = require('express');
const axios   = require('axios');
const https   = require('https');
const http    = require('http');
const app     = express();

app.use(express.json());
app.use(express.static('public'));

function loadKeys() {
  return {
    archiveKey:    process.env.ARCHIVE_KEY,
    archiveSecret: process.env.ARCHIVE_SECRET,
    bucketName:    process.env.ARCHIVE_BUCKET,
    botToken:      process.env.BOT_TOKEN,
  };
}

app.get('/healthz', (req, res) => res.send('OK'));

app.get('/keys-status', (req, res) => {
  const keys = loadKeys();
  res.json({
    hasKeys:    !!(keys.archiveKey && keys.archiveSecret && keys.bucketName && keys.botToken),
    bucketName: keys.bucketName || null,
  });
});

app.post('/save-token', async (req, res) => {
  const { botToken } = req.body;
  if (!botToken)
    return res.status(400).json({ ok: false, msg: '❌ Token חסר' });
  try {
    const r = await axios.get(
      `https://api.telegram.org/bot${botToken}/getMe`,
      { timeout: 8000 }
    );
    if (!r.data.ok) throw new Error('invalid');
    process.env.BOT_TOKEN = botToken;
    res.json({ ok: true, msg: `✅ בוט מחובר: @${r.data.result.username}` });
  } catch(e) {
    res.status(400).json({ ok: false, msg: '❌ Token שגוי' });
  }
});

app.post('/set-webhook', async (req, res) => {
  const keys = loadKeys();
  if (!keys.botToken)
    return res.status(400).json({ ok: false, msg: '❌ BOT_TOKEN חסר' });
  const webhookUrl = `https://${req.headers.host}/webhook`;
  try {
    await axios.get(
      `https://api.telegram.org/bot${keys.botToken}/setWebhook?url=${webhookUrl}`,
      { timeout: 8000 }
    );
    res.json({ ok: true, msg: '✅ הבוט הופעל בהצלחה!' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: `❌ ${err.message}` });
  }
});

// ── stream טהור בלי זיכרון ──
function pipeToArchive(dlUrl, uploadUrl, headers) {
  return new Promise((resolve, reject) => {
    const proto = dlUrl.startsWith('https') ? https : http;
    
    proto.get(dlUrl, (dlRes) => {
      if (headers['Content-Length'] === undefined && dlRes.headers['content-length'])
        headers['Content-Length'] = dlRes.headers['content-length'];

      const uploadReq = https.request(uploadUrl, {
        method:  'PUT',
        headers: headers,
      }, (uploadRes) => {
        let body = '';
        uploadRes.on('data', chunk => body += chunk);
        uploadRes.on('end', () => {
          if (uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Archive status ${uploadRes.statusCode}: ${body}`));
          }
        });
      });

      uploadReq.on('error', reject);
      dlRes.pipe(uploadReq);
    }).on('error', reject);
  });
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const keys = loadKeys();
  if (!keys.botToken || !keys.archiveKey) return;

  const msg = req.body.message || req.body.channel_post;
  if (!msg) return;

  const chatId = msg.chat.id;
  const video  = msg.video || msg.document;
  if (!video) return;

  const fileId   = video.file_id;
  const fileSize = video.file_size || 0;
  const fileName = (msg.document?.file_name || video.file_name || `video_${fileId}.mp4`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  const sizeMB   = (fileSize / 1024 / 1024).toFixed(1);
  const estSec   = Math.ceil(fileSize / (3 * 1024 * 1024));
  const timeStr  = estSec < 60 ? `~${estSec} שניות` : `~${Math.ceil(estSec/60)} דקות`;

  try {
    await sendMessage(keys.botToken, chatId,
      `📥 קיבלתי את הקובץ!\n\n` +
      `📄 שם: ${fileName}\n` +
      `📦 גודל: ${sizeMB} MB\n` +
      `⏱ זמן משוער: ${timeStr}\n\n` +
      `⏳ מעלה לארכיון...`
    );

    // שלוף file_path מטלגרם
    const fileRes  = await axios.get(
      `https://api.telegram.org/bot${keys.botToken}/getFile?file_id=${fileId}`,
      { timeout: 15000 }
    );
    const filePath = fileRes.data.result.file_path;
    const dlUrl    = `https://api.telegram.org/file/bot${keys.botToken}/${filePath}`;
    const uploadUrl = `https://s3.us.archive.org/${keys.bucketName}/${fileName}`;

    const headers = {
      'Authorization':                `LOW ${keys.archiveKey}:${keys.archiveSecret}`,
      'Content-Type':               'video/mp4',
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta-mediatype':   'movies',
      'x-archive-meta-title':       fileName,
    };
    if (fileSize) headers['Content-Length'] = String(fileSize);

    const startTime = Date.now();
    await pipeToArchive(dlUrl, uploadUrl, headers);

    const tookSec = Math.ceil((Date.now() - startTime) / 1000);
    const tookStr = tookSec < 60 ? `${tookSec} שניות` : `${Math.ceil(tookSec/60)} דקות`;

    const archiveUrl = `https://archive.org/download/${keys.bucketName}/${fileName}`;
    await sendMessage(keys.botToken, chatId,
      `✅ הועלה בהצלחה!\n\n` +
      `⏱ לקח: ${tookStr}\n\n` +
      `🔗 ${archiveUrl}`
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
  } catch(e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚰 StreamPipe פועל על פורט ${PORT}`));

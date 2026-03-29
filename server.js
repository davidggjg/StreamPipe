const express = require('express');
const axios   = require('axios');
const https   = require('https');
const app     = express();
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
          else reject(new Error(`Archive ${res.statusCode}: ${body.slice(0, 200)}`));
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

async function handleVideo(token, chatId, video, document) {
  const k = getKeys();
  const file = video || document;
  if (!file) return;

  const mime = file.mime_type || '';
  if (document && !mime.startsWith('video/')) {
    await sendMessage(token, chatId, '❌ אנא שלח קובץ וידאו בלבד');
    return;
  }

  const fileId   = file.file_id;
  const fileSize = file.file_size || 0;
  const fileName = (document?.file_name || `video_${fileId}.mp4`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  const sizeMB  = (fileSize / 1024 / 1024).toFixed(1);
  const estSec  = Math.ceil(fileSize / (3 * 1024 * 1024));
  const timeStr = estSec < 60 ? `~${estSec} שניות` : `~${Math.ceil(estSec/60)} דקות`;

  await sendMessage(token, chatId,
    `📥 קיבלתי!\n\n📄 ${fileName}\n📦 ${sizeMB} MB\n⏱ זמן משוער: ${timeStr}\n\n⏳ מעלה לארכיון...`
  );

  try {
    const fileRes  = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`, { timeout: 15000 });
    const filePath = fileRes.data.result.file_path;
    const dlUrl    = `https://api.telegram.org/file/bot${token}/${filePath}`;
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
    await sendMessage(token, chatId, `✅ הועלה בהצלחה!\n\n⏱ לקח: ${tookStr}\n\n🔗 ${archiveUrl}`);

  } catch (err) {
    console.error('[upload] ❌', err.message);
    await sendMessage(token, chatId, `❌ שגיאה: ${err.message}`);
  }
}

// ── Long Polling ──
let offset = 0;
let polling = false;

async function startPolling(token) {
  if (polling) return;
  polling = true;
  console.log('🤖 Long Polling מתחיל...');

  // מחק webhook קודם
  try {
    await axios.get(`https://api.telegram.org/bot${token}/deleteWebhook`, { timeout: 8000 });
  } catch(e) {}

  while (polling) {
    try {
      const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
        params: { offset, timeout: 30, allowed_updates: ['message'] },
        timeout: 35000,
      });

      const updates = res.data.result || [];
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;

        const chatId = msg.chat.id;

        if (msg.text === '/start') {
          await sendMessage(token, chatId, '👋 שלום!\n\nשלח לי קובץ וידאו ואני אעלה אותו לארכיון 🚀');
          continue;
        }

        if (msg.video || msg.document) {
          handleVideo(token, chatId, msg.video, msg.document);
        }
      }
    } catch(e) {
      if (e.code !== 'ECONNABORTED') console.error('[polling]', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Routes ──
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

// ── הפעלה ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚰 StreamPipe פועל על פורט ${PORT}`);
  const k = getKeys();
  if (k.botToken) {
    startPolling(k.botToken);
  } else {
    console.log('⚠️ BOT_TOKEN חסר — Long Polling לא פעיל');
  }
});

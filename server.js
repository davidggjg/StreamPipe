const express = require('express');
const axios   = require('axios');
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

  const sizeMB     = (fileSize / 1024 / 1024).toFixed(1);
  const estSeconds = Math.ceil(fileSize / (5 * 1024 * 1024));
  const estMinutes = Math.ceil(estSeconds / 60);
  const timeStr    = estMinutes < 2 ? `~${estSeconds} שניות` : `~${estMinutes} דקות`;

  try {
    await sendMessage(keys.botToken, chatId,
      `📥 קיבלתי את הקובץ!\n\n` +
      `📄 שם: ${fileName}\n` +
      `📦 גודל: ${sizeMB} MB\n` +
      `⏱ זמן משוער: ${timeStr}\n\n` +
      `⏳ מעלה לארכיון...`
    );

    const fileRes = await axios.get(
      `https://api.telegram.org/bot${keys.botToken}/getFile?file_id=${fileId}`,
      { timeout: 15000 }
    );
    const filePath = fileRes.data.result.file_path;
    const dlUrl    = `https://api.telegram.org/file/bot${keys.botToken}/${filePath}`;

    const stream = await axios.get(dlUrl, {
      responseType: 'stream',
      timeout: 0,
    });

    const uploadUrl = `https://s3.us.archive.org/${keys.bucketName}/${fileName}`;
    const headers = {
      Authorization:                `LOW ${keys.archiveKey}:${keys.archiveSecret}`,
      'Content-Type':               stream.headers['content-type'] || 'video/mp4',
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta-mediatype':   'movies',
      'x-archive-meta-title':       fileName,
    };
    if (stream.headers['content-length'])
      headers['Content-Length'] = stream.headers['content-length'];

    const startTime = Date.now();

    await axios.put(uploadUrl, stream.data, {
      headers,
      maxBodyLength:    Infinity,
      maxContentLength: Infinity,
      timeout:          0,
    });

    const tookSeconds = Math.ceil((Date.now() - startTime) / 1000);
    const tookStr     = tookSeconds < 60
      ? `${tookSeconds} שניות`
      : `${Math.ceil(tookSeconds / 60)} דקות`;

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

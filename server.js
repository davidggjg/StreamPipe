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
  const fileName = (msg.document?.file_name || video.file_name || `video_${fileId}.mp4`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  try {
    await sendMessage(keys.botToken, chatId, `⏳ מתחיל העלאה של ${fileName}...`);

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

    await axios.put(uploadUrl, stream.data, {
      headers,
      maxBodyLength:    Infinity,
      maxContentLength: Infinity,
      timeout:          0,
    });

    const archiveUrl = `https://archive.org/download/${keys.bucketName}/${fileName}`;
    await sendMessage(keys.botToken, chatId, `✅ הועלה בהצלחה!\n\n🔗 ${archiveUrl}`);

  } catch (err) {
    console.error('[webhook] ❌', err.message);
    await sendMessage(keys.botToken, chatId, `❌ שגיאה: ${err.message}`);
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

async function sendMessage(token, chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId, text,
    });
  } catch(e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚰 StreamPipe פועל על פורט ${PORT}`));

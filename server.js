const express  = require('express');
const { Telegraf } = require('telegraf');
const axios    = require('axios');
const https    = require('https');
const app      = express();

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

// ── צינור stream טהור ──
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

// ── הגדרת הבוט ──
function createBot(token) {
  const bot = new Telegraf(token);

  bot.start((ctx) => ctx.reply(
    '👋 שלום!\n\nשלח לי קובץ וידאו ואני אעלה אותו לארכיון אוטומטית 🚀'
  ));

  bot.help((ctx) => ctx.reply(
    '📖 איך להשתמש:\n\n1. שלח קובץ וידאו\n2. המתן לאישור\n3. קבל קישור לארכיון ✅'
  ));

  bot.on(['video', 'document'], async (ctx) => {
    const keys = getKeys();
    const msg  = ctx.message;
    const file = msg.video || msg.document;

    if (!file) return;

    // וידוא שזה קובץ וידאו
    const mime = file.mime_type || '';
    if (msg.document && !mime.startsWith('video/'))
      return ctx.reply('❌ אנא שלח קובץ וידאו בלבד');

    const fileId   = file.file_id;
    const fileSize = file.file_size || 0;
    const fileName = (msg.document?.file_name || `video_${fileId}.mp4`)
      .replace(/[^a-zA-Z0-9._-]/g, '_');

    const sizeMB  = (fileSize / 1024 / 1024).toFixed(1);
    const estSec  = Math.ceil(fileSize / (3 * 1024 * 1024));
    const timeStr = estSec < 60 ? `~${estSec} שניות` : `~${Math.ceil(estSec/60)} דקות`;

    await ctx.reply(
      `📥 קיבלתי!\n\n` +
      `📄 ${fileName}\n` +
      `📦 ${sizeMB} MB\n` +
      `⏱ זמן משוער: ${timeStr}\n\n` +
      `⏳ מעלה לארכיון...`
    );

    try {
      const fileRes  = await ctx.telegram.getFile(fileId);
      const dlUrl    = `https://api.telegram.org/file/bot${token}/${fileRes.file_path}`;
      const uploadUrl = `https://s3.us.archive.org/${keys.bucketName}/${fileName}`;

      const headers = {
        'Authorization':                `LOW ${keys.archiveKey}:${keys.archiveSecret}`,
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

      const archiveUrl = `https://archive.org/download/${keys.bucketName}/${fileName}`;
      await ctx.reply(`✅ הועלה בהצלחה!\n\n⏱ לקח: ${tookStr}\n\n🔗 ${archiveUrl}`);

    } catch (err) {
      console.error('[bot] ❌', err.message);
      await ctx.reply(`❌ שגיאה: ${err.message}`);
    }
  });

  return bot;
}

// ── Routes ──
app.get('/healthz', (req, res) => res.send('OK'));

app.get('/keys-status', (req, res) => {
  const keys = getKeys();
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
    const r = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 8000 });
    if (!r.data.ok) throw new Error('invalid');
    process.env.BOT_TOKEN = botToken;
    res.json({ ok: true, msg: `✅ בוט מחובר: @${r.data.result.username}` });
  } catch(e) {
    res.status(400).json({ ok: false, msg: '❌ Token שגוי' });
  }
});

app.post('/set-webhook', async (req, res) => {
  const keys = getKeys();
  if (!keys.botToken)
    return res.status(400).json({ ok: false, msg: '❌ BOT_TOKEN חסר' });

  const webhookUrl = `https://${req.headers.host}/bot${keys.botToken}`;

  try {
    const bot = createBot(keys.botToken);
    await bot.telegram.setWebhook(webhookUrl);
    app.use(bot.webhookCallback(`/bot${keys.botToken}`));
    res.json({ ok: true, msg: '✅ הבוט הופעל בהצלחה!' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: `❌ ${err.message}` });
  }
});

// ── הפעלה ──
const PORT = process.env.PORT || 3000;
const keys  = getKeys();

if (keys.botToken) {
  const bot        = createBot(keys.botToken);
  const webhookPath = `/bot${keys.botToken}`;
  const webhookUrl  = `https://streampipe.onrender.com${webhookPath}`;

  bot.telegram.setWebhook(webhookUrl).then(() => {
    console.log(`✅ Webhook set: ${webhookUrl}`);
  });

  app.use(bot.webhookCallback(webhookPath));
}

app.listen(PORT, () => console.log(`🚰 StreamPipe פועל על פורט ${PORT}`));
ועדכן package.json — הוסף את telegraf:
{
  "name": "streampipe",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "axios": "^1.6.0",
    "telegraf": "^4.16.3"
  }
}

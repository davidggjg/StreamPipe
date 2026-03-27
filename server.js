const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const app     = express();

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

app.post('/save-keys', async (req, res) => {
  const { archiveKey, archiveSecret, bucketName, googleApiKey } = req.body;

  if (!archiveKey || !archiveSecret || !bucketName || !googleApiKey)
    return res.status(400).json({
      ok: false,
      msg: '❌ כל השדות חובה כולל Google API Key'
    });

  // בדיקת מפתחות Archive.org
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

  // בדיקת Google API Key
  try {
    await axios.get(
      `https://www.googleapis.com/drive/v3/about?fields=user&key=${googleApiKey}`,
      { timeout: 8000 }
    );
  } catch (err) {
    const s = err.response?.status;
    if (s === 400 || s === 403 || s === 401)
      return res.status(400).json({ ok: false, msg: '❌ Google API Key שגוי — בדוק שהעתקת נכון ושה-Drive API מופעל' });
    // שגיאות אחרות — המפתח בסדר, ממשיכים
  }

  saveKeys({ archiveKey, archiveSecret, bucketName, googleApiKey });
  res.json({ ok: true, msg: '✅ כל המפתחות נשמרו ונבדקו בהצלחה!' });
});

app.get('/keys-status', (req, res) => {
  const keys = loadKeys();
  res.json({
    hasKeys: !!(keys.archiveKey && keys.archiveSecret && keys.bucketName && keys.googleApiKey),
    bucketName: keys.bucketName || null,
  });
});

function extractFileId(url) {
  const m1 = url.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]{25,})/);
  if (m2) return m2[1];
  return null;
}

async function getDownloadStream(fileId, googleApiKey) {
  const metaRes = await axios.get(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType&key=${googleApiKey}`,
    { timeout: 15000 }
  );
  const { name, size, mimeType } = metaRes.data;
  console.log(`[pipe] 📄 ${name} | ${size} bytes | ${mimeType}`);

  const dlRes = await axios.get(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${googleApiKey}`,
    {
      responseType: 'stream',
      timeout: 0,
      maxRedirects: 10,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }
  );

  return {
    stream:        dlRes.data,
    contentType:   mimeType || dlRes.headers['content-type'] || 'application/octet-stream',
    contentLength: size     || dlRes.headers['content-length'] || null,
    fileName:      name,
  };
}

app.post('/pipe', async (req, res) => {
  const { driveUrl, fileName, bucketName: bucketOverride } = req.body;
  const keys = loadKeys();

  if (!keys.archiveKey || !keys.archiveSecret || !keys.googleApiKey)
    return res.status(400).json({ ok: false, msg: '❌ מפתחות לא מוגדרים — פתח הגדרות (⚙)' });

  if (!driveUrl)
    return res.status(400).json({ ok: false, msg: '❌ הכנס קישור גוגל דרייב' });

  const fileId = extractFileId(driveUrl);
  if (!fileId)
    return res.status(400).json({ ok: false, msg: '❌ קישור לא תקין' });

  const bucket = bucketOverride || keys.bucketName;

  try {
    console.log(`[pipe] ⬇️  id=${fileId}`);
    const { stream, contentType, contentLength, fileName: autoName } = await getDownloadStream(fileId, keys.googleApiKey);

    const destFile = (fileName || autoName || `file_${fileId}`)
      .replace(/[^a-zA-Z0-9._-]/g, '_');

    const uploadUrl = `https://s3.us.archive.org/${bucket}/${destFile}`;
    console.log(`[pipe] ⬆️  ${uploadUrl}`);

    const headers = {
      Authorization:                `LOW ${keys.archiveKey}:${keys.archiveSecret}`,
      'Content-Type':               contentType,
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta-mediatype':   'movies',
      'x-archive-meta-title':       destFile,
    };
    if (contentLength) headers['Content-Length'] = String(contentLength);

    await axios.put(uploadUrl, stream, {
      headers,
      maxBodyLength:    Infinity,
      maxContentLength: Infinity,
      timeout:          0,
    });

    const archiveUrl = `https://archive.org/download/${bucket}/${destFile}`;
    console.log(`[pipe] ✅ ${archiveUrl}`);
    res.json({ ok: true, msg: 'הועלה בהצלחה! 🎉', archiveUrl });

  } catch (err) {
    console.error('[pipe] ❌', err.response?.data || err.message);
    const msg = err.response?.status === 403
      ? '❌ גוגל חסם את הגישה — ודא שהקובץ ציבורי'
      : `❌ שגיאה: ${err.message}`;
    res.status(500).json({ ok: false, msg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚰 StreamPipe פועל על פורט ${PORT}`));

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
  const { archiveKey, archiveSecret, bucketName } = req.body;

  if (!archiveKey || !archiveSecret || !bucketName)
    return res.status(400).json({
      ok: false,
      msg: '❌ כל השדות חובה — Access Key, Secret Key ושם Bucket'
    });

  try {
    await axios.get('https://s3.us.archive.org', {
      headers: { Authorization: `LOW ${archiveKey}:${archiveSecret}` },
      timeout: 8000,
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403)
      return res.status(400).json({ ok: false, msg: '❌ Access Key או Secret Key שגויים' });
    if (status === 401)
      return res.status(400).json({ ok: false, msg: '❌ המפתחות לא מורשים' });
    if (!err.response)
      return res.status(400).json({ ok: false, msg: `❌ שגיאת רשת: ${err.message}` });
    return res.status(400).json({ ok: false, msg: `❌ שגיאה ${status}: ${err.message}` });
  }

  saveKeys({ archiveKey, archiveSecret, bucketName });
  res.json({ ok: true, msg: '✅ המפתחות נשמרו בהצלחה!' });
});

app.get('/keys-status', (req, res) => {
  const keys = loadKeys();
  res.json({
    hasKeys: !!(keys.archiveKey && keys.archiveSecret && keys.bucketName),
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

async function getDownloadStream(fileId) {
  const baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const res1 = await axios.get(baseUrl, {
    responseType: 'stream', maxRedirects: 5, timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const ct = res1.headers['content-type'] || '';
  if (ct.includes('text/html')) {
    res1.data.destroy();
    const cookies = (res1.headers['set-cookie'] || [])
      .map(c => c.split(';')[0]).join('; ');
    const res2 = await axios.get(baseUrl + '&confirm=t', {
      responseType: 'stream', maxRedirects: 5, timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookies },
    });
    return {
      stream: res2.data,
      contentType: res2.headers['content-type'] || 'application/octet-stream',
      contentLength: res2.headers['content-length'] || null,
    };
  }
  return {
    stream: res1.data,
    contentType: ct || 'application/octet-stream',
    contentLength: res1.headers['content-length'] || null,
  };
}

app.post('/pipe', async (req, res) => {
  const { driveUrl, fileName, bucketName: bucketOverride } = req.body;
  const keys = loadKeys();

  if (!keys.archiveKey || !keys.archiveSecret)
    return res.status(400).json({ ok: false, msg: '❌ מפתחות לא מוגדרים — פתח הגדרות (⚙)' });

  if (!driveUrl)
    return res.status(400).json({ ok: false, msg: '❌ הכנס קישור גוגל דרייב' });

  const fileId = extractFileId(driveUrl);
  if (!fileId)
    return res.status(400).json({ ok: false, msg: '❌ קישור לא תקין' });

  const bucket   = bucketOverride || keys.bucketName;
  const destFile = (fileName || `file_${fileId}`).replace(/[^a-zA-Z0-9._-]/g, '_');

  try {
    console.log(`[pipe] ⬇️  id=${fileId}`);
    const { stream, contentType, contentLength } = await getDownloadStream(fileId);

    const uploadUrl = `https://s3.us.archive.org/${bucket}/${destFile}`;
    const headers = {
      Authorization:                `LOW ${keys.archiveKey}:${keys.archiveSecret}`,
      'Content-Type':               contentType,
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta-mediatype':   'movies',
    };
    if (contentLength) headers['Content-Length'] = contentLength;

    await axios.put(uploadUrl, stream, {
      headers,
      maxBodyLength:    Infinity,
      maxContentLength: Infinity,
      timeout:          0,
    });

    const archiveUrl = `https://archive.org/download/${bucket}/${destFile}`;
    console.log(`[pipe] ✅ ${archiveUrl}`);
    res.json({ ok: true, msg: 'הועלה בהצלחה!', archiveUrl });

  } catch (err) {
    console.error('[pipe] ❌', err.message);
    res.status(500).json({ ok: false, msg: `❌ שגיאה: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚰 StreamPipe פועל על פורט ${PORT}`));

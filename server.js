const express = require('express');
const axios   = require('axios');
const app     = express();

app.use(express.json());
app.use(express.static('public'));

// ── Health check בשביל UptimeRobot ──
app.get('/healthz', (req, res) => res.send('OK'));

// ── חילוץ File ID מקישור גוגל דרייב ──
function extractFileId(url) {
  const m1 = url.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]{25,})/);
  if (m2) return m2[1];
  return null;
}

// ── stream הורדה מגוגל כולל טיפול בדף אישור ──
async function getDownloadStream(fileId) {
  const baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  const res1 = await axios.get(baseUrl, {
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const ct = res1.headers['content-type'] || '';

  if (ct.includes('text/html')) {
    res1.data.destroy();
    const cookies = (res1.headers['set-cookie'] || [])
      .map(c => c.split(';')[0]).join('; ');

    const res2 = await axios.get(baseUrl + '&confirm=t', {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookies },
    });
    return {
      stream:        res2.data,
      contentType:   res2.headers['content-type'] || 'application/octet-stream',
      contentLength: res2.headers['content-length'] || null,
    };
  }

  return {
    stream:        res1.data,
    contentType:   ct || 'application/octet-stream',
    contentLength: res1.headers['content-length'] || null,
  };
}

// ── בדיקת מפתחות ──
app.post('/test-keys', async (req, res) => {
  const { archiveKey, archiveSecret } = req.body;
  if (!archiveKey || !archiveSecret)
    return res.status(400).json({ ok: false, msg: 'מפתחות חסרים' });
  try {
    await axios.get('https://s3.us.archive.org', {
      headers: { Authorization: `LOW ${archiveKey}:${archiveSecret}` },
      timeout: 8000,
    });
    res.json({ ok: true, msg: 'המפתחות תקינים ✅' });
  } catch (err) {
    res.status(400).json({
      ok: false,
      msg: err.response?.status === 403 ? 'מפתחות שגויים ❌' : `שגיאה: ${err.message}`
    });
  }
});

// ── הצינור הראשי — אפס כתיבה לדיסק ──
app.post('/pipe', async (req, res) => {
  const { driveUrl, bucketName, fileName } = req.body;

  // מפתחות מגיעים מ-Environment Variables של Render
  const archiveKey    = process.env.ARCHIVE_KEY;
  const archiveSecret = process.env.ARCHIVE_SECRET;
  const bucket        = bucketName || process.env.ARCHIVE_BUCKET;

  if (!driveUrl || !archiveKey || !archiveSecret || !bucket)
    return res.status(400).json({ ok: false, msg: 'שדות חסרים או מפתחות לא מוגדרים בשרת' });

  const fileId = extractFileId(driveUrl);
  if (!fileId)
    return res.status(400).json({ ok: false, msg: 'לא הצלחתי לחלץ File ID' });

  const destFile = (fileName || `file_${fileId}`).replace(/[^a-zA-Z0-9._-]/g, '_');

  try {
    console.log(`[pipe] ⬇️  id=${fileId}`);
    const { stream, contentType, contentLength } = await getDownloadStream(fileId);

    const uploadUrl = `https://s3.us.archive.org/${bucket}/${destFile}`;
    const headers = {
      Authorization:                `LOW ${archiveKey}:${archiveSecret}`,
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
    res.status(500).json({ ok: false, msg: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚰 StreamPipe פועל על פורט ${PORT}`));

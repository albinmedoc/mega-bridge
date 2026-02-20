const express = require('express');
const mega = require('megajs');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '300000', 10);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/download', async (req, res) => {
  const { url, filename } = req.query;
  const start = Date.now();

  if (!url) {
    console.log(`[${new Date().toISOString()}] 400 - Missing url parameter`);
    return res.status(400).json({ error: 'Missing required query parameter: url' });
  }

  try {
    const file = mega.File.fromURL(url);
    await file.loadAttributes();

    const name = filename || file.name || 'download';
    const size = file.size;

    console.log(`[${new Date().toISOString()}] Downloading "${name}" (${size} bytes) from ${url}`);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (size) {
      res.setHeader('Content-Length', size);
    }

    const stream = file.download();
    const timer = setTimeout(() => {
      stream.destroy(new Error('Download timeout'));
    }, TIMEOUT_MS);

    stream.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[${new Date().toISOString()}] Stream error for "${name}": ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'MEGA download failed', details: err.message });
      } else {
        res.destroy();
      }
    });

    stream.on('end', () => {
      clearTimeout(timer);
      console.log(`[${new Date().toISOString()}] Completed "${name}" in ${Date.now() - start}ms`);
    });

    stream.pipe(res);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
    if (!res.headersSent) {
      const status = err.message.includes('Invalid') ? 400 : 502;
      res.status(status).json({ error: 'Failed to process MEGA URL', details: err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`mega-bridge listening on port ${PORT}`);
});

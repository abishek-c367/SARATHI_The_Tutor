const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 15 * 1024 * 1024 } });

// Accepts a .txt, .md, or .pdf file and returns extracted plain text,
// which the admin can then paste into a lesson or feed to the outline generator.
router.post('/extract', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const { path: filePath, originalname, mimetype } = req.file;
  try {
    let text = '';
    if (mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      text = data.text;
    } else {
      text = fs.readFileSync(filePath, 'utf8');
    }
    res.json({ text: text.slice(0, 50000) });
  } catch (e) {
    res.status(500).json({ error: 'Could not read that file: ' + e.message });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

module.exports = router;

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer — store in memory, then stream to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|avi/;
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (allowed.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only images and videos are allowed'));
    }
  },
});

app.use(express.static('public'));
app.use(express.json());

// Upload endpoint
app.post('/upload', upload.array('photos', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const guestName = req.body.guestName || 'Anonymous Guest';

  try {
    const uploadPromises = req.files.map((file) => {
      return new Promise((resolve, reject) => {
        const isVideo = /mp4|mov|avi/.test(
          path.extname(file.originalname).toLowerCase().replace('.', '')
        );
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'rannel-roxanne-wedding',
            resource_type: isVideo ? 'video' : 'image',
            context: { guest_name: guestName, uploaded_at: new Date().toISOString() },
            tags: ['wedding', 'guest-upload'],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(file.buffer);
      });
    });

    const results = await Promise.all(uploadPromises);
    res.json({
      success: true,
      count: results.length,
      files: results.map((r) => ({ url: r.secure_url, publicId: r.public_id })),
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// Gallery endpoint — returns all wedding photos
app.get('/gallery', async (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [imageResults, videoResults] = await Promise.all([
      cloudinary.search
        .expression('folder:rannel-roxanne-wedding AND resource_type:image')
        .sort_by('created_at', 'desc')
        .max_results(500)
        .execute(),
      cloudinary.search
        .expression('folder:rannel-roxanne-wedding AND resource_type:video')
        .sort_by('created_at', 'desc')
        .max_results(100)
        .execute(),
    ]);

    const all = [
      ...imageResults.resources.map((r) => ({ ...r, type: 'image' })),
      ...videoResults.resources.map((r) => ({ ...r, type: 'video' })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ count: all.length, media: all });
  } catch (err) {
    console.error('Gallery error:', err);
    res.status(500).json({ error: 'Could not load gallery' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n💍 Rannel & Roxanne Wedding App running at http://localhost:${PORT}\n`);
});

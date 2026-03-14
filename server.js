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

// Separate multer instance for voice/video messages
const messageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for video messages
  fileFilter: (req, file, cb) => {
    const isAudio = file.mimetype.startsWith('audio/');
    const isVideo = file.mimetype.startsWith('video/');
    if (isAudio || isVideo) {
      cb(null, true);
    } else {
      cb(new Error('Only audio and video files are allowed'));
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

// Voice / video message upload
app.post('/message', (req, res, next) => {
  messageUpload.single('recording')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No recording uploaded' });

  const guestName = req.body.guestName || 'Anonymous Guest';
  const messageType = req.body.messageType || 'voice'; // 'voice' | 'video'

  try {
    const result = await new Promise((resolve, reject) => {
      const ext = req.file.mimetype.includes('mp4') ? 'mp4'
                : req.file.mimetype.includes('ogg') ? 'ogg'
                : 'webm';
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'rannel-roxanne-wedding/messages',
          resource_type: 'video', // Cloudinary uses 'video' for audio too
          public_id: `msg-${Date.now()}`,
          format: ext,
          context: {
            guest_name: guestName,
            message_type: messageType,
            uploaded_at: new Date().toISOString(),
          },
          tags: ['wedding', 'message', messageType === 'video' ? 'video-message' : 'voice-message'],
        },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      uploadStream.end(req.file.buffer);
    });

    res.json({ success: true, url: result.secure_url, publicId: result.public_id, duration: result.duration });
  } catch (err) {
    console.error('Message upload error:', err);
    res.status(500).json({ error: 'Failed to save your message. Please try again.' });
  }
});

// Messages admin endpoint — returns all voice/video messages
app.get('/messages', async (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results = await cloudinary.search
      .expression('folder:rannel-roxanne-wedding/messages AND resource_type:video')
      .sort_by('created_at', 'desc')
      .with_field('context')
      .with_field('tags')
      .max_results(500)
      .execute();

    res.json({ count: results.resources.length, messages: results.resources });
  } catch (err) {
    console.error('Messages error:', err);
    res.status(500).json({ error: 'Could not load messages' });
  }
});

// QR code image endpoint — photo uploader
app.get('/qr-image', async (req, res) => {
  const QRCode = require('qrcode');
  const url = process.env.PUBLIC_URL || 'https://wedding-photos-dbc2.onrender.com';
  const buffer = await QRCode.toBuffer(url, {
    width: 200,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

// QR code image endpoint — voice/video message booth
app.get('/qr-message-image', async (req, res) => {
  const QRCode = require('qrcode');
  const base = process.env.PUBLIC_URL || 'https://wedding-photos-dbc2.onrender.com';
  const url = `${base}/message.html`;
  const buffer = await QRCode.toBuffer(url, {
    width: 200,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

// Cloudinary direct-upload signature — browser uploads straight to Cloudinary
app.get('/sign-upload', (req, res) => {
  const guestName = (req.query.guestName || 'Anonymous Guest').replace(/[|=]/g, ' ');
  const messageType = req.query.messageType === 'video' ? 'video' : 'voice';
  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'rannel-roxanne-wedding/messages';
  const context = `guest_name=${guestName}|message_type=${messageType}`;
  const tags = `wedding,message,${messageType === 'video' ? 'video-message' : 'voice-message'}`;
  const paramsToSign = { context, folder, tags, timestamp };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
  res.json({
    signature, timestamp, folder, context, tags,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n💍 Rannel & Roxanne Wedding App running at http://localhost:${PORT}\n`);
});

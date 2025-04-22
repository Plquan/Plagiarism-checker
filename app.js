// app.js
const express       = require('express');
const multer        = require('multer');
const path          = require('path');
const fs            = require('fs').promises;
const fsSync        = require('fs');
const mammoth       = require('mammoth');
const cors          = require('cors');
const axios         = require('axios');
const cheerio       = require('cheerio');

const DOCUMENTS_FOLDER = path.join(__dirname, 'documents');
const UPLOADS_FOLDER   = path.join(__dirname, 'uploads');
const app = express();
const PORT = 8000;

// Middleware
app.use(cors());
app.use(express.json());               // parse application/json
app.use(express.urlencoded({ extended: true })); // parse application/x-www-form-urlencoded
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Ensure folders exist
[DOCUMENTS_FOLDER, UPLOADS_FOLDER].forEach(dir => {
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
});

const upload = multer({ dest: UPLOADS_FOLDER });

// Rabin-Karp parameters
const DEFAULT_NGRAM_LENGTH = 10;
const DEFAULT_BASE         = 256;
const DEFAULT_MOD          = 1000003;

function preprocess(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function modPow(base, exp, mod) {
  let result = 1;
  for (let i = 0; i < exp; i++) result = (result * base) % mod;
  return result;
}

function computeHashes(text, k = DEFAULT_NGRAM_LENGTH, base = DEFAULT_BASE, mod = DEFAULT_MOD) {
  const n = text.length;
  if (n < k) return new Set();
  const hashSet = new Set();
  let h = 0;
  // initial hash
  for (let i = 0; i < k; i++) h = (h * base + text.charCodeAt(i)) % mod;
  hashSet.add(h);
  const power = modPow(base, k - 1, mod);
  // rolling
  for (let i = 1; i <= n - k; i++) {
    h = (h - text.charCodeAt(i - 1) * power) % mod;
    if (h < 0) h += mod;
    h = (h * base + text.charCodeAt(i + k - 1)) % mod;
    hashSet.add(h);
  }
  return hashSet;
}

function plagiarismScore(text1, text2, k = DEFAULT_NGRAM_LENGTH, base = DEFAULT_BASE, mod = DEFAULT_MOD) {
  const t1 = preprocess(text1);
  const t2 = preprocess(text2);
  const hashSet1 = computeHashes(t1, k, base, mod);
  const n2 = t2.length;
  if (n2 < k) return 0.0;
  let matchCount = 0;
  const total = n2 - k + 1;
  let h = 0;
  for (let i = 0; i < k; i++) h = (h * base + t2.charCodeAt(i)) % mod;
  if (hashSet1.has(h)) matchCount++;
  const power = modPow(base, k - 1, mod);
  for (let i = 1; i < total; i++) {
    h = (h - t2.charCodeAt(i - 1) * power) % mod;
    if (h < 0) h += mod;
    h = (h * base + t2.charCodeAt(i + k - 1)) % mod;
    if (hashSet1.has(h)) matchCount++;
  }
  return matchCount / total;
}

async function extractTextFromDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function scrapeText(url) {
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    $('script, style, nav, footer, header, aside').remove();
    const text = $('body').text() || $('article').text() || $('main').text() || $('.content').text();
    return text.replace(/\s+/g, ' ').trim();
  } catch (error) {
    console.error(`Error scraping ${url}:`, error.message);
    return '';
  }
}

async function scrapeMultipleUrls(urls) {
  const results = [];
  for (const url of urls) {
    try {
      new URL(url); // validate
      const text = await scrapeText(url);
      if (text) results.push({ url, text });
    } catch {
      console.warn(`Skipping invalid URL: ${url}`);
    }
  }
  return results;
}

// Home
app.get('/', (req, res) => {
  res.render('index', { title: 'Trang chủ', message: 'Kiểm tra đạo văn trực tuyến' });
});

// Check plagiarism (file)
app.post('/check_plagiarism', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Không có file được tải lên' });
    if (path.extname(req.file.originalname).toLowerCase() !== '.docx') {
      await fs.unlink(req.file.path);
      return res.status(400).json({ error: 'Chỉ cho phép file .docx' });
    }
    const inputText = await extractTextFromDocx(req.file.path);
    await fs.unlink(req.file.path);

    let urlsToCheck = [];
    
    // Sửa đổi đoạn này để xử lý đúng URLs
    if (req.body.urls) {
      try {
        // Kiểm tra nếu req.body.urls là chuỗi JSON
        if (typeof req.body.urls === 'string') {
          urlsToCheck = JSON.parse(req.body.urls);
        } else {
          urlsToCheck = Array.isArray(req.body.urls) ? req.body.urls : [req.body.urls];
        }
      } catch (e) {
        console.error("Lỗi khi phân tích URLs:", e);
        urlsToCheck = [];
      }
    }
    
    // Nếu không có URLs hợp lệ, sử dụng URLs mặc định
    if (!urlsToCheck || urlsToCheck.length === 0) {
      urlsToCheck = [
        'https://vi.wikipedia.org/wiki/Trang_Chính',
        'https://vnexpress.net/',
        'https://dantri.com.vn/'
      ];
    }

    const scraped = await scrapeMultipleUrls(urlsToCheck);
    const results = scraped.map(s => ({
      source: s.url,
      plagiarism_score: plagiarismScore(s.text, inputText)
    }));
    results.sort((a, b) => b.plagiarism_score - a.plagiarism_score);
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra: ' + err.message });
  }
});

// Check custom URLs (JSON)
app.post('/check_custom_urls', async (req, res) => {
  try {
    const { text, urls } = req.body;
    if (!text || !urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Cần cung cấp text và danh sách URL hợp lệ' });
    }
    const scraped = await scrapeMultipleUrls(urls);
    let results = scraped.map(s => ({
      source: s.url,
      plagiarism_score: plagiarismScore(s.text, text)
    }));
    results.sort((a, b) => b.plagiarism_score - a.plagiarism_score);
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`Server chạy tại http://localhost:${PORT}`));

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
app.use(express.json());             
app.use(express.urlencoded({ extended: true })); 
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

// Hàm tìm kiếm Wikipedia đơn giản hơn
async function searchWikipedia(query, language = 'vi') {
  try {
    // Tạo URL tìm kiếm với từ khóa query
    const searchUrl = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=&origin=*`;
    // Gửi yêu cầu GET đến API
    const response = await axios.get(searchUrl);
    // Lấy kết quả tìm kiếm
    const searchResults = response.data.query.search;
    // Trả về 5 kết quả tìm kiếm đầu tiên
    return searchResults.slice(0, 5).map(result => ({
      title: result.title,
      pageid: result.pageid,
      snippet: result.snippet,
      url: `https://${language}.wikipedia.org/?curid=${result.pageid}`
    }));
  } catch (error) {
    console.error('Lỗi khi tìm kiếm Wikipedia:', error.message);
    return [];
  }
}

// Home
app.get('/', (req, res) => {
  res.render('index', { title: 'Trang chủ', message: 'Kiểm tra đạo văn trực tuyến' });
});

// Endpoint tìm kiếm trên Wikipedia API
app.get('/search_wikipedia', async (req, res) => {
  try {
    const { query, language } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Vui lòng cung cấp từ khóa tìm kiếm' });
    }
    
    const results = await searchWikipedia(query, language || 'vi');
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra: ' + err.message });
  }
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

    // Sử dụng từ khóa tìm kiếm từ nội dung văn bản
    let keywords = req.body.keywords;
    
    // Nếu không có từ khóa, lấy các từ quan trọng từ nội dung
    if (!keywords) {
      // Lấy 5-10 từ đầu tiên của văn bản làm từ khóa
      keywords = inputText
        .split(/\s+/)
        .slice(0, 5)
        .filter(word => word.length > 3)
        .join(' ')
        .substring(0, 100); // Giới hạn độ dài từ khóa
    }
    
    // Tìm kiếm trên Wikipedia
    const wikipediaResults = await searchWikipedia(keywords);
    
    // Lấy nội dung của các bài viết để so sánh
    const fullResults = [];
    for (const result of wikipediaResults) {
      const contentUrl = `https://vi.wikipedia.org/w/api.php?action=parse&pageid=${result.pageid}&prop=text&format=json&origin=*`;
      try {
        const contentResponse = await axios.get(contentUrl);
        if (contentResponse.data && contentResponse.data.parse && contentResponse.data.parse.text) {
          const $ = cheerio.load(contentResponse.data.parse.text['*']);
          $('table, .mw-editsection, .reference, script, style, #toc, .hatnote, .thumb').remove();
          const text = $('body').text().replace(/\s+/g, ' ').trim();
          
          fullResults.push({
            source: result.url,
            title: result.title,
            plagiarism_score: plagiarismScore(text, inputText)
          });
        }
      } catch (error) {
        console.error(`Lỗi khi lấy nội dung trang ${result.title}:`, error.message);
      }
    }
    
    fullResults.sort((a, b) => b.plagiarism_score - a.plagiarism_score);
    res.json({ results: fullResults });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra: ' + err.message });
  }
});

// Check custom text
app.post('/check_custom_text', async (req, res) => {
  try {
    const { text, keywords } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Cần cung cấp văn bản để kiểm tra' });
    }
    
    // Sử dụng từ khóa được cung cấp hoặc trích xuất từ văn bản
    let searchKeywords = keywords;
    if (!searchKeywords) {
      // Lấy 5-10 từ đầu tiên của văn bản làm từ khóa
      searchKeywords = text
        .split(/\s+/)
        .slice(0, 5)
        .filter(word => word.length > 3)
        .join(' ')
        .substring(0, 100); // Giới hạn độ dài từ khóa
    }
    
    // Tìm kiếm trên Wikipedia
    const wikipediaResults = await searchWikipedia(searchKeywords);
    
    // Lấy nội dung của các bài viết để so sánh
    const fullResults = [];
    for (const result of wikipediaResults) {
      const contentUrl = `https://vi.wikipedia.org/w/api.php?action=parse&pageid=${result.pageid}&prop=text&format=json&origin=*`;
      try {
        const contentResponse = await axios.get(contentUrl);
        if (contentResponse.data && contentResponse.data.parse && contentResponse.data.parse.text) {
          const $ = cheerio.load(contentResponse.data.parse.text['*']);
          $('table, .mw-editsection, .reference, script, style, #toc, .hatnote, .thumb').remove();
          const articleText = $('body').text().replace(/\s+/g, ' ').trim();
          
          fullResults.push({
            source: result.url,
            title: result.title,
            plagiarism_score: plagiarismScore(articleText, text)
          });
        }
      } catch (error) {
        console.error(`Lỗi khi lấy nội dung trang ${result.title}:`, error.message);
      }
    }
    
    fullResults.sort((a, b) => b.plagiarism_score - a.plagiarism_score);
    res.json({ results: fullResults });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`Server chạy tại http://localhost:${PORT}`));
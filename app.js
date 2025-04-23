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


// Hàm tìm kiếm Wikipedia
async function searchWikipedia(query, language = 'vi') {
  try {
    const searchUrl = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=&origin=*`;
    const response = await axios.get(searchUrl);
    const searchResults = response.data.query.search;
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

// Hàm mới: Trích xuất n-gram từ văn bản
function extractNgrams(text, n = 2) {
  const words = text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // giữ lại chữ cái, số và khoảng trắng
    .split(/\s+/)
    .filter(word => word.length > 3); // lọc các từ có ý nghĩa (>3 ký tự)
  
  if (words.length < n) return words;
  
  const ngrams = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

// Hàm mới: Đếm tần suất n-gram trong văn bản
function countNgramFrequency(text, n = 2) {
  const ngrams = extractNgrams(text, n);
  const frequency = {};
  
  ngrams.forEach(ngram => {
    frequency[ngram] = (frequency[ngram] || 0) + 1;
  });
  
  return frequency;
}

// Hàm mới: Trích xuất từ khóa từ văn bản dựa trên n-gram phổ biến
function extractKeywords(text, n = 2, topK = 3) {
  const frequency = countNgramFrequency(text, n);
  
  // Sắp xếp theo tần suất và lấy top K n-gram phổ biến nhất
  const sortedNgrams = Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(entry => entry[0]);
  
  return sortedNgrams.join(' ').substring(0, 100); // Giới hạn độ dài từ khóa
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

    // Sử dụng từ khóa tìm kiếm từ nội dung văn bản
    let keywords = req.body.keywords;
    
    // Nếu không có từ khóa, trích xuất từ khóa dựa trên n-gram
    if (!keywords) {
      // Thử với bi-gram (n=2) trước
      keywords = extractKeywords(inputText, 2, 3);
      // Nếu không có kết quả, thử với từng từ riêng lẻ
      if (!keywords) {
        keywords = extractKeywords(inputText, 1, 5);
      }
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
            keywords: keywords, // Thêm từ khóa vào kết quả để người dùng biết
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
      // Trích xuất từ khóa dựa trên n-gram
      searchKeywords = extractKeywords(text, 2, 3);
      // Nếu không có kết quả, thử với từng từ riêng lẻ
      if (!searchKeywords) {
        searchKeywords = extractKeywords(text, 1, 5);
      }
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
            keywords: searchKeywords,
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
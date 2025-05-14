const express       = require('express');
const multer        = require('multer');
const path          = require('path');
const fs            = require('fs').promises;
const mammoth       = require('mammoth');
const cors          = require('cors');
const axios         = require('axios');
const cheerio       = require('cheerio');

const UPLOADS_FOLDER   = path.join(__dirname, 'Uploads');
const app = express();
const PORT = 8000;

// Middleware
app.use(cors());
app.use(express.json());             
app.use(express.urlencoded({ extended: true })); 
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


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

//học
function computeHashes(text, k = DEFAULT_NGRAM_LENGTH, base = DEFAULT_BASE, mod = DEFAULT_MOD) {
  const n = text.length;
  if (n < k) return new Map();
  const hashMap = new Map();
  let h = 0;

  for (let i = 0; i < k; i++) h = (h * base + text.charCodeAt(i)) % mod;
  const firstGram = text.substring(0, k);
  hashMap.set(h, new Set([firstGram]));
  const power = modPow(base, k - 1, mod);

  for (let i = 1; i <= n - k; i++) {
    h = (h - text.charCodeAt(i - 1) * power) % mod;
    if (h < 0) h += mod;
    h = (h * base + text.charCodeAt(i + k - 1)) % mod;
    const gram = text.substring(i, i + k);

    if (!hashMap.has(h)) {
      hashMap.set(h, new Set());
    }
    hashMap.get(h).add(gram);
  }
  return hashMap;
}
//học
function plagiarismScore(text1, text2, k = DEFAULT_NGRAM_LENGTH, base = DEFAULT_BASE, mod = DEFAULT_MOD) {
  const t1 = preprocess(text1);
  const t2 = preprocess(text2);
  const hashMap1 = computeHashes(t1, k, base, mod);
  const n2 = t2.length;
  if (n2 < k) return 0.0;
  let matchCount = 0;
  const total = n2 - k + 1;
  let h = 0;
  let gram = t2.substring(0, k);
  for (let i = 0; i < k; i++) h = (h * base + t2.charCodeAt(i)) % mod;

  if (hashMap1.has(h) && hashMap1.get(h).has(gram)) matchCount++;

  const power = modPow(base, k - 1, mod);

  for (let i = 1; i < total; i++) {
    h = (h - t2.charCodeAt(i - 1) * power) % mod;
    if (h < 0) h += mod;
    h = (h * base + t2.charCodeAt(i + k - 1)) % mod;
    gram = t2.substring(i, i + k);
    if (hashMap1.has(h) && hashMap1.get(h).has(gram)) matchCount++;
  }

  return matchCount / total;
}

async function extractTextFromDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function searchWikipedia(query, language = 'vi') {
  try {
    const searchUrl = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=&origin=*`;
    const response = await axios.get(searchUrl);
    const searchResults = response.data.query.search;
    return searchResults.slice(0, 10).map(result => ({
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

function extractNgrams(text, n = 2) {
  const words = text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(word => word.length > 3);
  
  if (words.length < n) return words;
  
  const ngrams = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

function countNgramFrequency(text, n = 2) {
  const ngrams = extractNgrams(text, n);
  const frequency = {};
  
  ngrams.forEach(ngram => {
    frequency[ngram] = (frequency[ngram] || 0) + 1;
  });
  
  return frequency;
}

function extractKeywords(text, n = 2, topK = 3) {
  const frequency = countNgramFrequency(text, n);
  
  const sortedNgrams = Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(entry => entry[0]);
  
  return sortedNgrams.join(' ').substring(0, 100);
}

app.get('/', (req, res) => {
  res.render('index', { title: 'Trang chủ', message: 'Kiểm tra đạo văn trực tuyến' });
});

app.post('/check_plagiarism', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Không có file được tải lên' });
    if (path.extname(req.file.originalname).toLowerCase() !== '.docx') {
      await fs.unlink(req.file.path);
      return res.status(400).json({ error: 'Chỉ cho phép file .docx' });
    }
    const inputText = await extractTextFromDocx(req.file.path);
    await fs.unlink(req.file.path);

    let keywords = req.body.keywords;
    
    if (!keywords) {
      keywords = extractKeywords(inputText, 2, 3);
      if (!keywords) {
        keywords = extractKeywords(inputText, 1, 5);
      }
    }
    
    const wikipediaResults = await searchWikipedia(keywords);
    
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
            keywords: keywords,
            plagiarism_score: plagiarismScore(text, inputText)
          });
        }
      } catch (error) {
        console.error(`Lỗi khi lấy nội dung trang ${result.title}:`, error.message);
      }
    }
    
    // Sort by plagiarism_score and take top 5
    fullResults.sort((a, b) => b.plagiarism_score - a.plagiarism_score);
    const topResults = fullResults.slice(0, 5);
    
    res.json({ results: topResults });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra: ' + err.message });
  }
});

app.post('/check_custom_text', async (req, res) => {
  try {
    const { text, keywords } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Cần cung cấp văn bản để kiểm tra' });
    }
    
    let searchKeywords = keywords;
    if (!searchKeywords) {
      searchKeywords = extractKeywords(text, 2, 3);
      if (!searchKeywords) {
        searchKeywords = extractKeywords(text, 1, 5);
      }
    }

    const wikipediaResults = await searchWikipedia(searchKeywords);
    
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
    
    // Sort by plagiarism_score and take top 5
    fullResults.sort((a, b) => b.plagiarism_score - a.plagiarism_score);
    const topResults = fullResults.slice(0, 5);
    
    res.json({ results: topResults });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`Server chạy tại http://localhost:${PORT}`));
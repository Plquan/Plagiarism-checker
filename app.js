const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const mammoth = require('mammoth');
const cors = require('cors');

const app = express();
const PORT = 8000;

app.use(cors());

app.set("view engine", "ejs");

app.set("views", path.join(__dirname, "views"));

app.get("/", (req, res) => {
    res.render("index", { title: "Trang chủ", message: "Chào mừng bạn đến với EJS!" });
});

// Cấu hình Multer để lưu file tạm thời
const upload = multer({ dest: 'uploads/' });

const DEFAULT_NGRAM_LENGTH = 10; 
const DEFAULT_BASE = 256;
const DEFAULT_MOD = 1000003; 


function preprocess(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function modPow(base, exp, mod) {
  let result = 1;
  for (let i = 0; i < exp; i++) {
    result = (result * base) % mod;
  }
  return result;
}

// Hàm tính các giá trị băm cho các đoạn con (n-gram) trong văn bản
function computeHashes(text, k, base = DEFAULT_BASE, mod = DEFAULT_MOD) {
  const n = text.length;
  if (n < k) return new Set();
  const hashSet = new Set();
  let h = 0;
  
  for (let i = 0; i < k; i++) {
    h = (h * base + text.charCodeAt(i)) % mod;
  }
  hashSet.add(h);
  const power = modPow(base, k - 1, mod);
  
  for (let i = 1; i <= n - k; i++) {
    h = (h - text.charCodeAt(i - 1) * power) % mod;
    if (h < 0) h += mod; 
    h = (h * base + text.charCodeAt(i + k - 1)) % mod;
    hashSet.add(h);
  }
  return hashSet;
}

// Hàm tính điểm đạo văn giữa 2 văn bản dựa trên thuật toán Rabin-Karp
function plagiarismScore(text1, text2, k = DEFAULT_NGRAM_LENGTH, base = DEFAULT_BASE, mod = DEFAULT_MOD) {
  text1 = preprocess(text1);
  text2 = preprocess(text2);
  const hashSet1 = computeHashes(text1, k, base, mod);
  const n2 = text2.length;
  if (n2 < k) return 0.0;
  let matchCount = 0;
  const total = n2 - k + 1;
  let h = 0;
  
  for (let i = 0; i < k; i++) {
    h = (h * base + text2.charCodeAt(i)) % mod;
  }
  if (hashSet1.has(h)) matchCount++;
  const power = modPow(base, k - 1, mod);
  
  for (let i = 1; i < total; i++) {
    h = (h - text2.charCodeAt(i - 1) * power) % mod;
    if (h < 0) h += mod;
    h = (h * base + text2.charCodeAt(i + k - 1)) % mod;
    if (hashSet1.has(h)) matchCount++;
  }
  return matchCount / total;
}

async function extractTextFromDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}


const DOCUMENTS_FOLDER = path.join(__dirname, 'documents');

app.get('/', (req, res) => {
  res.send('Plagiarism Checker API sử dụng Node.js');
});


app.post('/check_plagiarism', upload.single('file'), async (req, res) => {
  try {
    
    if (!req.file) {
      return res.status(400).json({ error: 'Không có file được tải lên' });
    }
    

    if (path.extname(req.file.originalname).toLowerCase() !== '.docx') {
      await fs.unlink(req.file.path);
      return res.status(400).json({ error: 'Chỉ cho phép file .docx' });
    }

    
    const inputText = await extractTextFromDocx(req.file.path);
    
    await fs.unlink(req.file.path);

    let results = [];
    
    const files = await fs.readdir(DOCUMENTS_FOLDER);
    for (const file of files) {
      if (file.endsWith('.docx')) {
        const filePath = path.join(DOCUMENTS_FOLDER, file);
        const referenceText = await extractTextFromDocx(filePath);
        const score = plagiarismScore(referenceText, inputText);
        results.push({ document: file, plagiarism_score: score });
      }
    }
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra' });
  }
});

app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const mammoth = require('mammoth');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const XLSX = require('xlsx'); // Add this for Excel file processing
const bcrypt = require('bcrypt'); // Add this for password hashing
const jwt = require('jsonwebtoken'); // Add this for JWT tokens
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create downloads directory for generated files
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/eduai', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});
mongoose.connection.on('connected', () => {
    console.log('Connected to MongoDB');
});
mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
});

// Admin Schema
const AdminSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    schoolName: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true
    }
});
const Admin = mongoose.model('Admin', AdminSchema);

// Student Schema
const StudentSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true
    },
    password: {
        type: String,
        required: true
    },
    name: {
        type: String,
        required: true
    },
    class: {
        type: String,
        required: true
    },
    grade: {
        type: String,
        required: true,
        enum: ['nursery', 'kg', '1-5', '6-8', '9-10', '11-12', 'engineering']
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});
// Compound index to allow same username across different admins
StudentSchema.index({ username: 1, adminId: 1 }, { unique: true });
const Student = mongoose.model('Student', StudentSchema);

// Enhanced Educational Content Schema with admin association
const ContentSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true
    },
    originalName: {
        type: String,
        required: true
    },
    grade: {
        type: String,
        required: true,
        enum: ['nursery', 'kg', '1-5', '6-8', '9-10', '11-12', 'engineering']
    },
    subject: {
        type: String,
        required: true
    },
    chapter: {
        type: String,
        default: ''
    },
    topic: {
        type: String,
        default: ''
    },
    fileType: {
        type: String,
        required: true
    },
    extractedText: {
        type: String,
        default: ''
    },
    processedContent: {
        concepts: [String],
        keywords: [String],
        formulas: [String],
        examples: [String]
    },
    extractedImages: [{
        filename: String,
        text: String,
        base64: String,
        description: String
    }],
    uploadDate: {
        type: Date,
        default: Date.now
    },
    fileSize: {
        type: Number,
        required: true
    },
    processed: {
        type: Boolean,
        default: false
    },
    processingError: {
        type: String,
        default: null
    },
    contentEmbedding: {
        type: [Number],
        default: []
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true
    }
});
ContentSchema.index({ grade: 1, subject: 1, chapter: 1, adminId: 1 });
ContentSchema.index({ extractedText: 'text' });
ContentSchema.index({ 'processedContent.keywords': 1 });
const Content = mongoose.model('Content', ContentSchema);

// Enhanced Chat History Schema with student association
const ChatHistorySchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true
    },
    grade: {
        type: String,
        required: true
    },
    subject: {
        type: String,
        default: 'General'
    },
    messages: [{
        sender: {
            type: String,
            enum: ['user', 'ai'],
            required: true
        },
        message: {
            type: String,
            required: true
        },
        formattedMessage: {
            type: String,
            default: ''
        },
        timestamp: {
            type: Date,
            default: Date.now
        },
        usedContent: [{
            contentId: mongoose.Schema.Types.ObjectId,
            relevanceScore: Number,
            matchedKeywords: [String]
        }],
        responseType: {
            type: String,
            enum: ['direct', 'contextual', 'general'],
            default: 'general'
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastActivity: {
        type: Date,
        default: Date.now
    }
});
const ChatHistory = mongoose.model('ChatHistory', ChatHistorySchema);

// Initialize default admin
async function initializeDefaultAdmin() {
    try {
        const existingAdmin = await Admin.findOne({ username: 'GeetanjaliSchool' });
        if (!existingAdmin) {
            const hashedPassword = await bcrypt.hash('Geetanjali123', 10);
            const defaultAdmin = new Admin({
                username: 'GeetanjaliSchool',
                password: hashedPassword,
                schoolName: 'Geetanjali School'
            });
            await defaultAdmin.save();
            console.log('Default admin created successfully');
        }
    } catch (error) {
        console.error('Error initializing default admin:', error);
    }
}

// Call initialization
initializeDefaultAdmin();

// JWT Middleware
const authenticateToken = (requiredRole = null) => {
    return (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Access token required' });
        }

        jwt.verify(token, JWT_SECRET, async (err, user) => {
            if (err) {
                return res.status(403).json({ error: 'Invalid token' });
            }

            try {
                if (user.role === 'admin') {
                    const admin = await Admin.findById(user.id);
                    if (!admin || !admin.isActive) {
                        return res.status(403).json({ error: 'Admin not found or inactive' });
                    }
                    req.user = { ...user, adminData: admin };
                } else if (user.role === 'student') {
                    const student = await Student.findById(user.id).populate('adminId');
                    if (!student || !student.isActive) {
                        return res.status(403).json({ error: 'Student not found or inactive' });
                    }
                    req.user = { ...user, studentData: student };
                } else {
                    return res.status(403).json({ error: 'Invalid user role' });
                }

                if (requiredRole) {
                    const allowedRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
                    if (!allowedRoles.includes(user.role)) {
                        return res.status(403).json({ error: 'Insufficient permissions' });
                    }
                }

                next();
            } catch (error) {
                console.error('Token verification error:', error);
                res.status(500).json({ error: 'Server error during authentication' });
            }
        });
    };
};

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg',
            'image/png',
            'image/jpg',
            'text/plain',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ];
       
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF, DOC, DOCX, TXT, JPG, PNG, XLS, XLSX files are allowed.'));
        }
    }
});

// Enhanced Gemini API Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyBcnPIGkKdkSpoJaPv3W3mw3uV7c9pH2QI';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// Authentication Routes

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const admin = await Admin.findOne({ username, isActive: true });
        if (!admin) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, admin.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: admin._id, role: 'admin', username: admin.username },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            admin: {
                id: admin._id,
                username: admin.username,
                schoolName: admin.schoolName
            }
        });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Student Login
app.post('/api/student/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const student = await Student.findOne({ username, isActive: true }).populate('adminId');
        if (!student) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, student.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { 
                id: student._id, 
                role: 'student', 
                username: student.username,
                adminId: student.adminId._id,
                grade: student.grade
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            student: {
                id: student._id,
                username: student.username,
                name: student.name,
                class: student.class,
                grade: student.grade,
                schoolName: student.adminId.schoolName
            }
        });
    } catch (error) {
        console.error('Student login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Upload Students Excel (Admin only)
app.post('/api/admin/upload-students', authenticateToken('admin'), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const adminId = req.user.id;
        
        // Check if file is Excel
        if (!req.file.mimetype.includes('sheet') && !req.file.mimetype.includes('excel')) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Please upload an Excel file (.xlsx or .xls)' });
        }

        // Read Excel file
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        const results = {
            success: 0,
            errors: []
        };

        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            try {
                // Expected columns: name, username, password, class, grade
                const { name, username, password, class: studentClass, grade } = row;

                if (!name || !username || !password || !studentClass || !grade) {
                    results.errors.push(`Row ${i + 1}: Missing required fields`);
                    continue;
                }

                // Validate grade
                const validGrades = ['nursery', 'kg', '1-5', '6-8', '9-10', '11-12', 'engineering'];
                if (!validGrades.includes(grade.toLowerCase())) {
                    results.errors.push(`Row ${i + 1}: Invalid grade "${grade}"`);
                    continue;
                }

                // Check if student already exists for this admin
                const existingStudent = await Student.findOne({ username, adminId });
                if (existingStudent) {
                    results.errors.push(`Row ${i + 1}: Student with username "${username}" already exists`);
                    continue;
                }

                // Hash password
                const hashedPassword = await bcrypt.hash(password.toString(), 10);

                // Create student
                const student = new Student({
                    name: name.toString().trim(),
                    username: username.toString().trim(),
                    password: hashedPassword,
                    class: studentClass.toString().trim(),
                    grade: grade.toLowerCase(),
                    adminId
                });

                await student.save();
                results.success++;
            } catch (error) {
                console.error(`Error processing row ${i + 1}:`, error);
                results.errors.push(`Row ${i + 1}: ${error.message}`);
            }
        }

        // Clean up uploaded file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            message: `Successfully imported ${results.success} students`,
            results
        });

    } catch (error) {
        console.error('Students upload error:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to upload students: ' + error.message });
    }
});

// Get Students List (Admin only)
app.get('/api/admin/students', authenticateToken('admin'), async (req, res) => {
    try {
        const adminId = req.user.id;
        const students = await Student.find({ adminId })
            .select('-password')
            .sort({ createdAt: -1 });

        res.json(students);
    } catch (error) {
        console.error('Get students error:', error);
        res.status(500).json({ error: 'Failed to retrieve students' });
    }
});

// All your existing text extraction functions remain the same
async function extractTextFromPDF(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        return {
            text: data.text,
            pages: data.numpages,
            info: data.info
        };
    } catch (error) {
        console.error('PDF extraction error:', error);
        throw new Error('Failed to extract text from PDF');
    }
}

async function extractTextFromImage(filePath) {
    try {
        const { data: { text, confidence } } = await Tesseract.recognize(filePath, 'eng', {
            logger: m => console.log(m)
        });
        return {
            text: text,
            confidence: confidence
        };
    } catch (error) {
        console.error('OCR extraction error:', error);
        throw new Error('Failed to extract text from image');
    }
}

async function extractTextFromDocx(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath });
        const images = await mammoth.images.inlineImages.extractImages({ path: filePath });
        return {
            text: result.value,
            images: images,
            messages: result.messages
        };
    } catch (error) {
        console.error('DOCX extraction error:', error);
        throw new Error('Failed to extract text from DOCX');
    }
}

async function extractTextFromTxt(filePath) {
    try {
        return {
            text: fs.readFileSync(filePath, 'utf8')
        };
    } catch (error) {
        console.error('TXT extraction error:', error);
        throw new Error('Failed to read text file');
    }
}

async function extractTextFromFile(filePath, mimeType) {
    switch (mimeType) {
        case 'application/pdf':
            return await extractTextFromPDF(filePath);
        case 'image/jpeg':
        case 'image/png':
        case 'image/jpg':
            return await extractTextFromImage(filePath);
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return await extractTextFromDocx(filePath);
        case 'text/plain':
            return await extractTextFromTxt(filePath);
        default:
            throw new Error('Unsupported file type');
    }
}

// All your existing content processing functions remain the same
async function processExtractedContent(text) {
    try {
        const prompt = `Analyze the following educational content and extract:
1. Key concepts (main topics covered)
2. Important keywords and terms
3. Formulas or equations (if any)
4. Examples or case studies mentioned
Content: ${text.substring(0, 5000)}...
Please format your response as JSON:
{
    "concepts": ["concept1", "concept2"],
    "keywords": ["keyword1", "keyword2"],
    "formulas": ["formula1", "formula2"],
    "examples": ["example1", "example2"]
}`;
        const response = await queryGeminiAPI(prompt, 0.3);
       
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.log('Failed to parse JSON, using default structure');
        }
       
        return {
            concepts: extractConcepts(text),
            keywords: extractKeywords(text),
            formulas: extractFormulas(text),
            examples: extractExamples(text)
        };
    } catch (error) {
        console.error('Content processing error:', error);
        return {
            concepts: [],
            keywords: [],
            formulas: [],
            examples: []
        };
    }
}

function extractConcepts(text) {
    const concepts = [];
    const lines = text.split('\n');
    lines.forEach(line => {
        if (line.match(/^[A-Z][A-Za-z\s]{5,50}:?$/) && !line.includes('.')) {
            concepts.push(line.replace(':', '').trim());
        }
    });
    return concepts.slice(0, 10);
}

function extractKeywords(text) {
    const words = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    const uniqueWords = [...new Set(words)];
    return uniqueWords.slice(0, 20);
}

function extractFormulas(text) {
    const formulas = [];
    const mathPatterns = [
        /[a-zA-Z]\s*=\s*[a-zA-Z0-9+\-*/().\s]+/g,
        /\b[A-Z]\s*=\s*[^.]+/g,
        /\b\w+\s*=\s*\d+[\w\s+\-*/()]*/g
    ];
   
    mathPatterns.forEach(pattern => {
        const matches = text.match(pattern) || [];
        formulas.push(...matches);
    });
   
    return [...new Set(formulas)].slice(0, 10);
}

function extractExamples(text) {
    const examples = [];
    const examplePatterns = [
        /Example\s*\d*:?\s*([^.]+\.)/gi,
        /For example,?\s*([^.]+\.)/gi,
        /Consider\s*([^.]+\.)/gi
    ];
   
    examplePatterns.forEach(pattern => {
        const matches = text.match(pattern) || [];
        examples.push(...matches);
    });
   
    return examples.slice(0, 5);
}

function analyzeContentRelevance(question, content) {
    const questionWords = question.toLowerCase().split(/\s+/).filter(word => word.length > 3);
    const contentText = content.extractedText.toLowerCase();
    const keywords = content.processedContent.keywords.map(k => k.toLowerCase());
    const concepts = content.processedContent.concepts.map(c => c.toLowerCase());
   
    let relevanceScore = 0;
    const matchedKeywords = [];
   
    questionWords.forEach(word => {
        if (contentText.includes(word)) {
            relevanceScore += 1;
            matchedKeywords.push(word);
        }
    });
   
    questionWords.forEach(word => {
        keywords.forEach(keyword => {
            if (keyword.includes(word) || word.includes(keyword)) {
                relevanceScore += 2;
                matchedKeywords.push(keyword);
            }
        });
    });
   
    questionWords.forEach(word => {
        concepts.forEach(concept => {
            if (concept.includes(word) || word.includes(concept)) {
                relevanceScore += 3;
                matchedKeywords.push(concept);
            }
        });
    });
   
    return {
        score: relevanceScore,
        matchedKeywords: [...new Set(matchedKeywords)]
    };
}

async function queryGeminiAPI(prompt, temperature = 0.7, maxTokens = 2048) {
    try {
        const response = await axios.post(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
            contents: [{
                parts: [{
                    text: prompt
                }]
            }],
            generationConfig: {
                temperature: temperature,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: maxTokens,
                candidateCount: 1
            },
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_HATE_SPEECH",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                }
            ]
        });
        if (response.data.candidates && response.data.candidates[0]) {
            return response.data.candidates[0].content.parts[0].text;
        } else {
            throw new Error('No response from Gemini API');
        }
    } catch (error) {
        console.error('Gemini API error:', error);
        if (error.response) {
            console.error('Response data:', error.response.data);
            throw new Error(`Gemini API error: ${error.response.status} - ${error.response.data.error?.message || 'Unknown error'}`);
        }
        throw new Error('Failed to get response from AI');
    }
}

async function generatePDF(content, filename) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const filePath = path.join(downloadsDir, filename);
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        doc.fontSize(16).text('EduAI Response', { align: 'center' });
        doc.moveDown();

        const lines = content.split('\n');
        let currentSection = '';
        lines.forEach(line => {
            if (line.startsWith('## ')) {
                currentSection = line.replace('## ', '');
                doc.fontSize(14).text(currentSection, { underline: true });
                doc.moveDown();
            } else if (line.startsWith('### ')) {
                doc.fontSize(12).text(line.replace('### ', ''), { bold: true });
            } else if (line.startsWith('- ')) {
                doc.fontSize(10).text('• ' + line.replace('- ', ''), { indent: 20 });
            } else if (line.startsWith('> ')) {
                doc.fontSize(10).font('Times-Italic').text(line.replace('> ', ''), { indent: 20 });
                doc.font('Times-Roman');
            } else if (line.match(/`[^`]+`/)) {
                const code = line.match(/`([^`]+)`/)[1];
                doc.fontSize(10).font('Courier').text(code, { indent: 20 });
                doc.font('Times-Roman');
            } else if (line.trim()) {
                doc.fontSize(10).text(line.trim());
            }
            doc.moveDown(0.5);
        });

        doc.end();
        stream.on('finish', () => resolve(filePath));
        stream.on('error', reject);
    });
}

async function generateDOCX(content, filename) {
    const doc = new Document({
        sections: [{
            properties: {},
            children: []
        }]
    });

    const lines = content.split('\n');
    let currentSection = '';
    lines.forEach(line => {
        if (line.startsWith('## ')) {
            currentSection = line.replace('## ', '');
            doc.addSection({
                children: [
                    new Paragraph({
                        children: [new TextRun({
                            text: currentSection,
                            size: 28,
                            bold: true
                        })],
                        spacing: { after: 200 }
                    })
                ]
            });
        } else if (line.startsWith('### ')) {
            doc.addSection({
                children: [
                    new Paragraph({
                        children: [new TextRun({
                            text: line.replace('### ', ''),
                            size: 24,
                            bold: true
                        })],
                        spacing: { after: 100 }
                    })
                ]
            });
        } else if (line.startsWith('- ')) {
            doc.addSection({
                children: [
                    new Paragraph({
                        children: [new TextRun({
                            text: line.replace('- ', ''),
                            size: 20
                        })],
                        bullet: { level: 0 },
                        spacing: { after: 100 }
                    })
                ]
            });
        } else if (line.startsWith('> ')) {
            doc.addSection({
                children: [
                    new Paragraph({
                        children: [new TextRun({
                            text: line.replace('> ', ''),
                            size: 20,
                            italics: true
                        })],
                        indent: { left: 200 },
                        spacing: { after: 100 }
                    })
                ]
            });
        } else if (line.match(/`[^`]+`/)) {
            const code = line.match(/`([^`]+)`/)[1];
            doc.addSection({
                children: [
                    new Paragraph({
                        children: [new TextRun({
                            text: code,
                            size: 20,
                            font: 'Courier New'
                        })],
                        indent: { left: 200 },
                        spacing: { after: 100 }
                    })
                ]
            });
        } else if (line.trim()) {
            doc.addSection({
                children: [
                    new Paragraph({
                        children: [new TextRun({
                            text: line.trim(),
                            size: 20
                        })],
                        spacing: { after: 100 }
                    })
                ]
            });
        }
    });

    const filePath = path.join(downloadsDir, filename);
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

function createEnhancedEducationalPrompt(question, grade, relevantContent, questionType = 'general') {
    const gradeLevel = getGradeDescription(grade);
   
    let contextSection = '';
    if (relevantContent.length > 0) {
        contextSection = `
RELEVANT EDUCATIONAL CONTENT FROM YOUR TEXTBOOKS:
${relevantContent.map((item, index) => `
[Source ${index + 1}: ${item.subject} - ${item.originalName}]
Key Concepts: ${item.processedContent.concepts.join(', ')}
Keywords: ${item.processedContent.keywords.join(', ')}
${item.processedContent.formulas.length > 0 ? `Formulas: ${item.processedContent.formulas.join(', ')}` : ''}
Content Extract: ${item.extractedText.substring(0, 1500)}...
`).join('\n')}`;
    }
    const basePrompt = `You are an expert AI tutor specializing in ${gradeLevel} education. You have access to the student's textbooks and educational materials.
${contextSection}
STUDENT QUESTION: "${question}"
INSTRUCTIONS FOR RESPONSE:
1. **Use strict Markdown formatting** with clear structure
2. **Always include these sections** (even if brief):
   - Understanding the Question
   - Key Concept Explanation
   - Step-by-Step Solution/Explanation
   - Examples
   - Summary
3. **Format properly**:
   - Use ## for main headings
   - Use ### for subheadings
   - Use bullet points (-) for lists
   - Use **bold** for important terms
   - Use \`code blocks\` for formulas/code
   - Use > for important notes
4. **Keep language appropriate** for ${gradeLevel} students
5. **Provide concrete examples** they can relate to
6. **Encourage further questions**
RESPONSE TEMPLATE:
## Understanding the Question
[Explain what the student is asking in simple terms]
## Key Concept Explanation
[Define the main concept(s) involved]
- **Term 1**: Definition
- **Term 2**: Definition
## ${questionType === 'formula' ? 'Formula and Calculation' : 'Step-by-Step Explanation'}
[Break down the solution/explanation]
1. **Step 1**: Explanation
2. **Step 2**: With example
3. **Step 3**: Conclusion
## Examples
- **Simple Example**: [Basic example]
- **Advanced Example**: [More complex application]
## Summary
> **Key Points**:
> - Main point 1
> - Main point 2
**Would you like me to explain any part in more detail?**`;
    return basePrompt;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Enhanced Upload Route (Admin only)
app.post('/api/upload', authenticateToken('admin'), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const { grade, subject, chapter, topic } = req.body;
        const adminId = req.user.id;
       
        if (!grade || !subject) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Grade and subject are required' });
        }
        const content = new Content({
            filename: req.file.filename,
            originalName: req.file.originalname,
            grade: grade,
            subject: subject,
            chapter: chapter || '',
            topic: topic || '',
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            processed: false,
            adminId: adminId
        });
        await content.save();
        
        processFileBackground(content._id, req.file.path, req.file.mimetype);
        res.json({
            success: true,
            message: 'File uploaded successfully and is being processed',
            contentId: content._id,
            filename: req.file.originalname
        });
    } catch (error) {
        console.error('Upload error:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'File upload failed: ' + error.message });
    }
});

async function processFileBackground(contentId, filePath, mimeType) {
    try {
        console.log(`Processing file: ${contentId}`);
       
        const extractionResult = await extractTextFromFile(filePath, mimeType);
        const extractedText = extractionResult.text || extractionResult;
       
        const processedContent = await processExtractedContent(extractedText);
       
        await Content.findByIdAndUpdate(contentId, {
            extractedText: extractedText,
            processedContent: processedContent,
            processed: true,
            processingError: null
        });
        console.log(`Successfully processed file: ${contentId}`);
    } catch (error) {
        console.error(`File processing failed for ${contentId}:`, error);
       
        await Content.findByIdAndUpdate(contentId, {
            processed: true,
            processingError: error.message
        });
    }
}

app.post('/api/chat', authenticateToken(['student', 'admin']), async (req, res) => {
    try {
        const { question, sessionId, subject, grade } = req.body;
        const userRole = req.user.role; // 'student' or 'admin'
        let selectedGrade;
        let adminId;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
        }
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID is required' });
        }

        // Determine grade and adminId based on user role
        if (userRole === 'student') {
            selectedGrade = req.user.studentData.grade;
            adminId = req.user.studentData.adminId._id;
            if (!selectedGrade) {
                return res.status(400).json({ error: 'Student grade not found' });
            }
        } else if (userRole === 'admin') {
            const validGrades = ['nursery', 'kg', '1-5', '6-8', '9-10', '11-12', 'engineering'];
            if (!grade || !validGrades.includes(grade)) {
                return res.status(400).json({ error: 'Valid grade is required for admin' });
            }
            selectedGrade = grade;
            adminId = req.user.id; // Admin uses their own ID
        } else {
            return res.status(403).json({ error: 'Invalid user role' });
        }

        console.log(`Processing question: "${question}" for grade: ${selectedGrade}, user: ${req.user.name}, role: ${userRole}`);

        // Get relevant content only from the same admin
        const allContent = await Content.find({
            grade: selectedGrade,
            processed: true,
            processingError: null,
            adminId: adminId
        }).select('subject extractedText processedContent filename originalName chapter topic');

        console.log(`Found ${allContent.length} content items for grade ${selectedGrade} and admin ${adminId}`);

        const contentWithRelevance = allContent.map(item => {
            const analysis = analyzeContentRelevance(question, item);
            return {
                ...item.toObject(),
                relevanceScore: analysis.score,
                matchedKeywords: analysis.matchedKeywords
            };
        });

        const relevantContent = contentWithRelevance
            .filter(item => item.relevanceScore > 0)
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, 3);

        console.log(`Using ${relevantContent.length} relevant content items`);

        const questionType = determineQuestionType(question);
        const prompt = createEnhancedEducationalPrompt(question, selectedGrade, relevantContent, questionType);

        console.log('Querying Gemini API...');
        const response = await queryGeminiAPI(prompt, 0.7, 2048);

        const saveResult = await saveChatHistory(sessionId, selectedGrade, question, response, relevantContent, questionType, subject, req.user.id, adminId);
        if (!saveResult.success) {
            console.warn(`Chat history save failed: ${saveResult.error}`);
        }

        res.json({
            success: true,
            response: response,
            usedContent: relevantContent.length,
            sources: relevantContent.map(item => ({
                filename: item.originalName,
                subject: item.subject,
                chapter: item.chapter,
                relevanceScore: item.relevanceScore,
                matchedKeywords: item.matchedKeywords
            })),
            responseType: questionType
        });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            error: 'Failed to process question: ' + error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

app.post('/api/download', authenticateToken('student'), async (req, res) => {
    try {
        const { sessionId, format, question } = req.body;
        const studentId = req.user.id;
        
        if (!sessionId || !format || !['pdf', 'docx'].includes(format)) {
            return res.status(400).json({ error: 'Session ID and valid format (pdf or docx) are required' });
        }

        const chatHistory = await ChatHistory.findOne({ sessionId, studentId });
        if (!chatHistory || chatHistory.messages.length === 0) {
            return res.status(404).json({ error: 'No chat history found for this session' });
        }

        let content;
        if (question) {
            const userMessageIndex = chatHistory.messages.findIndex(
                msg => msg.sender === 'user' && msg.message.toLowerCase() === question.toLowerCase()
            );
            if (userMessageIndex === -1) {
                return res.status(404).json({ error: 'Question not found in chat history' });
            }
            const aiResponse = chatHistory.messages[userMessageIndex + 1];
            if (!aiResponse || aiResponse.sender !== 'ai') {
                return res.status(404).json({ error: 'No AI response found for this question' });
            }
            content = `Question (${new Date(chatHistory.messages[userMessageIndex].timestamp).toLocaleString()}):\n${chatHistory.messages[userMessageIndex].message}\n\nAnswer (${new Date(aiResponse.timestamp).toLocaleString()}):\n${aiResponse.message}`;
        } else {
            content = chatHistory.messages.map(msg => 
                `${msg.sender === 'user' ? 'Question' : 'Answer'} (${new Date(msg.timestamp).toLocaleString()}):\n${msg.message}`
            ).join('\n\n');
        }

        const filename = `EduAI_Response_${Date.now()}.${format}`;
        let filePath;

        if (format === 'pdf') {
            filePath = await generatePDF(content, filename);
            res.setHeader('Content-Type', 'application/pdf');
        } else {
            filePath = await generateDOCX(content, filename);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        }

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.sendFile(filePath, (err) => {
            if (err) {
                console.error('File download error:', err);
                res.status(500).json({ error: 'Failed to download file' });
            }
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting file:', unlinkErr);
            });
        });
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to generate file: ' + error.message });
    }
});

function determineQuestionType(question) {
    const lowerQuestion = question.toLowerCase();
   
    if (lowerQuestion.includes('formula') || lowerQuestion.includes('equation') || lowerQuestion.includes('calculate')) {
        return 'formula';
    } else if (lowerQuestion.includes('example') || lowerQuestion.includes('show me') || lowerQuestion.includes('demonstrate')) {
        return 'example';
    } else if (lowerQuestion.includes('how') || lowerQuestion.includes('step') || lowerQuestion.includes('solve')) {
        return 'solution';
    } else if (lowerQuestion.includes('what is') || lowerQuestion.includes('define') || lowerQuestion.includes('explain')) {
        return 'definition';
    }
   
    return 'general';
}

async function saveChatHistory(sessionId, grade, userMessage, aiResponse, usedContent, responseType, subject = 'General', studentId, adminId) {
    try {
        if (!sessionId || typeof sessionId !== 'string') {
            throw new Error('Invalid sessionId');
        }
        if (!userMessage || !aiResponse) {
            throw new Error('User message and AI response are required');
        }
        if (!studentId || !adminId) {
            throw new Error('Student ID and Admin ID are required');
        }

        console.log(`Saving chat history for sessionId: ${sessionId}, student: ${studentId}`);
        
        let chatHistory = await ChatHistory.findOne({ sessionId, studentId });
        
        if (!chatHistory) {
            console.log(`Creating new chat history for sessionId: ${sessionId}, student: ${studentId}`);
            chatHistory = new ChatHistory({
                sessionId,
                studentId,
                adminId,
                grade,
                subject,
                messages: []
            });
        }
        
        const validResponseTypes = ['direct', 'contextual', 'general'];
        const validatedResponseType = validResponseTypes.includes(responseType) ? responseType : 'general';
        
        chatHistory.messages.push({
            sender: 'user',
            message: userMessage,
            timestamp: new Date()
        });
        
        chatHistory.messages.push({
            sender: 'ai',
            message: aiResponse,
            timestamp: new Date(),
            usedContent: usedContent.map(content => ({
                contentId: content._id,
                relevanceScore: content.relevanceScore,
                matchedKeywords: content.matchedKeywords
            })),
            responseType: validatedResponseType
        });
        
        chatHistory.lastActivity = new Date();
        chatHistory.subject = subject || chatHistory.subject;
        
        await chatHistory.save();
        console.log(`Chat history saved successfully for sessionId: ${sessionId}`);
        return { success: true };
    } catch (error) {
        console.error(`Failed to save chat history for sessionId: ${sessionId}:`, error);
        return { success: false, error: error.message };
    }
}

// Updated Content Route (Admin only)
app.get('/api/content', authenticateToken('admin'), async (req, res) => {
    try {
        const { grade, subject } = req.query;
        const adminId = req.user.id;
        const filter = { adminId };
       
        if (grade) filter.grade = grade;
        if (subject) filter.subject = new RegExp(subject, 'i');
       
        const content = await Content.find(filter)
            .select('-extractedText')
            .sort({ uploadDate: -1 });
       
        res.json(content);
    } catch (error) {
        console.error('Content retrieval error:', error);
        res.status(500).json({ error: 'Failed to retrieve content' });
    }
});

// Updated Content Delete Route (Admin only)
app.delete('/api/content/:id', authenticateToken('admin'), async (req, res) => {
    try {
        const adminId = req.user.id;
        const content = await Content.findOne({ _id: req.params.id, adminId });
       
        if (!content) {
            return res.status(404).json({ error: 'Content not found or unauthorized' });
        }
        const filePath = path.join(uploadsDir, content.filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        await Content.findByIdAndDelete(req.params.id);
       
        res.json({ success: true, message: 'Content deleted successfully' });
    } catch (error) {
        console.error('Content deletion error:', error);
        res.status(500).json({ error: 'Failed to delete content' });
    }
});

// Updated Chat History Route (Student only)
app.get('/api/chat-history/:sessionId', authenticateToken('student'), async (req, res) => {
    try {
        const studentId = req.user.id;
        const chatHistory = await ChatHistory.findOne({
            sessionId: req.params.sessionId,
            studentId
        }).populate('messages.usedContent.contentId', 'filename subject originalName');
       
        if (!chatHistory) {
            return res.json({ messages: [] });
        }
       
        res.json(chatHistory);
    } catch (error) {
        console.error('Chat history retrieval error:', error);
        res.status(500).json({ error: 'Failed to retrieve chat history' });
    }
});

// Updated Analytics Route (Admin only)
app.get('/api/analytics', authenticateToken('admin'), async (req, res) => {
    try {
        const adminId = req.user.id;
        const totalContent = await Content.countDocuments({ adminId });
        const processedContent = await Content.countDocuments({ adminId, processed: true, processingError: null });
        const contentByGrade = await Content.aggregate([
            { $match: { adminId: new mongoose.Types.ObjectId(adminId) } },
            { $group: { _id: '$grade', count: { $sum: 1 } } }
        ]);
        const contentBySubject = await Content.aggregate([
            { $match: { adminId: new mongoose.Types.ObjectId(adminId) } },
            { $group: { _id: '$subject', count: { $sum: 1 } } }
        ]);
        const totalChats = await ChatHistory.countDocuments({ adminId });
        const totalStudents = await Student.countDocuments({ adminId, isActive: true });
        const recentUploads = await Content.find({ adminId })
            .sort({ uploadDate: -1 })
            .limit(10)
            .select('filename originalName grade subject chapter uploadDate processed processingError');
        res.json({
            totalContent,
            processedContent,
            contentByGrade,
            contentBySubject,
            totalChats,
            totalStudents,
            recentUploads
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to retrieve analytics' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date(),
        mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
        geminiApi: GEMINI_API_KEY ? 'Configured' : 'Not Configured'
    });
});

function getGradeDescription(grade) {
    const descriptions = {
        'nursery': 'Pre-school (Nursery)',
        'kg': 'Kindergarten',
        '1-5': 'Elementary School (1st-5th Grade)',
        '6-8': 'Middle School (6th-8th Grade)',
        '9-10': 'High School (9th-10th Grade)',
        '11-12': 'Senior High School (11th-12th Grade)',
        'engineering': 'Engineering/College Level'
    };
    return descriptions[grade] || grade;
}

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
        }
    }
   
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`Enhanced EduAI Backend Server running on port ${PORT}`);
    console.log(`MongoDB connection state: ${mongoose.connection.readyState}`);
    console.log(`Gemini API configured: ${GEMINI_API_KEY ? 'Yes' : 'No'}`);
});

module.exports = app;
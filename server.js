// server.js - Express.js Backend API
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Database setup
const db = new sqlite3.Database('./connectpair.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Initialize database tables
function initializeDatabase() {
    const tables = [
        `CREATE TABLE IF NOT EXISTS consultations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            relationship_type TEXT NOT NULL,
            names TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT NOT NULL,
            anniversary DATE,
            preferences TEXT,
            budget TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        
        `CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            phone TEXT,
            relationship_type TEXT,
            anniversary DATE,
            partner_email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        
        `CREATE TABLE IF NOT EXISTS phone_numbers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT UNIQUE NOT NULL,
            pattern_type TEXT,
            customer_id INTEGER,
            partner_number_id INTEGER,
            status TEXT DEFAULT 'available',
            purchase_price DECIMAL(10,2),
            monthly_fee DECIMAL(10,2),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers (id)
        )`,
        
        `CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            package_type TEXT NOT NULL,
            total_amount DECIMAL(10,2) NOT NULL,
            status TEXT DEFAULT 'pending',
            payment_intent_id TEXT,
            numbers TEXT, -- JSON array of number IDs
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers (id)
        )`,
        
        `CREATE TABLE IF NOT EXISTS email_subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            source TEXT, -- 'consultation', 'newsletter', 'download'
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
    ];
    
    tables.forEach(tableSQL => {
        db.run(tableSQL, (err) => {
            if (err) {
                console.error('Error creating table:', err.message);
            }
        });
    });
}

// Email configuration - FIXED: Changed createTransporter to createTransport
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Validation middleware
const consultationValidation = [
    body('relationshipType').notEmpty().withMessage('Relationship type is required'),
    body('names').notEmpty().withMessage('Names are required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone').notEmpty().withMessage('Phone number is required'),
    body('budget').notEmpty().withMessage('Budget selection is required')
];

// Routes

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Submit consultation form
app.post('/api/consultation', consultationValidation, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const {
            relationshipType,
            names,
            email,
            phone,
            anniversary,
            preferences,
            budget
        } = req.body;

        // Insert into database
        const query = `
            INSERT INTO consultations 
            (relationship_type, names, email, phone, anniversary, preferences, budget)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        db.run(query, [
            relationshipType,
            names,
            email,
            phone,
            anniversary || null,
            preferences || '',
            budget
        ], function(err) {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Database error' 
                });
            }

            const consultationId = this.lastID;
            
            // Send confirmation email to customer
            sendConsultationConfirmation(email, names, consultationId);
            
            // Send notification to admin
            sendAdminNotification({
                consultationId,
                relationshipType,
                names,
                email,
                phone,
                budget,
                preferences
            });

            res.json({ 
                success: true, 
                message: 'Consultation request submitted successfully',
                consultationId 
            });
        });

    } catch (error) {
        console.error('Consultation submission error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
});

// Get available numbers (for future number search functionality)
app.get('/api/numbers/search', async (req, res) => {
    try {
        const { pattern, area_code, limit = 10 } = req.query;
        
        let query = `
            SELECT * FROM phone_numbers 
            WHERE status = 'available'
        `;
        const params = [];

        if (pattern) {
            query += ` AND pattern_type = ?`;
            params.push(pattern);
        }

        if (area_code) {
            query += ` AND number LIKE ?`;
            params.push(`${area_code}%`);
        }

        query += ` LIMIT ?`;
        params.push(parseInt(limit));

        db.all(query, params, (err, rows) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Database error' 
                });
            }

            res.json({ 
                success: true, 
                numbers: rows 
            });
        });

    } catch (error) {
        console.error('Number search error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
});

// Newsletter subscription
app.post('/api/newsletter', [
    body('email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { email, source = 'newsletter' } = req.body;

        const query = `
            INSERT OR IGNORE INTO email_subscribers (email, source)
            VALUES (?, ?)
        `;

        db.run(query, [email, source], function(err) {
            if (err) {
                console.error('Newsletter subscription error:', err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Database error' 
                });
            }

            // Send welcome email
            sendWelcomeEmail(email);

            res.json({ 
                success: true, 
                message: 'Successfully subscribed to newsletter' 
            });
        });

    } catch (error) {
        console.error('Newsletter subscription error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
});

// Admin route to get consultations (requires authentication in production)
app.get('/api/admin/consultations', async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;
        
        let query = `
            SELECT * FROM consultations
        `;
        const params = [];

        if (status) {
            query += ` WHERE status = ?`;
            params.push(status);
        }

        query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        db.all(query, params, (err, rows) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Database error' 
                });
            }

            res.json({ 
                success: true, 
                consultations: rows 
            });
        });

    } catch (error) {
        console.error('Admin consultations error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
});

// Email functions
async function sendConsultationConfirmation(email, names, consultationId) {
    try {
        const mailOptions = {
            from: process.env.SMTP_FROM || 'hello@connectpair.co.uk',
            to: email,
            subject: `💕 We're Finding Your Perfect Numbers! - ConnectPair`,
            html: `
                <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif;">
                    <div style="background: linear-gradient(135deg, #ff6b6b, #ffa8a8); padding: 40px 20px; text-align: center; color: white;">
                        <h1 style="margin: 0; font-size: 28px;">💕 Thank You ${names}!</h1>
                        <p style="margin: 10px 0 0; font-size: 18px;">We're already searching for your perfect numbers</p>
                    </div>
                    
                    <div style="padding: 30px 20px; background: white;">
                        <h2 style="color: #2d3748; margin-bottom: 20px;">What happens next?</h2>
                        
                        <div style="background: #f8fafc; padding: 20px; border-radius: 10px; margin-bottom: 25px;">
                            <div style="margin-bottom: 15px;">
                                <strong>✨ Step 1:</strong> Our number specialists are searching through millions of available numbers right now!
                            </div>
                            <div style="margin-bottom: 15px;">
                                <strong>📧 Step 2:</strong> Within 24 hours, you'll receive an email with 3-5 perfect number options
                            </div>
                            <div style="margin-bottom: 15px;">
                                <strong>💕 Step 3:</strong> Choose your favorites and we'll handle all the setup
                            </div>
                            <div>
                                <strong>🚀 Step 4:</strong> Start using your amazing new matching numbers!
                            </div>
                        </div>
                        
                        <p style="color: #718096; margin-bottom: 25px;">
                            Your consultation ID is: <strong>#${consultationId}</strong><br>
                            Keep this for your records!
                        </p>
                        
                        <div style="text-align: center;">
                            <a href="${process.env.FRONTEND_URL}" style="background: #ff6b6b; color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; font-weight: bold;">Visit ConnectPair</a>
                        </div>
                    </div>
                    
                    <div style="padding: 20px; text-align: center; color: #718096; font-size: 14px;">
                        Questions? Reply to this email or visit our help center.<br>
                        Made with 💕 by the ConnectPair team
                    </div>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('Confirmation email sent to:', email);
    } catch (error) {
        console.error('Error sending confirmation email:', error);
    }
}

async function sendAdminNotification(consultationData) {
    try {
        const {
            consultationId,
            relationshipType,
            names,
            email,
            phone,
            budget,
            preferences
        } = consultationData;

        const mailOptions = {
            from: process.env.SMTP_FROM || 'hello@connectpair.co.uk',
            to: process.env.ADMIN_EMAIL || 'admin@connectpair.co.uk',
            subject: `🚨 New Consultation Request #${consultationId} - ${names}`,
            html: `
                <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif;">
                    <h1 style="color: #ff6b6b;">New Consultation Request</h1>
                    
                    <div style="background: #f8fafc; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
                        <h3>Customer Information</h3>
                        <p><strong>ID:</strong> #${consultationId}</p>
                        <p><strong>Names:</strong> ${names}</p>
                        <p><strong>Email:</strong> ${email}</p>
                        <p><strong>Phone:</strong> ${phone}</p>
                        <p><strong>Relationship:</strong> ${relationshipType}</p>
                        <p><strong>Budget:</strong> ${budget}</p>
                    </div>
                    
                    ${preferences ? `
                    <div style="background: #fff; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                        <h3>Preferences</h3>
                        <p>${preferences}</p>
                    </div>
                    ` : ''}
                    
                    <div style="margin-top: 20px; text-align: center;">
                        <a href="${process.env.ADMIN_URL}/consultations/${consultationId}" style="background: #ff6b6b; color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px;">View in Admin Panel</a>
                    </div>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('Admin notification sent for consultation:', consultationId);
    } catch (error) {
        console.error('Error sending admin notification:', error);
    }
}

async function sendWelcomeEmail(email) {
    try {
        const mailOptions = {
            from: process.env.SMTP_FROM || 'hello@connectpair.co.uk',
            to: email,
            subject: '💕 Welcome to the ConnectPair Family!',
            html: `
                <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif;">
                    <div style="background: linear-gradient(135deg, #ff6b6b, #ffa8a8); padding: 40px 20px; text-align: center; color: white;">
                        <h1 style="margin: 0; font-size: 28px;">💕 Welcome to ConnectPair!</h1>
                        <p style="margin: 10px 0 0; font-size: 16px;">Thank you for joining our community of connected couples</p>
                    </div>
                    
                    <div style="padding: 30px 20px; background: white;">
                        <h2 style="color: #2d3748; margin-bottom: 20px;">What to expect:</h2>
                        
                        <ul style="color: #4a5568; line-height: 1.6;">
                            <li>💌 Weekly relationship tips and communication advice</li>
                            <li>🎁 Exclusive offers on personalized number packages</li>
                            <li>📱 New features and service updates</li>
                            <li>💕 Success stories from other couples</li>
                        </ul>
                        
                        <div style="margin: 30px 0; padding: 20px; background: #f8fafc; border-radius: 10px; text-align: center;">
                            <h3 style="color: #ff6b6b; margin-bottom: 15px;">Ready to find your perfect numbers?</h3>
                            <a href="${process.env.FRONTEND_URL}/#packages" style="background: #ff6b6b; color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; font-weight: bold;">Explore Packages</a>
                        </div>
                    </div>
                    
                    <div style="padding: 20px; text-align: center; color: #718096; font-size: 14px;">
                        Made with 💕 by the ConnectPair team<br>
                        <a href="${process.env.FRONTEND_URL}/unsubscribe" style="color: #718096;">Unsubscribe</a>
                    </div>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('Welcome email sent to:', email);
    } catch (error) {
        console.error('Error sending welcome email:', error);
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        success: false, 
        message: 'Something went wrong!' 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        message: 'Route not found' 
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed.');
        process.exit(0);
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
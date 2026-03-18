const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase limit to 10MB
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// MongoDB connection
const uri = "mongodb+srv://hiraiginjialt4_db_user:l2CDwnX4pQdcEvI7@cluster0.sjtehir.mongodb.net/attendance_system?retryWrites=true&w=majority";
const client = new MongoClient(uri);

let db;
let isConnected = false;

// Connect to MongoDB
async function connectDB() {
    try {
        await client.connect();
        db = client.db("attendance_system");
        isConnected = true;
        console.log("✅ Connected to MongoDB Atlas");
        console.log("📁 Database: attendance_system");
        
        // List collections
        const collections = await db.listCollections().toArray();
        console.log("📚 Collections:", collections.map(c => c.name).join(', '));
        
    } catch (error) {
        console.error("❌ MongoDB connection error:", error);
        isConnected = false;
    }
}

connectDB();

// ========== EMPLOYEE ENDPOINTS ==========

// Get all employees with face data
app.get('/api/employees', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const employees = await db.collection('employee_faces')
            .find({ has_face_data: true })
            .toArray();
        
        console.log(`📊 Found ${employees.length} employees with face data`);
        
        res.json({
            success: true,
            employees: employees,
            count: employees.length
        });
    } catch (error) {
        console.error("❌ Error fetching employees:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Get specific employee
app.get('/api/employees/:id', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const employee = await db.collection('employee_faces')
            .findOne({ employee_id: req.params.id });
        
        if (employee) {
            res.json({ 
                success: true, 
                employee 
            });
        } else {
            res.status(404).json({ 
                success: false, 
                message: "Employee not found" 
            });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Get all employees (simplified list for dropdown)
app.get('/api/employees/list', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        // Only return id, employee_id, and name for dropdown
        const employees = await db.collection('employee_faces')
            .find({ status: "active" })
            .project({ 
                _id: 1, 
                employee_id: 1, 
                name: 1,
                department: 1,
                role: 1
            })
            .toArray();
        
        console.log(`📋 Found ${employees.length} employees for dropdown`);
        
        res.json({
            success: true,
            employees: employees,
            count: employees.length
        });
    } catch (error) {
        console.error("❌ Error fetching employee list:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// ========== ATTENDANCE ENDPOINTS ==========

// Clock in
app.post('/api/attendance/clock-in', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { employee_id, name, clock_in_time, date } = req.body;
        
        console.log(`⏰ Clock-in: ${name} (${employee_id}) at ${clock_in_time} on ${date}`);
        
        // Check if already clocked in today
        const existing = await db.collection('attendance_records').findOne({
            employee_id: employee_id,
            date: date
        });
        
        if (existing) {
            console.log(`⚠️ Already clocked in today: ${name}`);
            return res.json({ 
                success: false, 
                message: "Already clocked in today" 
            });
        }
        
        // Create attendance record
        const record = {
            employee_id,
            name,
            clock_in_time,
            date,
            timestamp: new Date(),
            sync_status: "synced"
        };
        
        const result = await db.collection('attendance_records').insertOne(record);
        
        console.log(`✅ Clock-in recorded: ${name}`);
        
        res.json({
            success: true,
            message: "Clocked in successfully",
            record_id: result.insertedId
        });
    } catch (error) {
        console.error("❌ Clock-in error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Clock out
app.post('/api/attendance/clock-out', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { employee_id, clock_out_time, date } = req.body;
        
        console.log(`⏰ Clock-out: ${employee_id} at ${clock_out_time}`);
        
        const result = await db.collection('attendance_records').updateOne(
            { employee_id: employee_id, date: date },
            { $set: { clock_out_time: clock_out_time } }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`✅ Clock-out recorded`);
            res.json({ 
                success: true, 
                message: "Clocked out successfully" 
            });
        } else {
            console.log(`⚠️ No clock-in record found`);
            res.json({ 
                success: false, 
                message: "No clock-in record found" 
            });
        }
    } catch (error) {
        console.error("❌ Clock-out error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Get today's attendance
app.get('/api/attendance/today', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        
        const records = await db.collection('attendance_records')
            .find({ date: today })
            .toArray();
        
        res.json({
            success: true,
            records: records,
            count: records.length
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});


// ========== EMPLOYEE REGISTRATION ENDPOINT ==========
// Add this to your server code

// Register new employee with face data
app.post('/api/employees/register', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { employee_id, name, face_image_base64, department, role, birthday, contact_number, email } = req.body;
        
        console.log(`👤 Registering employee: ${name} (${employee_id})`);
        
        // Check if employee already exists
        const existing = await db.collection('employee_faces').findOne({
            employee_id: employee_id
        });
        
        if (existing) {
            console.log(`⚠️ Employee already exists: ${name}`);
            return res.json({ 
                success: false, 
                message: "Employee ID already exists" 
            });
        }
        
        // Generate a unique employee_id if not provided
        const finalEmployeeId = employee_id || `EMP${Date.now()}`;
        
        // Create employee record
        const employee = {
            employee_id: finalEmployeeId,
            name: name,
            face_image_base64: face_image_base64,
            department: department || "General",
            role: role || "Employee",
            birthday: birthday || null,
            contact_number: contact_number || null,
            email: email || null,
            status: "active",
            has_face_data: true,
            source: "android_app",
            created_at: new Date(),
            updated_at: new Date()
        };
        
        const result = await db.collection('employee_faces').insertOne(employee);
        
        console.log(`✅ Employee registered: ${name} with ID: ${finalEmployeeId}`);
        
        res.json({
            success: true,
            message: "Employee registered successfully",
            employee_id: finalEmployeeId,
            mongo_id: result.insertedId
        });
    } catch (error) {
        console.error("❌ Employee registration error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Update employee face data
app.put('/api/employees/:employeeId/face', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { employeeId } = req.params;
        const { face_image_base64 } = req.body;
        
        console.log(`🔄 Updating face data for employee: ${employeeId}`);
        
        // Find employee by employee_id (not _id)
        const existing = await db.collection('employee_faces').findOne({
            employee_id: employeeId
        });
        
        if (!existing) {
            console.log(`❌ Employee not found: ${employeeId}`);
            return res.status(404).json({ 
                success: false, 
                message: "Employee not found" 
            });
        }
        
        // Update ONLY the face_image_base64 field
        const result = await db.collection('employee_faces').updateOne(
            { employee_id: employeeId },
            { 
                $set: { 
                    face_image_base64: face_image_base64,
                    has_face_data: true,
                    updated_at: new Date()
                }
                // DO NOT change employee_id, name, department, role, etc.
            }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`✅ Face data updated for employee: ${existing.name} (${employeeId})`);
            res.json({ 
                success: true, 
                message: "Face data updated successfully",
                employee: {
                    employee_id: existing.employee_id,
                    name: existing.name,
                    department: existing.department,
                    role: existing.role
                }
            });
        } else {
            res.json({ 
                success: false, 
                message: "No changes made" 
            });
        }
    } catch (error) {
        console.error("❌ Face update error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// ========== SYNC ENDPOINT ==========

// Sync pending attendance (for offline mode)
app.post('/api/sync/attendance', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { pending_records } = req.body;
        console.log(`🔄 Syncing ${pending_records.length} pending records`);
        
        const results = [];
        
        for (const record of pending_records) {
            if (!record.clock_out_time) {
                // Clock-in record
                const existing = await db.collection('attendance_records').findOne({
                    employee_id: record.employee_id,
                    date: record.date
                });
                
                if (!existing) {
                    const result = await db.collection('attendance_records').insertOne({
                        employee_id: record.employee_id,
                        name: record.name,
                        clock_in_time: record.clock_in_time,
                        date: record.date,
                        timestamp: new Date(),
                        sync_status: "synced"
                    });
                    results.push({ 
                        id: record.local_id, 
                        success: true, 
                        mongo_id: result.insertedId 
                    });
                }
            } else {
                // Clock-out record
                const result = await db.collection('attendance_records').updateOne(
                    { employee_id: record.employee_id, date: record.date },
                    { $set: { clock_out_time: record.clock_out_time } }
                );
                results.push({ 
                    id: record.local_id, 
                    success: result.modifiedCount > 0 
                });
            }
        }
        
        console.log(`✅ Sync complete: ${results.filter(r => r.success).length} successful`);
        
        res.json({ 
            success: true, 
            results 
        });
    } catch (error) {
        console.error("❌ Sync error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        mongodb: isConnected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Face Recognition Attendance API',
        version: '1.0.0',
        endpoints: [
            'GET /health',
            'GET /api/employees',
            'GET /api/employees/:id',
            'POST /api/attendance/clock-in',
            'POST /api/attendance/clock-out',
            'GET /api/attendance/today',
            'POST /api/sync/attendance'
        ],
        mongodb_status: isConnected ? '✅ Connected' : '❌ Disconnected'
    });
});

// Start server
app.listen(port, () => {
    console.log(`\n🚀 Server is running!`);
    console.log(`📡 Port: ${port}`);
    console.log(`🌍 URL: http://localhost:${port}`);
    console.log(`\n📋 Endpoints:`);
    console.log(`   GET  /health`);
    console.log(`   GET  /api/employees`);
    console.log(`   GET  /api/employees/:id`);
    console.log(`   POST /api/attendance/clock-in`);
    console.log(`   POST /api/attendance/clock-out`);
    console.log(`   GET  /api/attendance/today`);
    console.log(`   POST /api/sync/attendance`);
    console.log(`\n⏰ Press Ctrl+C to stop\n`);
});

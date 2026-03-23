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

// ========== HELPER FUNCTIONS FOR LATE DETECTION ==========

// Parse time string to minutes since midnight
function timeToMinutes(timeStr) {
    const parts = timeStr.split(':');
    const hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1]);
    const seconds = parts[2] ? parseInt(parts[2]) : 0;
    return (hours * 60) + minutes + (seconds / 60);
}

// Get attendance settings from database
async function getAttendanceSettings() {
    try {
        if (!isConnected) {
            return {
                grace_period_minutes: 15,
                late_threshold: "08:16",
                standard_work_hours: 8
            };
        }
        
        // Check if settings collection exists
        const collections = await db.listCollections({ name: 'attendance_settings' }).toArray();
        
        if (collections.length === 0) {
            const defaultSettings = {
                grace_period_minutes: 15,
                late_threshold: "08:16",
                standard_work_hours: 8,
                overtime_rate: 1.25,
                sunday_rate: 1.30,
                holiday_rate: 2.00
            };
            await db.collection('attendance_settings').insertOne(defaultSettings);
            return defaultSettings;
        }
        
        const settings = await db.collection('attendance_settings').findOne({});
        if (settings) {
            return settings;
        }
        return {
            grace_period_minutes: 15,
            late_threshold: "08:16",
            standard_work_hours: 8
        };
    } catch (error) {
        console.error("Error getting attendance settings:", error);
        return {
            grace_period_minutes: 15,
            late_threshold: "08:16",
            standard_work_hours: 8
        };
    }
}

// Get employee department
async function getEmployeeDepartment(employeeName) {
    try {
        if (!isConnected) return "Unknown";
        
        const employee = await db.collection('employee_faces').findOne({ 
            $or: [
                { name: employeeName },
                { employee_name: employeeName }
            ]
        });
        
        return employee?.department || "Unknown";
    } catch (error) {
        return "Unknown";
    }
}

// Create late violation (FIXED - use correct ems_violations database)
async function createLateViolation(employeeName, clockInTime, attendanceDate, shiftType, gracePeriodMinutes, lateMinutes) {
    try {
        if (!isConnected) {
            console.log("⚠️ MongoDB not connected, cannot create violation");
            return null;
        }
        
        // Get employee department
        const department = await getEmployeeDepartment(employeeName);
        
        // Calculate late minutes rounded up
        const lateMinutesRounded = Math.ceil(lateMinutes);
        
        // Create description
        let description = "";
        if (shiftType === "Morning") {
            description = `Morning shift late: Clocked in at ${clockInTime} (${lateMinutesRounded} minute${lateMinutesRounded !== 1 ? 's' : ''} after ${gracePeriodMinutes}-minute grace period)`;
        } else {
            description = `Night shift late: Clocked in at ${clockInTime} (${lateMinutesRounded} minute${lateMinutesRounded !== 1 ? 's' : ''} after ${gracePeriodMinutes}-minute grace period)`;
        }
        
        // IMPORTANT: Use ems_violations database, NOT attendance_system
        const violationsDb = client.db("ems_violations");
        
        // Get the collection (MongoDB will create it automatically on first insert)
        const violationsCollection = violationsDb.collection("employee_violations");
        
        // Check if violation already exists
        const existingViolation = await violationsCollection.findOne({
            employeeName: employeeName,
            date: attendanceDate,
            violationType: "Tardiness"
        });
        
        if (existingViolation) {
            console.log(`⚠️ Tardiness violation already exists for ${employeeName} on ${attendanceDate}`);
            return null;
        }
        
        // Create violation document
        const violation = {
            employeeName: employeeName,
            department: department,
            violationType: "Tardiness",
            description: description,
            status: "Pending",
            severity: "Low",
            date: attendanceDate,
            clockInTime: clockInTime,
            shiftType: shiftType.toLowerCase(),
            lateMinutes: lateMinutesRounded,
            gracePeriodMinutes: gracePeriodMinutes,
            createdAt: new Date(),
            source: "auto_late_detection"
        };
        
        const result = await violationsCollection.insertOne(violation);
        
        console.log(`✅ Created ${shiftType} shift tardiness violation for ${employeeName} (${lateMinutesRounded} min late)`);
        console.log(`   Database: ems_violations`);
        console.log(`   Collection: employee_violations`);
        console.log(`   ID: ${result.insertedId}`);
        
        return result.insertedId;
        
    } catch (error) {
        console.error("❌ Error creating late violation:", error);
        return null;
    }
}

app.get('/api/test', (req, res) => {
    res.json({ 
        success: true, 
        message: "Server is working!",
        timestamp: new Date().toISOString()
    });
});

// ========== EMPLOYEE ENDPOINTS ==========

app.get('/api/employees/list', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        // REMOVE the status filter - get ALL employees
        const employees = await db.collection('employee_faces')
            .find({})  // ← Changed from { status: "active" } to {}
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


// ========== ATTENDANCE ENDPOINTS ==========

// Clock in (UPDATED with late detection)
app.post('/api/attendance/clock-in', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { name, clock_in_time, date } = req.body;
        
        console.log(`⏰ Clock-in: ${name} at ${clock_in_time} on ${date}`);
        
        // Check if already clocked in today
        const existing = await db.collection('attendance_records').findOne({
            name: name,
            date: date
        });
        
        if (existing) {
            console.log(`⚠️ Already clocked in today: ${name}`);
            return res.json({ 
                success: false, 
                message: "Already clocked in today" 
            });
        }
        
        // ===== LATE DETECTION =====
        const settings = await getAttendanceSettings();
        const gracePeriodMinutes = settings.grace_period_minutes || 15;
        const lateThresholdTime = settings.late_threshold || "08:16";
        
        const clockInMinutes = timeToMinutes(clock_in_time);
        const lateThresholdMinutes = timeToMinutes(lateThresholdTime);
        
        let isLate = false;
        let shiftType = "Morning";
        let lateMinutes = 0;
        let violationId = null;
        
        // Determine shift type
        const isNightShift = clockInMinutes >= (22 * 60) || clockInMinutes <= (6 * 60);
        shiftType = isNightShift ? "Night" : "Morning";
        
        if (!isNightShift) {
            // Morning shift late detection
            if (clockInMinutes > lateThresholdMinutes) {
                isLate = true;
                lateMinutes = clockInMinutes - lateThresholdMinutes;
                console.log(`⚠️ MORNING LATE: ${name} at ${clock_in_time} (${Math.ceil(lateMinutes)} min late)`);
            } else {
                console.log(`✅ On time: ${name} at ${clock_in_time}`);
            }
        } else {
            // Night shift late detection (1:00 AM - 5:00 AM)
            const nightStart = timeToMinutes("01:00");
            const nightEnd = timeToMinutes("05:00");
            
            if (clockInMinutes >= nightStart && clockInMinutes <= nightEnd) {
                isLate = true;
                lateMinutes = clockInMinutes - nightStart;
                console.log(`⚠️ NIGHT LATE: ${name} at ${clock_in_time} (${Math.ceil(lateMinutes)} min late)`);
            } else {
                console.log(`✅ Night shift on time: ${name} at ${clock_in_time}`);
            }
        }
        
        // Create attendance record with late status
        const record = {
            name: name,
            clock_in_time: clock_in_time,
            date: date,
            timestamp: new Date(),
            sync_status: "synced",
            late_status: isLate ? "late" : "on_time",
            late_minutes: isLate ? Math.ceil(lateMinutes) : 0
        };
        
        const result = await db.collection('attendance_records').insertOne(record);
        
        console.log(`✅ Clock-in recorded: ${name}`);
        
        // Create violation if late
        if (isLate) {
            violationId = await createLateViolation(
                name,
                clock_in_time,
                date,
                shiftType,
                gracePeriodMinutes,
                lateMinutes
            );
        }
        
        // Build response
        const response = {
            success: true,
            message: "Clocked in successfully",
            record_id: result.insertedId
        };
        
        if (isLate) {
            response.late_detection = {
                is_late: true,
                late_minutes: Math.ceil(lateMinutes),
                shift_type: shiftType,
                violation_created: violationId !== null
            };
            if (violationId) {
                response.late_detection.violation_id = violationId;
            }
        }
        
        res.json(response);
        
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
        
        const { name, clock_out_time, date } = req.body;
        
        console.log(`⏰ Clock-out: ${name} at ${clock_out_time}`);
        
        const result = await db.collection('attendance_records').updateOne(
            { name: name, date: date },
            { $set: { clock_out_time: clock_out_time } }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`✅ Clock-out recorded for ${name}`);
            res.json({ 
                success: true, 
                message: "Clocked out successfully" 
            });
        } else {
            console.log(`⚠️ No clock-in record found for ${name}`);
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
        
        const result = await db.collection('employee_faces').updateOne(
            { employee_id: employeeId },
            { 
                $set: { 
                    face_image_base64: face_image_base64,
                    has_face_data: true,
                    updated_at: new Date()
                }
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

// ========== VIOLATIONS ENDPOINTS (NEW) ==========

// Get all violations
app.get('/api/violations', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { employee_name, start_date, end_date, status } = req.query;
        
        const query = {};
        if (employee_name) query.employeeName = employee_name;
        if (status) query.status = status;
        if (start_date && end_date) {
            query.date = { $gte: start_date, $lte: end_date };
        }
        
        const violations = await db.collection('employee_violations')
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json({
            success: true,
            data: violations,
            count: violations.length
        });
        
    } catch (error) {
        console.error("❌ Error getting violations:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Get violations for specific employee
app.get('/api/violations/employee/:employeeName', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { employeeName } = req.params;
        const { limit } = req.query;
        
        let cursor = db.collection('employee_violations')
            .find({ employeeName: employeeName })
            .sort({ createdAt: -1 });
        
        if (limit) {
            cursor = cursor.limit(parseInt(limit));
        }
        
        const violations = await cursor.toArray();
        
        res.json({
            success: true,
            violations: violations,
            count: violations.length
        });
        
    } catch (error) {
        console.error("❌ Error getting employee violations:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Check existing attendance for missing violations (batch processing)
app.post('/api/attendance/check-late-violations', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        console.log(`\n🔍 Scanning for missing late violations`);
        
        const { date_filter, employee_name } = req.body;
        
        const query = {};
        if (date_filter) query.date = date_filter;
        if (employee_name) query.name = employee_name;
        
        const attendanceRecords = await db.collection('attendance_records').find(query).toArray();
        console.log(`📊 Found ${attendanceRecords.length} attendance records to check`);
        
        const settings = await getAttendanceSettings();
        const gracePeriodMinutes = settings.grace_period_minutes || 15;
        const lateThresholdTime = settings.late_threshold || "08:16";
        const lateThresholdMinutes = timeToMinutes(lateThresholdTime);
        
        let processed = 0;
        let lateDetected = 0;
        let violationsCreated = 0;
        let errors = [];
        
        for (const record of attendanceRecords) {
            processed++;
            
            try {
                const employeeName = record.name;
                const clockInTime = record.clock_in_time;
                const attendanceDate = record.date;
                
                if (!employeeName || !clockInTime) continue;
                
                const clockInMinutes = timeToMinutes(clockInTime);
                let isLate = false;
                let lateMinutes = 0;
                let shiftType = "Morning";
                
                const isNightShift = clockInMinutes >= (22 * 60) || clockInMinutes <= (6 * 60);
                shiftType = isNightShift ? "Night" : "Morning";
                
                if (!isNightShift) {
                    if (clockInMinutes > lateThresholdMinutes) {
                        isLate = true;
                        lateMinutes = clockInMinutes - lateThresholdMinutes;
                    }
                } else {
                    const nightStart = timeToMinutes("01:00");
                    const nightEnd = timeToMinutes("05:00");
                    if (clockInMinutes >= nightStart && clockInMinutes <= nightEnd) {
                        isLate = true;
                        lateMinutes = clockInMinutes - nightStart;
                    }
                }
                
                if (isLate) {
                    lateDetected++;
                    
                    const existingViolation = await db.collection('employee_violations').findOne({
                        employeeName: employeeName,
                        date: attendanceDate,
                        violationType: "Tardiness"
                    });
                    
                    if (!existingViolation) {
                        const violationId = await createLateViolation(
                            employeeName,
                            clockInTime,
                            attendanceDate,
                            shiftType,
                            gracePeriodMinutes,
                            lateMinutes
                        );
                        
                        if (violationId) {
                            violationsCreated++;
                        }
                    }
                    
                    // Update attendance record with late status
                    await db.collection('attendance_records').updateOne(
                        { _id: record._id },
                        { 
                            $set: { 
                                late_status: "late",
                                late_minutes: Math.ceil(lateMinutes)
                            }
                        }
                    );
                } else {
                    // Update as on time if not already marked
                    if (!record.late_status) {
                        await db.collection('attendance_records').updateOne(
                            { _id: record._id },
                            { $set: { late_status: "on_time" } }
                        );
                    }
                }
                
                if (processed % 10 === 0) {
                    console.log(`📊 Progress: ${processed}/${attendanceRecords.length}`);
                }
                
            } catch (recordError) {
                errors.push(`Error: ${recordError.message}`);
                console.error(`❌ Error: ${recordError.message}`);
            }
        }
        
        console.log(`\n✅ Batch check complete: ${violationsCreated} violations created`);
        
        res.json({
            success: true,
            message: `Processed ${processed} attendance records`,
            stats: {
                total_checked: processed,
                late_detected: lateDetected,
                violations_created: violationsCreated,
                errors: errors.length
            },
            errors: errors.slice(0, 10)
        });
        
    } catch (error) {
        console.error("❌ Error checking late violations:", error);
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
                    name: record.name,
                    date: record.date
                });
                
                if (!existing) {
                    const result = await db.collection('attendance_records').insertOne({
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
                    { name: record.name, date: record.date },
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
            'POST /api/sync/attendance',
            'GET /api/violations',
            'GET /api/violations/employee/:employeeName',
            'POST /api/attendance/check-late-violations'
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
    console.log(`   GET  /api/violations`);
    console.log(`   GET  /api/violations/employee/:employeeName`);
    console.log(`   POST /api/attendance/check-late-violations`);
    console.log(`\n⏰ Press Ctrl+C to stop\n`);
});

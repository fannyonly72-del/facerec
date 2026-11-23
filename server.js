const express = require('express');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase limit to 10MB
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// MongoDB connection
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI environment variable is required');
const client = new MongoClient(uri);

let db;
let isConnected = false;

// Connect to MongoDB
async function connectDB() {
    try {
        await client.connect();
        db = client.db("attendance_system");
        isConnected = true;
        await db.collection('face_verification_images').createIndex(
            { record_id: 1, event_type: 1 }, { unique: true }
        );
        await db.collection('face_verification_images').createIndex(
            { expires_at: 1 }, { expireAfterSeconds: 0 }
        );
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

async function storeAttendanceFaceImage(recordId, eventType, imageBase64, details = {}) {
    if (!recordId || !imageBase64) return;
    const capturedAt = details.capturedAt instanceof Date ? details.capturedAt : new Date();
    const setting = await db.collection('face_verification_settings').findOne({ _id: 'retention' });
    const retentionDays = Number.isInteger(Number(setting?.retention_days))
        ? Number(setting.retention_days) : 90;
    const image = {
        record_id: String(recordId),
        source_collection: 'attendance_records',
        event_type: eventType,
        employee_id: details.employeeId || null,
        name: details.name || null,
        date: details.date || null,
        image_base64: imageBase64,
        captured_at: capturedAt,
        created_at: new Date()
    };
    if (retentionDays > 0) {
        image.expires_at = new Date(capturedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
    }
    await db.collection('face_verification_images').replaceOne(
        { record_id: image.record_id, event_type: eventType }, image, { upsert: true }
    );
}

// ========== HELPER FUNCTIONS FOR LATE DETECTION ==========

// Parse time string to minutes since midnight
function timeToMinutes(timeStr) {
    const parts = timeStr.split(':');
    const hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1]);
    const seconds = parts[2] ? parseInt(parts[2]) : 0;
    return (hours * 60) + minutes + (seconds / 60);
}

// ===== LATE TIER ENGINE START =====
// Decides whether a clock-in is "late" and which tier it belongs to, using the
// "Deduction (min)" value of each tier on the Late Deduction settings screen.
//
// Source of truth (MongoDB, database "attendance_system"):
//   late_deduction_settings   -> one document: morning/night { work_start, grace_minutes?, thresholds[] }
//   attendance_settings       -> one document: clock_in_start, night_shift_start, night_shift_end,
//                                grace_period_minutes
// Each threshold is { from_minutes, to_minutes, deduction_minutes, description }.
//
// RULE (From/To are NOT used, only deduction_minutes):
//   minutes_late = clock-in time - work start              (e.g. 08:31 - 08:00 = 31)
//   A tier applies once minutes_late is MORE than its deduction_minutes.
//   The tier with the highest deduction_minutes that applies wins.
//   deduction_minutes = 0 is the grace tier (no violation).
//   Violation = the winning tier has deduction_minutes > 0.
//
//   With tiers 0 / 30 / 60 and work start 08:00:
//     08:00 - 08:30  -> grace, no violation
//     08:31 - 09:00  -> "Minor late (30 min)"
//     09:01 and later -> "Major late (1 hour)"

const DEFAULT_LATE_TIERS = [
    { from_minutes: 0, to_minutes: 15, deduction_minutes: 0, description: "Grace period" },
    { from_minutes: 15, to_minutes: 30, deduction_minutes: 30, description: "Minor late (30 min)" },
    { from_minutes: 30, to_minutes: 999, deduction_minutes: 60, description: "Major late (1 hour)" }
];

const DEFAULT_LATE_SETTINGS = {
    enabled: true,
    deduction_rule: "tiered",
    morning: { work_start: "08:00", thresholds: DEFAULT_LATE_TIERS },
    night: { work_start: "22:00", grace_minutes: 15, thresholds: DEFAULT_LATE_TIERS }
};

// "08:31", "08:31:45" or an ISO string -> whole minutes since midnight (seconds ignored, like payroll)
function hhmmToMinutes(value) {
    if (!value) return null;
    const parts = String(value).split('T').pop().split(':');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return hours * 60 + minutes;
}

function minutesToHHMM(totalMinutes) {
    const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
    const h = String(Math.floor(wrapped / 60)).padStart(2, '0');
    const m = String(wrapped % 60).padStart(2, '0');
    return `${h}:${m}`;
}

// Night shift = clock-in from 10:00 PM up to 6:00 AM (unchanged from the previous behaviour)
function isNightClockIn(clockInTime) {
    const minutes = hhmmToMinutes(clockInTime);
    if (minutes === null) return false;
    return minutes >= (22 * 60) || minutes <= (6 * 60);
}

// ===== CLOCK-IN WINDOW GUARD START =====
// Employees may only clock in inside these windows (Company Calendar > General Settings / Night Shift):
//   Day shift   : clock_in_start .. clock_in_end   (default 08:00 - 17:00), never later than clock_out_start
//   Night shift : night_shift_start .. night_shift_end, crossing midnight (default 22:00 - 06:00, end exclusive)
// Anything else (17:01 - 21:59 and 06:00 - 07:59 with the defaults) is rejected.
// Pure function (no DB access) so it can be unit-tested.
function formatClock12(minutes) {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    const h24 = Math.floor(wrapped / 60);
    const m = String(wrapped % 60).padStart(2, '0');
    const suffix = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${String(h12).padStart(2, '0')}:${m} ${suffix}`;
}

function checkClockInWindow(clockInTime, attendanceSettings) {
    const settings = attendanceSettings || {};
    const pick = (value, fallback) => {
        const minutes = hhmmToMinutes(value);
        return minutes === null ? fallback : minutes;
    };

    const dayStart = pick(settings.clock_in_start, 8 * 60);
    let dayEnd = pick(settings.clock_in_end, 17 * 60);
    const clockOutStart = hhmmToMinutes(settings.clock_out_start);
    if (clockOutStart !== null && clockOutStart < dayEnd) dayEnd = clockOutStart; // no clock-in once clock-out time begins

    const nightEnabled = settings.night_shift_enabled !== false;
    const nightStart = pick(settings.night_shift_start, 22 * 60);
    const nightEnd = pick(settings.night_shift_end, 6 * 60);

    const windows = {
        day: { start: minutesToHHMM(dayStart), end: minutesToHHMM(dayEnd) },
        night: nightEnabled ? { start: minutesToHHMM(nightStart), end: minutesToHHMM(nightEnd) } : null
    };
    const allowedText = `Clock-in is only allowed ${formatClock12(dayStart)} - ${formatClock12(dayEnd)} (day shift)` +
        (nightEnabled ? ` or ${formatClock12(nightStart)} - ${formatClock12(nightEnd)} (night shift)` : '') + '.';

    const clockIn = hhmmToMinutes(clockInTime);
    if (clockIn === null) {
        return { allowed: false, shift: null, windows, message: `Invalid clock-in time. ${allowedText}` };
    }

    if (clockIn >= dayStart && clockIn <= dayEnd) {
        return { allowed: true, shift: 'day', windows, message: null };
    }
    if (nightEnabled) {
        const inNight = nightStart > nightEnd
            ? (clockIn >= nightStart || clockIn < nightEnd)     // crosses midnight
            : (clockIn >= nightStart && clockIn < nightEnd);
        if (inNight) return { allowed: true, shift: 'night', windows, message: null };
    }
    return {
        allowed: false,
        shift: null,
        windows,
        message: `${allowedText} Your clock-in time was ${formatClock12(clockIn)}.`
    };
}
// ===== CLOCK-IN WINDOW GUARD END =====

async function getLateDeductionSettings() {
    try {
        if (!isConnected) return DEFAULT_LATE_SETTINGS;
        const settings = await db.collection('late_deduction_settings').findOne({});
        return settings || DEFAULT_LATE_SETTINGS;
    } catch (error) {
        console.error("Error getting late deduction settings:", error);
        return DEFAULT_LATE_SETTINGS;
    }
}

// Pure function (no DB access) so it can be unit-tested.
function evaluateLateness(clockInTime, isNight, lateSettings, attendanceSettings) {
    const result = {
        isLate: false,
        minutesLate: 0,          // minutes after the work start
        tierLabel: null,
        deductionMinutes: 0,
        severity: null,
        workStart: null,
        graceMinutes: 0,
        cutoffTime: null         // same as workStart (kept for response compatibility)
    };

    const clockIn = hhmmToMinutes(clockInTime);
    if (clockIn === null) return result;

    const late = lateSettings || DEFAULT_LATE_SETTINGS;
    const attendance = attendanceSettings || {};
    const shiftConfig = (isNight ? late.night : late.morning) || {};

    // Work start: attendance_settings first, then the late-settings screen, then 08:00 / 22:00
    let workStart = hhmmToMinutes(isNight ? attendance.night_shift_start : attendance.clock_in_start);
    if (workStart === null) workStart = hhmmToMinutes(shiftConfig.work_start);
    if (workStart === null) workStart = isNight ? 22 * 60 : 8 * 60;

    // Night shift: a clock-in after midnight belongs to the shift that started the evening before
    let adjustedClockIn = clockIn;
    const nightStart = hhmmToMinutes(attendance.night_shift_start || "22:00");
    const nightEnd = hhmmToMinutes(attendance.night_shift_end || "06:00");
    if (isNight && nightStart !== null && nightEnd !== null && nightStart > nightEnd && clockIn < nightEnd) {
        adjustedClockIn += 24 * 60;
    }

    const minutesLate = adjustedClockIn - workStart; // minutes after the work start
    result.workStart = minutesToHHMM(workStart);
    result.cutoffTime = result.workStart;
    if (minutesLate <= 0) return result; // on time
    result.minutesLate = minutesLate;

    // Flat / percentage rules (or deductions turned off) have no tiers: use the plain grace period
    if (late.enabled === false || (late.deduction_rule && late.deduction_rule !== "tiered")) {
        const graceRaw = shiftConfig.grace_minutes !== undefined && shiftConfig.grace_minutes !== null
            ? shiftConfig.grace_minutes
            : (attendance.grace_period_minutes !== undefined && attendance.grace_period_minutes !== null
                ? attendance.grace_period_minutes : 15);
        result.graceMinutes = Math.max(0, parseInt(graceRaw, 10) || 0);
        if (minutesLate <= result.graceMinutes) return result;
        result.isLate = true;
        result.tierLabel = "Late";
        result.severity = "Medium";
        return result;
    }

    const tiers = (Array.isArray(shiftConfig.thresholds) && shiftConfig.thresholds.length > 0)
        ? shiftConfig.thresholds : DEFAULT_LATE_TIERS;

    // Order tiers by their Deduction (min); the highest one that minutes_late has passed wins
    const ordered = tiers
        .map(tier => ({ tier, deduction: Math.max(0, Number(tier.deduction_minutes) || 0) }))
        .sort((a, b) => a.deduction - b.deduction);

    let matched = null;
    for (const entry of ordered) {
        if (minutesLate > entry.deduction) matched = entry;
    }
    if (!matched) return result;

    result.tierLabel = matched.tier.description || `Late (${matched.deduction} min deduction)`;
    result.deductionMinutes = matched.deduction;
    if (matched.deduction > 0) {
        result.isLate = true; // a tier that deducts pay = a violation
        const paid = ordered.filter(entry => entry.deduction > 0);
        const rank = paid.indexOf(matched);
        if (paid.length === 1) result.severity = "Medium";
        else if (rank === 0) result.severity = "Low";
        else if (rank === paid.length - 1) result.severity = "High";
        else result.severity = "Medium";
    }
    return result; // grace tier (0 deduction) => not late, no violation
}
// ===== LATE TIER ENGINE END =====

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

// Violations live in a different database than the attendance data:
//   database: ems_violations, collection: employee_violations
function violationsCollection() {
    return client.db("ems_violations").collection("employee_violations");
}

// Create late violation based on the payroll deduction tier (lateInfo comes from evaluateLateness)
async function createLateViolation(employeeName, employeeIdValue, clockInTime, attendanceDate, shiftType, lateInfo) {
    try {
        if (!isConnected) {
            console.log("⚠️ MongoDB not connected, cannot create violation");
            return null;
        }
        
        console.log(`\n📝 Creating violation for: ${employeeName}`);
        
        // STEP 1: Get employeeId from attendance_system.employee_faces
        let employeeId = employeeIdValue || null;
        let department = "Unknown";
        
        try {
            // Look up employee by name in attendance_system.employee_faces
            const employee = employeeId
                ? await db.collection('employee_faces').findOne({ employee_id: employeeId })
                : await db.collection('employee_faces').findOne({ name: employeeName });
            
            if (employee) {
                employeeId = employee.employee_id || employeeId;
                department = employee.department || "Unknown";
                console.log(`   Found employee ID: ${employeeId}`);
                console.log(`   Department: ${department}`);
            } else {
                console.log(`   ⚠️ Employee not found in employee_faces for name: ${employeeName}`);
                employeeId = employeeId || `UNKNOWN_${employeeName.replace(/\s/g, '_')}`;
            }
        } catch (error) {
            console.error(`   Error looking up employee: ${error.message}`);
            employeeId = employeeId || `UNKNOWN_${employeeName.replace(/\s/g, '_')}`;
        }
        
        // STEP 2: Build the description from the matched tier
        const minutesLate = lateInfo.minutesLate;
        const tierLabel = lateInfo.tierLabel || "Late";
        let description = `${tierLabel}: ${shiftType} shift - clocked in at ${clockInTime}, ` +
            `${minutesLate} minute${minutesLate !== 1 ? 's' : ''} after the ${lateInfo.workStart} work start.`;
        if (lateInfo.deductionMinutes > 0) {
            description += ` Payroll deduction: ${lateInfo.deductionMinutes} minutes.`;
        }
        
        // STEP 3: Check if violation already exists for this employee on this date
        const existingViolation = await violationsCollection().findOne({
            employeeId: employeeId,
            date: attendanceDate,
            violationType: "Tardiness"
        });
        
        if (existingViolation) {
            console.log(`⚠️ Tardiness violation already exists for ${employeeName} (${employeeId}) on ${attendanceDate}`);
            return null;
        }
        
        // STEP 4: Create violation document
        const violation = {
            employeeId: employeeId,            // e.g., "GREMP004"
            employeeName: employeeName,        // e.g., "Jan Mark F. Selge"
            department: department,            // e.g., "Graphics"
            violationType: "Tardiness",        // Fixed value (the Violations page filters on this)
            description: description,          // e.g., "Minor late (30 min): Morning shift - clocked in at ..."
            status: "Pending",                 // Default status
            severity: lateInfo.severity || "Medium", // Low = lowest deducting tier ... High = highest tier
            createdAt: new Date(),             // Current timestamp
            source: "auto_late_detection",     // Source of creation
            date: attendanceDate,              // Attendance date (used for de-duplication)
            lateTier: tierLabel,               // e.g., "Minor late (30 min)" / "Major late (1 hour)"
            lateMinutes: minutesLate,          // Minutes after the work start
            deductionMinutes: lateInfo.deductionMinutes, // Deduction (min) of the matched tier
            shiftType: shiftType               // "Morning" | "Night"
        };
        
        console.log(`📤 Inserting violation:`);
        console.log(`   employeeId: ${violation.employeeId}`);
        console.log(`   employeeName: ${violation.employeeName}`);
        console.log(`   department: ${violation.department}`);
        console.log(`   tier: ${violation.lateTier} (${violation.deductionMinutes} min deduction)`);
        console.log(`   description: ${violation.description}`);
        
        const result = await violationsCollection().insertOne(violation);
        
        console.log(`✅ Created tardiness violation for ${employeeName} (${employeeId})`);
        console.log(`   Late minutes: ${minutesLate}`);
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
        
        // Filter ONLY employees with role "Employee"
        const employees = await db.collection('employee_faces')
            .find({ role: "Employee" })
            .project({ 
                _id: 1, 
                employee_id: 1, 
                name: 1,
                department: 1,
                role: 1
            })
            .toArray();
        
        console.log(`📋 Found ${employees.length} employees for dropdown (Employee role only)`);
        
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
            // Employee face photos are now stored in the private employee_images
            // GridFS bucket. Keep the Android sync API response compatible by
            // materializing only this selected employee's face as base64.
            if (!employee.face_image_base64 && employee.face_image_file_id) {
                const fileId = employee.face_image_file_id instanceof ObjectId
                    ? employee.face_image_file_id
                    : new ObjectId(String(employee.face_image_file_id));
                const bucket = new GridFSBucket(db, { bucketName: 'employee_images' });
                const chunks = [];
                await new Promise((resolve, reject) => {
                    const download = bucket.openDownloadStream(fileId);
                    download.on('data', chunk => chunks.push(chunk));
                    download.on('error', reject);
                    download.on('end', resolve);
                });
                employee.face_image_base64 = Buffer.concat(chunks).toString('base64');
            }
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

// Clock in (UPDATED: tier-based late detection + active night shift guard)
app.post('/api/attendance/clock-in', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { local_id, employee_id, name, clock_in_time, date, face_image_base64 } = req.body;
        
        console.log(`⏰ Clock-in: ${name} at ${clock_in_time} on ${date}`);
        
        // Which shift window does this clock-in fall into? (windows come from attendance_settings)
        const attendanceSettings = await getAttendanceSettings();
        const windowCheck = checkClockInWindow(clock_in_time, attendanceSettings);
        const isNightShiftClockIn = windowCheck.shift === 'night';
        
        // Check if already clocked in today
        const clientRecordId = local_id ? `${employee_id}:${local_id}` : null;
        const existing = clientRecordId
            ? await db.collection('attendance_records').findOne({ $or: [
                { client_record_id: clientRecordId }, { employee_id, date }, { name, date }
            ] })
            : await db.collection('attendance_records').findOne({ employee_id, date });
        
        if (existing) {
            console.log(`⚠️ Already clocked in today: ${name}`);
            if (clientRecordId && !existing.client_record_id) {
                await db.collection('attendance_records').updateOne(
                    { _id: existing._id },
                    { $set: { employee_id, client_record_id: clientRecordId } }
                );
            }
            return res.json({ 
                success: true,
                message: "Clock-in already recorded",
                record_id: existing._id
            });
        }
 
        // ===== CHECK 0: clock-in window (day shift / night shift only) =====
        if (!windowCheck.allowed) {
            console.log(`⛔ Clock-in rejected for ${name} at ${clock_in_time}: outside the allowed clock-in windows`);
            return res.json({
                success: false,
                code: "OUTSIDE_CLOCK_IN_WINDOW",
                message: windowCheck.message,
                clock_in_windows: windowCheck.windows
            });
        }

        // ===== CHECK 1: Active night shift (not clocked out) =====
        const yesterday = new Date(`${date}T00:00:00.000Z`);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayDate = yesterday.toISOString().split('T')[0];
 
        const activeNightShift = await db.collection('attendance_records').findOne({
            $or: [{ employee_id }, { name }],
            date: yesterdayDate,
            shift_type: "night",
            $and: [{ $or: [
                { clock_out_time: { $exists: false } },
                { clock_out_time: null },
                { clock_out_time: '' }
            ] }]
        });
 
        if (activeNightShift) {
            console.log(`⚠️ Active night shift found for ${name} on ${yesterdayDate}, blocking clock-in`);
            return res.json({
                success: false,
                message: "Active night shift still open. Please clock out first.",
                active_night_shift: {
                    date: yesterdayDate,
                    clock_in_time: activeNightShift.clock_in_time
                }
            });
        }
        
        // ===== CHECK 2: Recently completed night shift (ended today) =====
        // This prevents clocking in for morning shift right after night shift ends
        if (!isNightShiftClockIn) {
            // This is a morning shift clock-in - check if night shift ended today
            const today = date;
            
            // Find night shifts that ended today (either manual or auto)
            const recentNightShifts = await db.collection('attendance_records').find({
                $and: [
                    { $or: [{ employee_id }, { name }] },
                    { $or: [
                        { clock_out_date: today },
                        { auto_clock_out_date: today }
                    ] }
                ],
                shift_type: "night",
                clock_out_time: { $nin: [null, ""] }
            }).sort({ clock_out_time: -1 }).limit(1).toArray();
            
            if (recentNightShifts.length > 0) {
                const nightShift = recentNightShifts[0];
                const clockOutTime = nightShift.clock_out_time;
                const clockOutDate = nightShift.clock_out_date || nightShift.auto_clock_out_date;
                
                console.log(`⚠️ Found night shift that ended today at ${clockOutTime} on ${clockOutDate}`);
                
                // Parse clock-out hour
                const clockOutHour = parseInt(clockOutTime.split(':')[0]);
                
                // If night shift ended after 6:00 AM, block morning shift
                if (clockOutHour >= 6) {
                    console.log(`⚠️ Night shift ended at ${clockOutTime} - too late for morning shift`);
                    return res.json({
                        success: false,
                        message: `Cannot clock in for morning shift. Your night shift ended at ${clockOutTime}. You can only clock in for night shift after 10:00 PM.`,
                        night_shift_end_time: clockOutTime,
                        night_shift_end_date: clockOutDate,
                        next_allowed_clock_in: "10:00 PM"
                    });
                }
            }
        }
        
        // ===== LATE DETECTION (based on Deduction (min) tiers) =====
        const lateSettings = await getLateDeductionSettings();
        
        const isNightShift = isNightShiftClockIn; // same window decision as the guard above
        const shiftType = isNightShift ? "Night" : "Morning";
        const lateInfo = evaluateLateness(clock_in_time, isNightShift, lateSettings, attendanceSettings);
        const isLate = lateInfo.isLate;
        let violationId = null;
        
        if (isLate) {
            console.log(`⚠️ ${shiftType.toUpperCase()} LATE: ${name} at ${clock_in_time} -> ${lateInfo.tierLabel} ` +
                `(${lateInfo.minutesLate} min after ${lateInfo.workStart}, ${lateInfo.deductionMinutes} min deduction)`);
        } else {
            console.log(`✅ On time: ${name} at ${clock_in_time} (${shiftType} shift)`);
        }
        
        // Create attendance record with late status
        const record = {
            employee_id,
            name: name,
            client_record_id: clientRecordId,
            clock_in_time: clock_in_time,
            date: date,
            timestamp: new Date(),
            sync_status: "synced",
            late_status: isLate ? "late" : "on_time",
            late_minutes: isLate ? lateInfo.minutesLate : 0,
            late_tier: isLate ? lateInfo.tierLabel : null,
            late_deduction_minutes: isLate ? lateInfo.deductionMinutes : 0,
            shift_type: shiftType.toLowerCase(),
            clock_in_verified: !!face_image_base64,
            clock_in_captured_at: new Date(),
            manually_verified: false
        };
        
        const result = await db.collection('attendance_records').insertOne(record);
        if (face_image_base64) {
            await storeAttendanceFaceImage(result.insertedId, 'clock_in', face_image_base64, {
                employeeId: employee_id, name, date, capturedAt: record.clock_in_captured_at
            });
        }
        
        console.log(`✅ Clock-in recorded: ${name}`);
        
        // Create violation if the matched tier deducts pay
        if (isLate) {
            violationId = await createLateViolation(
                name,           // employeeName
                employee_id,    // stable employee identity
                clock_in_time,  // clockInTime
                date,           // attendanceDate
                shiftType,      // shiftType
                lateInfo        // matched tier details
            );
        }
        
        // Build response
        const response = {
            success: true,
            message: "Clocked in successfully",
            record_id: result.insertedId,
            shift_type: shiftType.toLowerCase()
        };
        
        if (isLate) {
            response.late_detection = {
                is_late: true,
                late_minutes: lateInfo.minutesLate,
                late_tier: lateInfo.tierLabel,
                deduction_minutes: lateInfo.deductionMinutes,
                shift_type: shiftType,
                violation_created: violationId !== null
            };
            if (violationId) {
                response.late_detection.violation_id = violationId;
            }
            response.message += ` (⚠️ ${lateInfo.tierLabel} - ${lateInfo.minutesLate} minute${lateInfo.minutesLate !== 1 ? 's' : ''} after work start, ${shiftType} shift)`;
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
        
        const { local_id, employee_id, name, clock_out_time, date, clock_out_date, face_image_base64 } = req.body;
        
        console.log(`⏰ Clock-out: ${name} at ${clock_out_time}`);
        console.log(`📅 Clock-out date: ${clock_out_date || date}`);
        
        const finalClockOutDate = clock_out_date || date;
        
        const clientRecordId = local_id ? `${employee_id}:${local_id}` : null;
        const filter = clientRecordId
            ? { client_record_id: clientRecordId }
            : { employee_id, date, $or: [
                { clock_out_time: { $exists: false } },
                { clock_out_time: null },
                { clock_out_time: '' }
            ] };
        const openRecord = await db.collection('attendance_records').findOne(filter, {
            projection: { _id: 1 }
        });
        if (!openRecord) {
            console.log(`⚠️ No clock-in record found for ${name} on ${date}`);
            return res.json({
                success: false,
                message: "No clock-in record found"
            });
        }
        const result = await db.collection('attendance_records').updateOne(
            { _id: openRecord._id },
            { 
                $set: { 
                    employee_id,
                    name,
                    ...(clientRecordId ? { client_record_id: clientRecordId } : {}),
                    clock_out_time: clock_out_time,
                    clock_out_date: finalClockOutDate,
                    clock_out_verified: !!face_image_base64,
                    clock_out_captured_at: new Date()
                } 
            }
        );
        
        if (result.matchedCount > 0) {
            if (face_image_base64) {
                await storeAttendanceFaceImage(openRecord._id, 'clock_out', face_image_base64, {
                    employeeId: employee_id, name, date: finalClockOutDate
                });
            }
            console.log(`✅ Clock-out recorded for ${name} on ${finalClockOutDate}`);
            res.json({ 
                success: true, 
                message: "Clocked out successfully",
                record_id: openRecord._id,
                clock_out_date: finalClockOutDate
            });
        } else {
            console.log(`⚠️ No clock-in record found for ${name} on ${date}`);
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

// ========== VIOLATIONS ENDPOINTS ==========
// (violations are stored in database "ems_violations", collection "employee_violations")

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
        
        const violations = await violationsCollection()
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
        
        let cursor = violationsCollection()
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
        
        const attendanceSettings = await getAttendanceSettings();
        const lateSettings = await getLateDeductionSettings();
        
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
                
                const isNightShift = isNightClockIn(clockInTime);
                const shiftType = isNightShift ? "Night" : "Morning";
                const lateInfo = evaluateLateness(clockInTime, isNightShift, lateSettings, attendanceSettings);
                
                if (lateInfo.isLate) {
                    lateDetected++;
                    
                    const existingViolation = await violationsCollection().findOne({
                        $or: [
                            { employeeId: record.employee_id },
                            { employeeName: employeeName }
                        ],
                        date: attendanceDate,
                        violationType: "Tardiness"
                    });
                    
                    if (!existingViolation) {
                        const violationId = await createLateViolation(
                            employeeName,
                            record.employee_id,
                            clockInTime,
                            attendanceDate,
                            shiftType,
                            lateInfo
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
                                late_minutes: lateInfo.minutesLate,
                                late_tier: lateInfo.tierLabel,
                                late_deduction_minutes: lateInfo.deductionMinutes
                            }
                        }
                    );
                } else {
                    // Mark as on time (also corrects records previously flagged late by the old fixed threshold)
                    await db.collection('attendance_records').updateOne(
                        { _id: record._id },
                        { $set: { late_status: "on_time", late_minutes: 0 } }
                    );
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

// Preview which tier a clock-in time falls into (read-only, handy for testing your tier settings)
//   GET /api/attendance/late-preview?time=08:31
//   GET /api/attendance/late-preview?time=00:40&shift=night
app.get('/api/attendance/late-preview', async (req, res) => {
    try {
        const time = String(req.query.time || '');
        if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(time)) {
            return res.status(400).json({
                success: false,
                message: "Use ?time=HH:MM (24-hour), e.g. ?time=08:31"
            });
        }
        const isNight = req.query.shift
            ? String(req.query.shift).toLowerCase() === 'night'
            : isNightClockIn(time);
        const attendanceSettings = await getAttendanceSettings();
        const lateSettings = await getLateDeductionSettings();
        const lateInfo = evaluateLateness(time, isNight, lateSettings, attendanceSettings);
        res.json({
            success: true,
            clock_in_time: time,
            shift_type: isNight ? "Night" : "Morning",
            creates_violation: lateInfo.isLate,
            result: lateInfo
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== SYNC ENDPOINT ==========
app.get('/api/attendance/cloud-records', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { date } = req.query;
        
        if (!date) {
            return res.status(400).json({ 
                success: false, 
                message: "Date parameter required" 
            });
        }
        
        const records = await db.collection('attendance_records')
            .find({ date: date })
            .toArray();
        
        res.json({
            success: true,
            records: records,
            count: records.length
        });
        
    } catch (error) {
        console.error("❌ Error fetching cloud records:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

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
        const syncSettings = await getAttendanceSettings();
        for (const record of pending_records || []) {
            try {
                const clientRecordId = record.local_id && record.employee_id
                    ? `${record.employee_id}:${record.local_id}` : null;
                const filter = clientRecordId
                    ? { $or: [
                        { client_record_id: clientRecordId },
                        { employee_id: record.employee_id, date: record.date },
                        { name: record.name, date: record.date }
                    ] }
                    : { $or: [
                        { employee_id: record.employee_id, date: record.date },
                        { name: record.name, date: record.date }
                    ] };
                // Offline-saved clock-ins must respect the clock-in windows too. Records that already
                // exist on the server (e.g. a later clock-out sync) are not re-checked.
                if (record.clock_in_time) {
                    const alreadyOnServer = await db.collection('attendance_records')
                        .findOne(filter, { projection: { _id: 1 } });
                    if (!alreadyOnServer) {
                        const windowCheck = checkClockInWindow(record.clock_in_time, syncSettings);
                        if (!windowCheck.allowed) {
                            console.log(`⛔ Sync rejected for ${record.name} at ${record.clock_in_time}: outside the allowed clock-in windows`);
                            results.push({
                                id: record.local_id,
                                success: false,
                                rejected: true,
                                code: "OUTSIDE_CLOCK_IN_WINDOW",
                                message: windowCheck.message
                            });
                            continue;
                        }
                    }
                }
                const set = {
                    employee_id: record.employee_id,
                    name: record.name,
                    date: record.date,
                    clock_in_time: record.clock_in_time,
                    timestamp: new Date(),
                    sync_status: "synced",
                    manually_verified: false
                };
                if (clientRecordId) set.client_record_id = clientRecordId;
                if (record.face_image_base64) {
                    set.clock_in_verified = true;
                    set.clock_in_captured_at = new Date();
                }
                if (record.clock_out_time) {
                    set.clock_out_time = record.clock_out_time;
                    set.clock_out_date = record.clock_out_date || record.date;
                    if (record.face_image_base64) {
                        set.clock_out_verified = true;
                        set.clock_out_captured_at = new Date();
                    }
                }
                const result = await db.collection('attendance_records').updateOne(
                    filter, { $set: set }, { upsert: true }
                );
                const saved = result.upsertedId
                    ? { _id: result.upsertedId }
                    : await db.collection('attendance_records').findOne(filter, { projection: { _id: 1 } });
                if (saved?._id && record.face_image_base64) {
                    await storeAttendanceFaceImage(saved._id, 'clock_in', record.face_image_base64, {
                        employeeId: record.employee_id, name: record.name, date: record.date,
                        capturedAt: set.clock_in_captured_at
                    });
                    if (record.clock_out_time) {
                        await storeAttendanceFaceImage(saved._id, 'clock_out', record.face_image_base64, {
                            employeeId: record.employee_id, name: record.name,
                            date: record.clock_out_date || record.date,
                            capturedAt: set.clock_out_captured_at
                        });
                    }
                }
                results.push({ id: record.local_id, success: !!saved, mongo_id: saved?._id });
            } catch (recordError) {
                results.push({ id: record.local_id, success: false, message: recordError.message });
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
            'POST /api/attendance/check-late-violations',
            'GET /api/attendance/late-preview',
            'GET /api/hardware/status/:device_id',
            'POST /api/hardware/register',
            'PUT /api/hardware/authorize',
            'GET /api/hardware/pending'
        ],
        mongodb_status: isConnected ? '✅ Connected' : '❌ Disconnected'
    });
});

// ========== ATTENDANCE SETTINGS ENDPOINT ==========
app.get('/api/attendance/settings', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        // Get settings from attendance_settings collection
        const settings = await db.collection('attendance_settings').findOne({});
        
        if (settings) {
            // Remove _id from response
            delete settings._id;
            
            console.log("📋 Attendance settings retrieved");
            
            res.json({
                success: true,
                settings: settings
            });
        } else {
            // Return default settings if none exist
            const defaultSettings = {
                clock_in_start: "08:00",
                clock_in_end: "17:00",
                clock_out_start: "17:00",
                clock_out_end: "22:00",
                grace_period_minutes: 15,
                late_threshold: "08:16",
                standard_work_hours: 8,
                overtime_rate: 1.25,
                sunday_rate: 1.30,
                holiday_rate: 2.00,
                night_shift_enabled: true,
                night_shift_start: "22:00",
                night_shift_end: "06:00"
            };
            
            // Optionally save default settings to database
            await db.collection('attendance_settings').insertOne(defaultSettings);
            
            res.json({
                success: true,
                settings: defaultSettings
            });
        }
    } catch (error) {
        console.error("❌ Error fetching attendance settings:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// ========== HARDWARE ID / DEVICE LOCK ENDPOINTS ==========

// Register or update hardware device
app.post('/api/hardware/register', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { device_id, device_name, device_model, android_version, app_version, last_seen } = req.body;
        
        console.log(`📱 Registering device: ${device_name} (${device_id})`);
        
        // Check if device already exists
        const existing = await db.collection('hardware_id').findOne({ device_id: device_id });
        
        if (existing) {
            // Update last seen
            await db.collection('hardware_id').updateOne(
                { device_id: device_id },
                { 
                    $set: { 
                        last_seen: last_seen,
                        device_name: device_name,
                        device_model: device_model,
                        android_version: android_version,
                        app_version: app_version,
                        updated_at: new Date()
                    }
                }
            );
            
            console.log(`🔄 Updated device: ${device_id}, authorized: ${existing.is_authorized}`);
            
            return res.json({
                success: true,
                message: existing.is_authorized ? "Device is authorized" : "Waiting for authorization",
                is_authorized: existing.is_authorized,
                device: {
                    device_id: existing.device_id,
                    device_name: existing.device_name,
                    device_model: existing.device_model,
                    android_version: existing.android_version,
                    app_version: existing.app_version,
                    is_authorized: existing.is_authorized,
                    authorized_at: existing.authorized_at,
                    last_seen: existing.last_seen,
                    created_at: existing.created_at
                }
            });
        } else {
            // Create new device request
            const newDevice = {
                device_id: device_id,
                device_name: device_name,
                device_model: device_model,
                android_version: android_version,
                app_version: app_version,
                is_authorized: false,
                authorized_at: null,
                last_seen: last_seen,
                created_at: new Date(),
                updated_at: new Date()
            };
            
            await db.collection('hardware_id').insertOne(newDevice);
            
            console.log(`🆕 New device registered: ${device_id}, awaiting approval`);
            
            res.json({
                success: true,
                message: "Device registered, waiting for admin approval",
                is_authorized: false,
                device: newDevice
            });
        }
    } catch (error) {
        console.error("❌ Hardware registration error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Get hardware status
app.get('/api/hardware/status/:device_id', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { device_id } = req.params;
        
        const device = await db.collection('hardware_id').findOne({ device_id: device_id });
        
        if (!device) {
            return res.json({
                success: true,
                message: "Device not registered",
                is_authorized: false,
                device: null
            });
        }
        
        res.json({
            success: true,
            message: device.is_authorized ? "Authorized" : "Pending",
            is_authorized: device.is_authorized,
            device: device
        });
    } catch (error) {
        console.error("❌ Hardware status error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Authorize hardware device (ADMIN ENDPOINT)
app.put('/api/hardware/authorize', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const { device_id, is_authorized } = req.body;
        
        console.log(`🔐 Authorizing device: ${device_id} -> ${is_authorized}`);
        
        const updateData = {
            is_authorized: is_authorized,
            updated_at: new Date()
        };
        
        if (is_authorized) {
            updateData.authorized_at = new Date();
        }
        
        const result = await db.collection('hardware_id').updateOne(
            { device_id: device_id },
            { $set: updateData }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Device not found"
            });
        }
        
        const updatedDevice = await db.collection('hardware_id').findOne({ device_id: device_id });
        
        console.log(`✅ Device ${device_id} authorization set to: ${is_authorized}`);
        
        res.json({
            success: true,
            message: `Device ${is_authorized ? "authorized" : "unauthorized"} successfully`,
            device: updatedDevice
        });
    } catch (error) {
        console.error("❌ Hardware authorization error:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Get all pending hardware requests (ADMIN ENDPOINT)
app.get('/api/hardware/pending', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: "Database not connected" 
            });
        }
        
        const pendingDevices = await db.collection('hardware_id')
            .find({ is_authorized: false })
            .sort({ created_at: -1 })
            .toArray();
        
        res.json({
            success: true,
            devices: pendingDevices,
            count: pendingDevices.length
        });
    } catch (error) {
        console.error("❌ Error fetching pending devices:", error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
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
    console.log(`   GET  /api/attendance/late-preview?time=HH:MM`);
    console.log(`   POST /api/hardware/register`);
    console.log(`   GET  /api/hardware/status/:id`);
    console.log(`   PUT  /api/hardware/authorize`);
    console.log(`   GET  /api/hardware/pending`);
    console.log(`\n⏰ Press Ctrl+C to stop\n`);
});

const express = require('express')
const cors    = require('cors')
const multer  = require('multer')
require('dotenv').config()

const { hasOAuthToken } = require('./DriveService')
const { getISTDate, getISTTomorrow, isAfter430PM } = require('./helpers/ist')
const { registerCrons, updateIsTodayFlags }        = require('./crons')

// ── Routes ─────────────────────────────────────────────────
const authRoutes     = require('./routes/auth')
const designerRoutes = require('./routes/designer')
const plannerRoutes  = require('./routes/planner')
const adminRoutes    = require('./routes/admin')
const driveRoutes    = require('./routes/drive')

const app = express()
app.use(cors())
app.use(express.json())

// ── Mount routes ───────────────────────────────────────────
app.use('/',              authRoutes)          // /auth/google, /auth/callback, /api/login
app.use('/api/designer',  designerRoutes)      // /api/designer/*
app.use('/api/planner',   plannerRoutes)       // /api/planner/*
app.use('/api',           adminRoutes)         // /api/admin/*, /api/manager/*
app.use('/api/drive',     driveRoutes)         // /api/drive/*

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => res.json({ message: 'Agency Automation Backend Running!' }))

app.get('/api/test-date', (req, res) => {
  const now = new Date()
  const IST = new Date(now.getTime() + (5.5 * 60 * 60 * 1000))
  res.json({
    serverUTC:  now.toISOString(),
    istTime:    IST.toISOString(),
    istHour:    IST.getUTCHours(),
    istMinute:  IST.getUTCMinutes(),
    today:      getISTDate(),
    tomorrow:   getISTTomorrow(),
    isAfter430: isAfter430PM(),
  })
})

// ── Global error handler ───────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.log('MULTER ERROR:', err.message)
    return res.status(400).json({ error: err.message })
  }
  console.log('SERVER ERROR:', err)
  res.status(500).json({ error: err.message || 'Server error' })
})

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 5000
app.listen(PORT, async () => {
  console.log(`\n🚀 Server running on port ${PORT}`)
  console.log(`   IST Today:    ${getISTDate()}`)
  console.log(`   Tomorrow:     ${getISTTomorrow()}`)
  console.log(`   After 4:30PM: ${isAfter430PM()}`)
  await updateIsTodayFlags()
  registerCrons()
  console.log(hasOAuthToken() ? '✅ Drive connected!' : '⚠️  Visit /auth/google')
})

// http://localhost:5000/auth/google

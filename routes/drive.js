const express    = require('express')
const router     = express.Router()
const multer     = require('multer')
const { supabaseAdmin }                      = require('../supabase')
const { uploadFileToDrive, listFolders, listFilesInFolder, hasOAuthToken } = require('../DriveService')
const { runAutomationFromBuffer }            = require('../Automation')
const { authMiddleware }                     = require('../middleware/auth')
const { generateUploadToken }                = require('../helpers/ist')

const upload = multer({ storage: multer.memoryStorage() })

// POST upload CSV to Google Drive + auto-assign
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!['planner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' })
    if (!req.file) return res.status(400).json({ error: 'No file' })
    if (!hasOAuthToken()) return res.status(500).json({ error: 'Drive not connected. Visit /auth/google' })

    const plannerName = req.user.name
    const uploadToken = generateUploadToken(req.user.id)

    const driveFile = await uploadFileToDrive(
      req.file.buffer, req.file.originalname, req.file.mimetype,
      process.env.GOOGLE_DRIVE_FOLDER_ID, plannerName
    )

    const result = await runAutomationFromBuffer(req.file.buffer, plannerName)

    await supabaseAdmin.from('sync_logs').insert({
      file_name:     driveFile.name,
      rows_synced:   result?.inserted || 0,
      status:        'success',
      uploaded_by:   plannerName,
      planner_id:    req.user.id,
      upload_token:  uploadToken,
      drive_file_id: driveFile.id,
      drive_link:    driveFile.webViewLink,
    })

    res.json({ success: true, driveFile, stats: result, upload_token: uploadToken })
  } catch (err) {
    console.log('❌ DRIVE UPLOAD FULL ERROR:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET list folders
router.get('/folders', authMiddleware, async (req, res) => {
  try { res.json({ folders: await listFolders(req.query.parentId || null) }) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// GET list files in folder
router.get('/files', authMiddleware, async (req, res) => {
  try {
    const { folderId } = req.query
    if (!folderId) return res.status(400).json({ error: 'folderId required' })
    res.json({ files: await listFilesInFolder(folderId) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router

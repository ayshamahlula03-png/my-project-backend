const { google } = require('googleapis')
const { Readable } = require('stream')
const path = require('path')
const fs = require('fs')
require('dotenv').config()

// ─── OAuth2 Client ───
const getOAuthClient = () => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  const tokenPath = path.join(__dirname, 'oauth_token.json')

  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
    oauth2Client.setCredentials(token)
  }

  oauth2Client.on('tokens', (tokens) => {
    const existing = fs.existsSync(tokenPath)
      ? JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
      : {}

    const merged = { ...existing, ...tokens }

    fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2))
    console.log('✅ OAuth token refreshed & saved')
  })

  oauth2Client.on('error', (err) => {
    console.log('❌ OAuth Refresh Failed:', err.message)
  })

  return oauth2Client
}

const getDrive = () => google.drive({ version: 'v3', auth: getOAuthClient() })

// ─── Check if OAuth token exists ───
function hasOAuthToken() {
  const tokenPath = path.join(__dirname, 'oauth_token.json')
  const exists = fs.existsSync(tokenPath)
  console.log('🔍 OAuth token exists:', exists)
  return exists
}

// ─── Get Auth URL (first time setup) ───
function getAuthUrl() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file']
  })
}

// ─── Save token after OAuth callback ───
async function saveTokenFromCode(code) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
  const { tokens } = await oauth2Client.getToken(code)
  const tokenPath = path.join(__dirname, 'oauth_token.json')
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2))
  console.log('✅ OAuth token saved!')
  return tokens
}

// ─── Get latest CSV from folder (cron) ───
async function getLatestCSV() {
  const drive    = getDrive()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID
  const res      = await drive.files.list({
    q:        `'${folderId}' in parents and mimeType='text/csv' and trashed=false`,
    orderBy:  'modifiedTime desc',
    pageSize: 1,
    fields:   'files(id, name, modifiedTime)',
  })
  return res.data.files[0] || null
}

// ─── Download CSV stream ───
async function downloadCSV(fileId) {
  const drive = getDrive()
  const res   = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  )
  return res.data
}

// ─── List folders/files inside agency folder ───
async function listFolders(parentId = null) {
  const drive          = getDrive()
  const resolvedParent = parentId || process.env.GOOGLE_DRIVE_FOLDER_ID

  try {
    const res = await drive.files.list({
      q:        `'${resolvedParent}' in parents and trashed=false`,
      orderBy:  'name',
      fields:   'files(id, name, parents, mimeType, modifiedTime)',
      pageSize: 50,
    })
    const files = res.data.files || []
    console.log(`📁 Drive: found ${files.length} items`)
    return files
  } catch (err) {
    console.error('❌ listFolders error:', err.message)
    throw err
  }
}

// ─── List files inside a folder ───
async function listFilesInFolder(folderId) {
  const drive          = getDrive()
  const resolvedFolder = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID

  try {
    const res = await drive.files.list({
      q:        `'${resolvedFolder}' in parents and trashed=false`,
      orderBy:  'modifiedTime desc',
      fields:   'files(id, name, mimeType, modifiedTime, size, webViewLink)',
      pageSize: 50,
    })
    return res.data.files || []
  } catch (err) {
    console.error('❌ listFilesInFolder error:', err.message)
    throw err
  }
}

// ─── Upload file to Drive ───
// Uses harilatha946@gmail.com OAuth — works with regular My Drive folders!
async function uploadFileToDrive(fileBuffer, fileName, mimeType, folderId, plannerName) {
  const drive        = getDrive()
  const bufferStream = new Readable()
  bufferStream.push(fileBuffer)
  bufferStream.push(null)

  // File renamed with planner name + timestamp for easy identification
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const finalName = plannerName
    ? `${plannerName}_${timestamp}_${fileName}`
    : fileName

  try {
    const res = await drive.files.create({
      requestBody: {
        name:    finalName,
        parents: [folderId || process.env.GOOGLE_DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: mimeType || 'text/csv',
        body:     bufferStream,
      },
      fields: 'id, name, webViewLink',
    })
    console.log(`✅ Uploaded to Drive: ${finalName}`)
    return res.data
  } catch (err) {
    console.error('❌ uploadFileToDrive error:', err.message)
    throw err
  }
}

// ─── Get file view link ───
async function getFileViewLink(fileId) {
  const drive = getDrive()
  const res   = await drive.files.get({
    fileId,
    fields: 'id, name, webViewLink, mimeType',
  })
  return res.data
}

// ─── Create folder ───
async function createFolder(folderName, parentId = null) {
  const drive          = getDrive()
  const resolvedParent = parentId || process.env.GOOGLE_DRIVE_FOLDER_ID

  try {
    const res = await drive.files.create({
      requestBody: {
        name:     folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents:  [resolvedParent],
      },
      fields: 'id, name',
    })
    console.log(`📁 Created folder: ${folderName}`)
    return res.data
  } catch (err) {
    console.error('❌ createFolder error:', err.message)
    throw err
  }
}

module.exports = {
  getLatestCSV,
  downloadCSV,
  listFolders,
  listFilesInFolder,
  uploadFileToDrive,
  getFileViewLink,
  createFolder,
  getAuthUrl,
  saveTokenFromCode,
  hasOAuthToken,
}//http://localhost:5000/auth/google
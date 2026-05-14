const express = require('express')
const router  = express.Router()
const { supabase, supabaseAdmin } = require('../supabase')
const { getAuthUrl, saveTokenFromCode, hasOAuthToken } = require('../DriveService')

router.get('/auth/google', (req, res) => res.redirect(getAuthUrl()))

router.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query
    if (!code) return res.status(400).send('No code')
    await saveTokenFromCode(code)
    res.send(`<html><body style="font-family:Arial;text-align:center;padding:60px;background:#f0fdf4">
      <h1 style="color:#15803d">✅ Google Drive Connected!</h1><p>Close this tab.</p>
    </body></html>`)
  } catch (err) { res.status(500).send(`OAuth error: ${err.message}`) }
})

router.get('/auth/status', (req, res) => {
  res.json({ connected: hasOAuthToken(), message: hasOAuthToken() ? '✅ Connected' : '❌ Visit /auth/google' })
})

router.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return res.status(401).json({ success: false, error: 'Invalid credentials' })
    const { data: profile } = await supabaseAdmin.from('profiles').select('*').eq('id', data.user.id).single()
    if (!profile) return res.status(401).json({ success: false, error: 'Profile not found' })
    res.json({
      success: true,
      token: data.session.access_token,
      user: { id: data.user.id, email: data.user.email, name: profile.name, role: profile.role }
    })
  } catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

module.exports = router

const { supabase, supabaseAdmin } = require('../supabase')

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'No token provided' })

    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) {
      console.log('❌ Auth failed:', error?.message)
      return res.status(401).json({ error: 'Invalid token' })
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles').select('*').eq('id', user.id).single()

    if (profileError || !profile) return res.status(401).json({ error: 'Profile not found' })

    req.user = { ...user, ...profile }
    next()
  } catch (err) {
    console.log('❌ Middleware crash:', err.message)
    res.status(500).json({ error: err.message })
  }
}

module.exports = { authMiddleware }

const express        = require('express')
const router         = express.Router()
const multer         = require('multer')
const { supabaseAdmin }           = require('../supabase')
const { uploadFileToDrive, hasOAuthToken } = require('../DriveService')
const { runAutomationFromBuffer } = require('../Automation')
const { authMiddleware }          = require('../middleware/auth')
const { getISTDate, generateUploadToken } = require('../helpers/ist')

const REEL_DESIGNERS = ['Divya', 'Sneha']

const upload = multer({ storage: multer.memoryStorage() })

const isPlannerOrAdmin = (req, res, next) => {
  if (!['planner', 'admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Access denied' })
  next()
}

// GET tasks (today, for this planner)
router.get('/tasks', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const today = getISTDate()
    const { data, error } = await supabaseAdmin.from('tasks').select('*')
      .eq('planner_name', req.user.name).eq('end_date', today)
      .order('end_date', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ tasks: data || [], today })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET completed tasks today
router.get('/completed-tasks', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const today = getISTDate()
    const { data } = await supabaseAdmin.from('tasks').select('*')
      .eq('planner_name', req.user.name).eq('status', 'Completed').eq('end_date', today)
      .order('completed_date', { ascending: false })
    res.json({ tasks: data || [], today })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST upload CSV (direct, no Drive)
router.post('/upload', authMiddleware, isPlannerOrAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const uploadToken = generateUploadToken(req.user.id)
    const result = await runAutomationFromBuffer(req.file.buffer, req.user.name)
    await supabaseAdmin.from('sync_logs').insert({
      file_name: req.file.originalname, rows_synced: result?.inserted || 0,
      status: 'success', uploaded_by: req.user.name,
      planner_id: req.user.id, upload_token: uploadToken,
    })
    res.json({ success: true, stats: result, upload_token: uploadToken })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET notifications
router.get('/notifications', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('notifications').select('*')
      .eq('planner_name', req.user.name)
      .order('created_at', { ascending: false }).limit(50)
    res.json({ notifications: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET all designer progress screenshots (today)
router.get('/progress-uploads', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const today = getISTDate()
    const { data, error } = await supabaseAdmin.from('progress_uploads').select('*')
      .gte('uploaded_at', `${today}T00:00:00`).lte('uploaded_at', `${today}T23:59:59`)
      .order('uploaded_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ uploads: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST request own leave (goes to admin)
router.post('/request-leave', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const { leaveDate, reason } = req.body
    if (!leaveDate) return res.status(400).json({ error: 'Leave date required' })

    const { data, error } = await supabaseAdmin.from('leave_requests').insert({
      designer_id:    req.user.id,
      designer_name:  req.user.name,
      leave_date:     leaveDate,
      reason:         reason || null,
      status:         'pending',
      requested_at:   new Date().toISOString(),
      routed_to:      'admin',
      routed_role:    'admin',
      requester_role: 'planner',
    }).select().single()

    if (error) throw error

    await supabaseAdmin.from('notifications').insert({
      planner_name:     'admin',
      message:          `📋 Planner ${req.user.name} requested leave for ${leaveDate}${reason ? ` — ${reason}` : ''}`,
      type:             'planner_leave_request',
      is_read:          false,
      created_at:       new Date().toISOString(),
      leave_request_id: data.id,
    })

    res.json({ success: true, message: 'Leave request sent to Admin' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET own leave status (today)
router.get('/leave-status', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('leave_requests').select('*')
      .eq('designer_name', req.user.name).eq('leave_date', getISTDate()).maybeSingle()
    res.json({ status: data?.status || null, leave_data: data })
  } catch { res.json({ status: null }) }
})

// GET own leave history
router.get('/my-leaves', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('leave_requests').select('*')
      .eq('designer_name', req.user.name).eq('requester_role', 'planner')
      .order('leave_date', { ascending: false }).limit(20)
    res.json({ leaves: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET designer leave requests routed to this planner (when admin on leave)
router.get('/leave-requests', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('leave_requests').select('*')
      .eq('routed_to', req.user.name).eq('status', 'pending').eq('routed_role', 'planner')
      .order('requested_at', { ascending: false })
    res.json({ requests: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST approve or reject a leave request routed to this planner
router.post('/leave-requests/:id/:action', authMiddleware, isPlannerOrAdmin, async (req, res) => {
  try {
    const { id, action } = req.params
    const { note } = req.body
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' })

    const { data: leave } = await supabaseAdmin.from('leave_requests').select('*').eq('id', id).single()
    if (!leave) return res.status(404).json({ error: 'Leave request not found' })
    if (leave.routed_to !== req.user.name) return res.status(403).json({ error: 'Not routed to you' })

    await supabaseAdmin.from('leave_requests').update({
      status:      action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: req.user.name,
      reviewed_at: new Date().toISOString(),
    }).eq('id', id)

    if (action === 'approve') {
      const { data: tasks } = await supabaseAdmin.from('tasks').select('*')
        .eq('assigned_designer', leave.designer_name)
        .in('status', ['Pending', 'Assigned', 'In Progress'])
        .or(`end_date.eq.${leave.leave_date},publish_date.eq.${leave.leave_date}`)

      const { data: others } = await supabaseAdmin.from('profiles').select('*')
        .eq('role', 'designer').neq('id', leave.designer_id)

      if (others?.length && tasks?.length) {
        for (let i = 0; i < tasks.length; i++) {
          const task     = tasks[i]
          const isReel   = (task.task_type || '').toLowerCase().includes('reel')
          const reelOths = others.filter(d => REEL_DESIGNERS.includes(d.name))
          const target   = isReel && reelOths.length ? reelOths[i % reelOths.length] : others[i % others.length]
          if (target) {
            await supabaseAdmin.from('tasks').update({
              assigned_designer: target.name, assigned_designer_id: target.id, status: 'Assigned',
            }).eq('task_id', task.task_id)
            await supabaseAdmin.from('notifications').insert({
              designer_name: target.name,
              message:       `🔄 "${task.task_type}" for ${task.client_name} reassigned to you (${leave.designer_name} on leave — approved by ${req.user.name})`,
              is_read: false, created_at: new Date().toISOString(),
            })
          }
        }
      }
      await supabaseAdmin.from('notifications').insert({
        designer_name: leave.designer_name,
        message:       `✅ Leave approved for ${leave.leave_date} by ${req.user.name}. ${tasks?.length || 0} tasks reassigned.`,
        is_read: false, created_at: new Date().toISOString(),
      })
    } else {
      await supabaseAdmin.from('notifications').insert({
        designer_name: leave.designer_name,
        message:       `❌ Leave for ${leave.leave_date} rejected by ${req.user.name}.${note ? ` Reason: ${note}` : ''}`,
        is_read: false, created_at: new Date().toISOString(),
      })
    }

    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router

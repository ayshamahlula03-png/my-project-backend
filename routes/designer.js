const express        = require('express')
const router         = express.Router()
const multer         = require('multer')
const { supabase, supabaseAdmin } = require('../supabase')
const { uploadFileToDrive }       = require('../DriveService')
const { authMiddleware }          = require('../middleware/auth')
const { getISTDate, getISTTomorrow, isAfter430PM } = require('../helpers/ist')
const { getLeaveApprover }        = require('../helpers/leave')

const uploadDesigner = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// GET tasks
router.get('/tasks', authMiddleware, async (req, res) => {
  try {
    const today        = getISTDate()
    const tomorrow     = getISTTomorrow()
    const designerName = req.user.name
    const showTomorrow = isAfter430PM()
    const dateFilter   = showTomorrow ? [today, tomorrow] : [today]

    console.log(`\n🎨 Designer: ${designerName} | Today: ${today} | ShowTomorrow: ${showTomorrow}`)

    const { data, error } = await supabase.from('tasks').select('*')
      .eq('assigned_designer', designerName)
      .in('end_date', dateFilter)
      .in('status', ['Pending', 'Assigned', 'In Progress', 'Submitted', 'Rejected', 'Completed'])
      .order('end_date', { ascending: true })

    if (error) return res.status(500).json({ error: error.message })

    const tasks = (data || []).map(t => ({
      ...t,
      day_label: t.end_date === today    ? '📅 Today' :
                 t.end_date === tomorrow ? '🔜 Tomorrow' :
                 t.end_date < today      ? '⚠️ Overdue' : `📆 ${t.end_date}`
    }))

    console.log(`✅ ${tasks.length} tasks | dates: ${dateFilter.join(', ')}`)
    res.json({ tasks, today, tomorrow, showTomorrow })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT start work
router.put('/task', authMiddleware, async (req, res) => {
  try {
    const { taskId, status } = req.body
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('task_id', taskId).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })
    if (task.assigned_designer !== req.user.name) return res.status(403).json({ error: 'Not your task' })

    await supabaseAdmin.from('tasks').update({
      status,
      started_at: status === 'In Progress' ? new Date().toISOString() : undefined,
    }).eq('task_id', taskId)

    if (status === 'In Progress') {
      await supabaseAdmin.from('notifications').insert({
        planner_name:  task.planner_name,
        designer_name: req.user.name,
        task_id:       taskId,
        message:       `▶ ${req.user.name} started "${task.task_type}" for ${task.client_name}`,
        type:          'task_started',
        is_read:       false,
        created_at:    new Date().toISOString(),
      })
    }
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST submit task with file
router.post('/submit-task', authMiddleware, uploadDesigner.single('file'), async (req, res) => {
  try {
    if (req.user.role !== 'designer') return res.status(403).json({ error: 'Access denied' })
    const { taskId, note } = req.body
    if (!taskId || !req.file) return res.status(400).json({ error: 'taskId and file required' })

    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('task_id', taskId).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })
    if (task.assigned_designer !== req.user.name) return res.status(403).json({ error: 'Not your task' })

    let driveFile = null
    try {
      const folderId = process.env.GOOGLE_DRIVE_SUBMISSIONS_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID
      const fileName = `${taskId}_${req.user.name}_${req.file.originalname}`
      driveFile = await uploadFileToDrive(req.file.buffer, fileName, req.file.mimetype, folderId, req.user.name)
    } catch (e) {
      return res.status(500).json({ error: 'Drive upload failed: ' + e.message })
    }

    await supabaseAdmin.from('tasks').update({
      status:               'Submitted',
      submitted_date:       new Date().toISOString(),
      submission_note:      note || null,
      submission_file_id:   driveFile?.id,
      submission_file_link: driveFile?.webViewLink,
      submission_file_name: driveFile?.name,
    }).eq('task_id', taskId)

    await supabaseAdmin.from('notifications').insert([
      {
        planner_name:  'admin',
        designer_name: req.user.name,
        task_id:       taskId,
        message:       `📤 ${req.user.name} submitted "${task.task_type}" for ${task.client_name} — waiting for admin review`,
        type:          'submission',
        is_read:       false,
        created_at:    new Date().toISOString(),
      },
      {
        planner_name:  task.planner_name,
        designer_name: req.user.name,
        task_id:       taskId,
        message:       `📤 ${req.user.name} submitted "${task.task_type}" for ${task.client_name}`,
        type:          'submission',
        is_read:       false,
        created_at:    new Date().toISOString(),
      },
    ])

    res.json({ success: true, drive_file: driveFile })
  } catch (err) {
    console.log('❌ DRIVE UPLOAD FULL ERROR:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET notifications
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('notifications').select('*')
      .eq('designer_name', req.user.name)
      .order('created_at', { ascending: false }).limit(50)
    await supabaseAdmin.from('notifications').update({ is_read: true })
      .eq('designer_name', req.user.name).eq('is_read', false)
    res.json({ notifications: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST login ping
router.post('/login-ping', authMiddleware, async (req, res) => {
  try {
    await supabaseAdmin.from('profiles').update({ last_login: new Date().toISOString() }).eq('id', req.user.id)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST leave request — cascade: Admin → Planner → another Planner
router.post('/leave', authMiddleware, async (req, res) => {
  try {
    const { leaveDate, reason } = req.body
    if (!leaveDate) return res.status(400).json({ error: 'Leave date required' })

    // Prefer the planner whose tasks for this designer fall on the leave date
    let taskPlannerName = null
    const { data: dateTask } = await supabaseAdmin.from('tasks').select('planner_name')
      .eq('assigned_designer', req.user.name)
      .or(`end_date.eq.${leaveDate},publish_date.eq.${leaveDate}`)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle()

    if (dateTask?.planner_name) {
      taskPlannerName = dateTask.planner_name
    } else {
      const { data: recentTask } = await supabaseAdmin.from('tasks').select('planner_name')
        .eq('assigned_designer', req.user.name)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle()
      taskPlannerName = recentTask?.planner_name || null
    }

    const approver = await getLeaveApprover(leaveDate, taskPlannerName)

    const { data, error } = await supabaseAdmin.from('leave_requests').insert({
      designer_id:   req.user.id,
      designer_name: req.user.name,
      leave_date:    leaveDate,
      reason:        reason || null,
      status:        'pending',
      requested_at:  new Date().toISOString(),
      routed_to:     approver.name,
      routed_role:   approver.role,
    }).select().single()

    if (error) throw error

    await supabaseAdmin.from('notifications').insert({
      planner_name:     approver.name,
      message:          `🏖️ ${req.user.name} requested leave for ${leaveDate}${reason ? ` — ${reason}` : ''} (routed to ${approver.role === 'admin' ? 'Admin' : approver.name})`,
      type:             'leave_request',
      is_read:          false,
      created_at:       new Date().toISOString(),
      leave_request_id: data.id,
    })

    res.json({ success: true, routed_to: approver.name, routed_role: approver.role,
      message: `Leave request sent to ${approver.role === 'admin' ? 'Admin' : approver.name}` })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET leave status (today)
router.get('/leave-status', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('leave_requests').select('*')
      .eq('designer_id', req.user.id).eq('leave_date', getISTDate()).maybeSingle()
    res.json({ status: data?.status || null, leave_data: data })
  } catch { res.json({ status: null }) }
})

// POST upload progress screenshot
router.post('/upload-progress', authMiddleware, uploadDesigner.single('screenshot'), async (req, res) => {
  try {
    if (req.user.role !== 'designer') return res.status(403).json({ error: 'Designer only' })
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const fileExt  = req.file.originalname.split('.').pop()
    const fileName = `${req.user.id}_${Date.now()}.${fileExt}`

    const { error: storageError } = await supabaseAdmin.storage
      .from('designer-progress')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true })

    if (storageError) return res.status(500).json({ error: storageError.message })

    const { data: publicUrlData } = supabaseAdmin.storage.from('designer-progress').getPublicUrl(fileName)
    const fileUrl = publicUrlData.publicUrl

    const { error: dbError } = await supabaseAdmin.from('progress_uploads').insert({
      designer_id:   req.user.id,
      designer_name: req.user.name,
      file_link:     fileUrl,
      note:          req.body.note || null,
      uploaded_at:   new Date().toISOString()
    })

    if (dbError) return res.status(500).json({ error: dbError.message })
    res.json({ success: true, file_link: fileUrl })
  } catch (err) {
    console.log('UPLOAD PROGRESS ERROR:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET today's progress uploads (designer's own)
router.get('/progress-uploads', authMiddleware, async (req, res) => {
  try {
    const today = getISTDate()
    const { data, error } = await supabaseAdmin.from('progress_uploads').select('*')
      .eq('designer_id', req.user.id)
      .gte('uploaded_at', `${today}T00:00:00`)
      .lte('uploaded_at', `${today}T23:59:59`)
      .order('uploaded_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ uploads: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router

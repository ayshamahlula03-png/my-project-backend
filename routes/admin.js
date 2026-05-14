const express    = require('express')
const router     = express.Router()
const { supabaseAdmin }    = require('../supabase')
const { authMiddleware }   = require('../middleware/auth')
const { getISTDate }       = require('../helpers/ist')
const { getLeaveApprover } = require('../helpers/leave')

const REEL_DESIGNERS = ['Divya', 'Sneha']

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

// GET all tasks
router.get('/tasks', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('tasks').select('*').order('end_date', { ascending: true })
    res.json({ tasks: data || [], today: getISTDate() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET designers with workload
router.get('/designers', authMiddleware, adminOnly, async (req, res) => {
  try {
    const today = getISTDate()
    const { data: designers } = await supabaseAdmin.from('profiles').select('*').eq('role', 'designer').order('name')
    const { data: tasks } = await supabaseAdmin.from('tasks')
      .select('assigned_designer, status, end_date').in('status', ['Pending', 'Assigned', 'In Progress'])
    const workload = {}, urgent = {}
    tasks?.forEach(t => {
      if (!t.assigned_designer) return
      workload[t.assigned_designer] = (workload[t.assigned_designer] || 0) + 1
      if (t.end_date && t.end_date <= today) urgent[t.assigned_designer] = (urgent[t.assigned_designer] || 0) + 1
    })
    res.json({
      designers: (designers || []).map(d => ({
        ...d,
        current_workload: workload[d.name] || 0,
        urgent_tasks:     urgent[d.name]   || 0,
      }))
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET planners
router.get('/planners', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('profiles').select('*').eq('role', 'planner').order('name')
    res.json({ planners: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST reassign task
router.post('/reassign', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { taskId, designerId, designerName } = req.body
    await supabaseAdmin.from('tasks').update({
      assigned_designer: designerName, assigned_designer_id: designerId, status: 'Assigned',
    }).eq('task_id', taskId)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET upload logs
router.get('/upload-logs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('sync_logs').select('*')
      .order('created_at', { ascending: false }).limit(50)
    res.json({ logs: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET leave requests routed to admin
router.get('/leave-requests', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('leave_requests').select('*')
      .eq('status', 'pending')
      .or('routed_to.eq.admin,routed_to.is.null')
      .order('requested_at', { ascending: false })
    res.json({ leave_requests: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST handle leave (approve/reject)
router.post('/handle-leave', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { requestId, action } = req.body
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid' })

    const { data: leave } = await supabaseAdmin.from('leave_requests').select('*').eq('id', requestId).single()
    if (!leave) return res.status(404).json({ error: 'Not found' })

    await supabaseAdmin.from('leave_requests').update({
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: req.user.name, reviewed_at: new Date().toISOString(),
    }).eq('id', requestId)

    if (action === 'approve') {
      // Planner leave — no task reassignment needed
      if (leave.requester_role === 'planner') {
        await supabaseAdmin.from('notifications').insert({
          planner_name: leave.designer_name,
          message:      `✅ Your leave for ${leave.leave_date} has been approved by Admin.`,
          is_read: false, created_at: new Date().toISOString(),
        })
        return res.json({ success: true })
      }

      // Designer leave — reassign tasks
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
              message:       `🔄 "${task.task_type}" for ${task.client_name} reassigned to you (${leave.designer_name} on leave)`,
              is_read: false, created_at: new Date().toISOString(),
            })
          }
        }
      }
      await supabaseAdmin.from('notifications').insert({
        designer_name: leave.designer_name,
        message:       `✅ Leave approved for ${leave.leave_date}. ${tasks?.length || 0} tasks reassigned.`,
        is_read: false, created_at: new Date().toISOString(),
      })
    } else {
      const isPlanner = leave.requester_role === 'planner'
      await supabaseAdmin.from('notifications').insert({
        ...(isPlanner ? { planner_name: leave.designer_name } : { designer_name: leave.designer_name }),
        message:    `❌ Leave for ${leave.leave_date} not approved. Contact admin.`,
        is_read: false, created_at: new Date().toISOString(),
      })
    }
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST admin marks own leave — also re-routes existing pending requests to planners
router.post('/mark-leave', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { date, message } = req.body
    if (!date) return res.status(400).json({ error: 'Date required' })

    const { error } = await supabaseAdmin.from('admin_leaves').upsert(
      { date, message: message || null, created_at: new Date().toISOString() },
      { onConflict: 'date' }
    )
    if (error) throw error

    // Re-route any pending designer leave requests for this date to planners
    const { data: pending } = await supabaseAdmin.from('leave_requests').select('*')
      .eq('leave_date', date).eq('status', 'pending')
      .or('requester_role.is.null,requester_role.eq.designer')
      .eq('routed_role', 'admin')

    let rerouted = 0
    for (const req2 of (pending || [])) {
      let taskPlannerName = null
      const { data: dateTask } = await supabaseAdmin.from('tasks').select('planner_name')
        .eq('assigned_designer', req2.designer_name)
        .or(`end_date.eq.${date},publish_date.eq.${date}`)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()

      if (dateTask?.planner_name) {
        taskPlannerName = dateTask.planner_name
      } else {
        const { data: recentTask } = await supabaseAdmin.from('tasks').select('planner_name')
          .eq('assigned_designer', req2.designer_name)
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        taskPlannerName = recentTask?.planner_name || null
      }

      const approver = await getLeaveApprover(date, taskPlannerName)
      if (approver.role === 'admin' && approver.name === req2.routed_to) continue

      await supabaseAdmin.from('leave_requests').update({
        routed_to: approver.name, routed_role: approver.role,
      }).eq('id', req2.id)

      await supabaseAdmin.from('notifications').insert({
        planner_name:     approver.name,
        message:          `🏖️ ${req2.designer_name} requested leave for ${date}${req2.reason ? ` — ${req2.reason}` : ''} (re-routed from Admin)`,
        type:             'leave_request',
        is_read:          false,
        created_at:       new Date().toISOString(),
        leave_request_id: req2.id,
      })
      rerouted++
    }

    res.json({ success: true, rerouted })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET admin's own leave list
router.get('/leaves', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('admin_leaves').select('*').order('date', { ascending: false })
    res.json({ leaves: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE admin's own leave
router.delete('/leaves/:date', authMiddleware, adminOnly, async (req, res) => {
  try {
    await supabaseAdmin.from('admin_leaves').delete().eq('date', req.params.date)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET/POST manager routes (shared planner+admin)
router.get('/manager/pending-submissions', authMiddleware, async (req, res) => {
  try {
    if (!['planner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' })
    const { data } = await supabaseAdmin.from('tasks').select('*')
      .eq('status', 'Submitted').eq('end_date', getISTDate())
      .order('submitted_date', { ascending: false })
    res.json({ submissions: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/manager/tasks', authMiddleware, async (req, res) => {
  try {
    if (!['planner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' })
    const today = getISTDate()
    const { data } = await supabaseAdmin.from('tasks').select('*')
      .eq('end_date', today).order('end_date', { ascending: true })
    res.json({ tasks: data || [], today })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/manager/review-submission', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { taskId, action, feedback } = req.body
    if (!taskId || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid params' })

    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('task_id', taskId).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const newStatus = action === 'approve' ? 'Completed' : 'Rejected'
    await supabaseAdmin.from('tasks').update({
      status:           newStatus,
      completed_date:   action === 'approve' ? new Date().toISOString() : null,
      reviewed_by:      req.user.name,
      reviewed_date:    new Date().toISOString(),
      manager_note:     feedback || null,
      rejection_reason: action === 'reject' ? (feedback || 'Please revise and resubmit') : null,
    }).eq('task_id', taskId)

    await supabaseAdmin.from('notifications').insert([
      {
        designer_name: task.assigned_designer,
        planner_name:  task.planner_name,
        task_id:       taskId,
        message: action === 'approve'
          ? `✅ "${task.task_type}" for ${task.client_name} — Approved by Admin!`
          : `❌ "${task.task_type}" for ${task.client_name} — Rejected: ${feedback || 'Please resubmit'}`,
        type: action === 'approve' ? 'approval' : 'rejection',
        is_read: false, created_at: new Date().toISOString(),
      },
      {
        planner_name: task.planner_name,
        task_id:      taskId,
        message: action === 'approve'
          ? `✅ Admin approved "${task.task_type}" for ${task.client_name}`
          : `❌ Admin rejected "${task.task_type}" for ${task.client_name}`,
        type: action === 'approve' ? 'approval' : 'rejection',
        is_read: false, created_at: new Date().toISOString(),
      },
    ])

    res.json({ success: true, new_status: newStatus })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/manager/notifications', authMiddleware, async (req, res) => {
  try {
    if (!['planner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' })
    const { data } = await supabaseAdmin.from('notifications').select('*')
      .or(`planner_name.eq.${req.user.name},planner_name.eq.admin`)
      .order('created_at', { ascending: false }).limit(50)
    res.json({ notifications: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
